# Matcher: fix over-constrained Untappd/Algolia queries (#270 + #271)

- **Date**: 2026-07-15
- **Issues**: #270 (COLLAB_SEP over-split + fold-dedup destroys name tokens), #271 (bare adjunct/flavour tails over-constrain the search) — both follow-ups from #236.
- **Files**: `src/domain/normalize.ts`, `src/domain/untappd-lookup.ts`, `src/domain/normalize.test.ts`, new lookup test, `./tmp/` dry-run script.

## Problem

Untappd search runs through Algolia, which **ANDs every term** in the query. Any spurious
token zeroes the result set. Two distinct classes of spurious tokens survive today:

### #270 — destructive split + dedup in `cleanSearchQuery`
`cleanSearchQuery(brewery, name)` collapses `COLLAB_SEP` (`/`, ` x `, ` & `) on the **combined**
`"${cleanBrewery} ${cleanName}"` string, then fold-dedups every token globally. Two intertwined
defects:

- **(a) combined-split.** A beer *name* that begins with or contains ` x ` (a shop "collab-with"
  artifact) is split as if it were a collab **brewery** separator. The ` x ` split belongs to the
  brewery field only (already handled upstream by `brewerySearchParts`).
- **(b) global fold-dedup.** A name token is dropped whenever its fold repeats *any* brewery token,
  even when that token is part of the core beer name (mid-name, not a leading brewery-restatement).

Evidence (2026-07-11 code):
- **31133** brewery `Browar Magic Road` / name `x Upside Down: Road to Upside` → query
  `Magic Road Upside Down: to` — `Road` and `Upside` dropped as dup-of-brewery, the beer name is
  destroyed (candidate `Magic Road — Road To Upside` never found).
- **31135** `Nepo Brewing` / `x Uncharted: Top-Tier` → `Nepo Uncharted: Top-Tier` (survives, but the
  leading `x` handling is incidental).

The global dedup exists for #126 (a name that restates the brewery: `Track Brewing Co` /
`Track Brewing Company Taking Shape`). The fix must preserve #126 while stopping the #270 destruction.

### #271 — bare adjunct/flavour tails
`stripSearchNoise` only drops adjunct lists inside `[...]`/`(...)`. When the shop writes the flavour
tail as **bare** text after a comma / `#N` / dash, every descriptor becomes an AND term and zeroes
the search. The #239 fix deliberately left these alone — a naive strip risks truncating legitimate
names (`X - Imperial Edition`).

Evidence:
- **31170** `Owocowa Fantazja #1 - Pastry Sour z Guavą, Mango, Maliną, Gruszką`
- **30780** `Jungle boogie mango ananas`
- **30109** `WA Gossip Cervejaria Escafandrista 12`

## Non-goals

- We do **not** try to identify and drop the collab *partner* brewery from a name (`Upside Down` in
  31133). That residual over-constraint is a separate, harder class; #270 here only stops the query
  from being *destroyed* (name tokens preserved) and fixes the mis-split.
- We do **not** add a general heuristic that strips bare tails unconditionally (the risky path the
  issue warns against). #271 is handled strictly as a fallback that cannot worsen a working match.

## Design

### Part A — `cleanSearchQuery` (`src/domain/normalize.ts`), deterministic (#270)

**A1. Connector handling.** Split the brewery and the name **separately** instead of collapsing
`COLLAB_SEP` on the combined string. Instead:
- Brewery arg is already a single collab part (`brewerySearchParts` split upstream); still split it
  on `COLLAB_SEP` defensively (detaches glued junk like `collab/`), then whitespace, dropping
  `BREWERY_NOISE`.
- Name: tokenize on whitespace, replace `/` with a space (unambiguous collab slash), and drop
  **lone connector tokens** whose fold is `x` or `&`. The name is **never** split on ` x `.
- Result: `x Upside Down: Road to Upside` is no longer cut at ` x ` — only the lone leading `x`
  disappears; `Upside Down: Road to Upside` survives into the query.

**A2. Edge-run dedup (replaces global fold-dedup).** This is the core change. Define
`breweryFolds` = the folds of brewery **brand** tokens (brewery tokens that survive `BREWERY_NOISE`
removal). Build the name token list from A1, then:
- Drop any name token whose fold is in `BREWERY_NOISE` **anywhere** (pure noise: `collab`, `brewing`,
  `co`, …) and any token whose fold is empty (bare punctuation like `–`).
- From the remaining name tokens, strip the **leading** contiguous run and the **trailing**
  contiguous run whose fold is in `breweryFolds`. Stop each run at the first token not in
  `breweryFolds`. **Keep every mid-name token**, even if it duplicates a brewery brand token.
- Emit brewery brand tokens (deduped among themselves by fold), then the surviving name tokens, in
  original raw form. Identical AND terms that survive (e.g. `Road` in both brewery and mid-name) are
  harmless — Algolia treats a repeated identical term as the single term.

Why leading **and** trailing (not leading-only): existing #155 test relies on trailing removal —
`TRZECH KUMPLI Brewery` / `Porter Bałtycki Żytnio-Orkiszowy Trzech Kumpli` → the trailing
`Trzech Kumpli` must drop, yielding `TRZECH KUMPLI Porter Bałtycki Żytnio-Orkiszowy`.

Worked cases:
- #126 `Track Brewing Co` / `Track Brewing Company Taking Shape`: noise drops `Brewing`,`Company`;
  leading run `Track`(brand) → drop, `Taking`(not brand → stop) → name `Taking Shape` →
  query `TRACK Taking Shape`. ✓ (preserved)
- #155 `TRZECH KUMPLI Brewery` / `Porter Bałtycki Żytnio-Orkiszowy Trzech Kumpli`: trailing run
  `Kumpli`,`Trzech` → drop, `Żytnio-Orkiszowy`(not brand → stop) → `TRZECH KUMPLI Porter Bałtycki
  Żytnio-Orkiszowy`. ✓ (preserved)
- #270 31133 `Browar Magic Road` / `x Upside Down: Road to Upside`: lone `x` dropped; brand folds
  `{magic, road}`; leading `Upside`(not brand → stop), trailing `Upside`(not brand → stop), so no
  edge trim; mid-name `Road` kept → name `Upside Down: Road to Upside` → `Road`/`Upside` preserved. ✓ (fixed)

**A3. Fallback** (`out.length ? … : (cleanName || cleanBrewery || name.trim())`) unchanged.

### Part B — head-retry in `lookupBeer` (`src/domain/untappd-lookup.ts`) (#271, NARROWED)

> **Design-defect correction (2026-07-15).** The original "retry the search but keep matching on the
> full name" idea does not work: the matcher (`fuzzyTargets`/`nameKeys`/coverage) requires **every**
> input-name token to be covered by the candidate. When the shop name carries a long flavour tail
> (`Space Pop I - Blackberry, Lemon, Marshmallow`) and the Untappd beer is the short head
> (`Space Pop I`), a candidate found via a head-only search is still **rejected** by the full-name
> gates. So the retry must **match on the head too** — which reintroduces false-match risk. Two of the
> three issue examples (30780 `Jungle boogie mango ananas`, 30109 `WA Gossip …`) have **no delimiter**
> and would need a token-cap, which is riskier still. Decision: implement only the **safe delimiter-list
> slice** now; defer bare-space tails, token-cap, and the ` - ` dash to a follow-up.

Implemented behaviour — a single, whole-lookup head-retry gated to fire only when the search returned
**nothing at all**:

- After the per-part loop, if `seenCandidates.length === 0` (every part's search returned zero
  results — a genuine query-zeroing, not a matcher rejection) **and** the name has a **delimiter-list
  tail**, recurse `lookupBeer` once with `name = head`.
- **Tail delimiter (narrowed)**: the first ` #\d` (hash-number) or `,` (comma). `head` = the name
  substring before it, trimmed. **Excluded**: ` - `/` — ` dash (often a real sub-edition) and any
  token-cap (would truncate legitimate multiword names). If no such delimiter, no retry.
- **Matching uses the head**: recursion re-runs the whole pipeline with the head as the name, so the
  brewery gate + name gates evaluate the head — this is what lets the short Untappd name match.
- **Guards**: single retry only (private `headRetried` flag threaded through recursion — infinite-loop
  guard); `head` must be non-empty and `!== name`; brewery gate still applies unchanged in the retry.
- **Outcome merge**: on retry `not_found`, merge `searchUrls`/`candidates` from both passes for
  `enrich_failures` debugging; on `matched`/`blocked`/`transient`, return the retry outcome directly.
- **Cost / traffic**: one extra whole-lookup pass on the subset of orphans that surfaced zero
  candidates *and* have a delimiter tail. All searches go through `args.search`, inheriting the Untappd
  circuit breaker, Webshare proxy, and backoff automatically.

### Part C — Validation

1. **Unit tests (Vitest), required by CLAUDE.md.**
   - `normalize.test.ts` for `cleanSearchQuery`: 31133 (`Road`/`Upside` preserved), 31135 (leading
     `x` dropped, rest intact), #126 regression (`Track Taking Shape`), and a plain non-collab case.
   - New lookup test for head-retry: mock `BeerSearch` returning `[]` for the full query and a
     matching candidate for the head query (`31170`-style `Owocowa Fantazja #1 - …` → head
     `Owocowa Fantazja`); assert the retry fires and returns `matched`. Assert **no** retry when the
     full query already returned candidates (even if unmatched). Assert **no** retry for a
     dash-only tail (`X - Imperial Edition`). Assert single-retry guard (no infinite loop).
2. **Prod dry-run replay (`./tmp/`, read-only).** Script reads `matcher_bug` rows from
   `enrich_failures` on the read-only prod DB, runs each through old vs new `cleanSearchQuery`, and
   reports: count now producing a non-empty / changed query, per-row before→after diffs, and any row
   whose query got **shorter in a suspicious way** (regression watch). Manual review of the diff
   before merge. (Head-retry itself is not replayed against live Untappd; its behaviour is covered by
   the mocked unit test.)

## Risks

- **A2 heuristic edge**: a beer whose name legitimately *starts or ends* with a brewery brand token
  loses that edge token (same as current behaviour — the brewery already contributes it). Acceptable;
  the dry-run diff surfaces any surprising shortening.
- **B false-match risk**: matching on the head is more permissive, so a real product differentiator
  in the tail could let the head match a different beer of the same brewery. Mitigated by: gating on
  **zero candidates** (search found literally nothing), keeping the brewery gate, excluding the ` - `
  dash and token-cap, and restricting to `,`/`#N` flavour-list tails. Residual risk accepted for the
  narrowed slice; watch the dry-run diff and post-deploy match quality.
- **Traffic**: head-retry adds one whole-lookup pass on a failing subset. Bounded; inherits
  breaker/proxy. Validate observed call volume against the breaker budget after deploy (hot-loop
  discipline).

## Out of scope / follow-ups

- **#271 remainder (deferred to its own cycle)**: bare space-separated adjunct tails (30780
  `Jungle boogie mango ananas`, 30109 `WA Gossip …`), the token-cap strategy, and the ` - ` dash
  delimiter. These need head-matching with stronger false-match guards — a proper design, not a
  bolt-on here.
- Collab-partner identification/removal from names (residual #270/#271 over-constraint).
- Broader query-noise classes tracked in #229 / #254.
