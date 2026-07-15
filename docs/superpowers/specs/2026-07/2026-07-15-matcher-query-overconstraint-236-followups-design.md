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

**A2. Leading-run dedup (replaces global fold-dedup).** This is the core change:
- Emit brewery tokens first (deduped among themselves by fold, dropping `BREWERY_NOISE`).
- For the name, strip **only the leading contiguous run** of tokens whose fold matches a brewery
  token or `BREWERY_NOISE`. Stop at the first name token that is **not** in the brewery set; keep all
  remaining name tokens verbatim — no further dedup of the name against the brewery.
- Identical-token AND terms that survive (e.g. `Road` in both brewery and mid-name) are harmless:
  Algolia treats a repeated identical term as the single term.

Worked cases:
- #126 `Track Brewing Co` / `Track Brewing Company Taking Shape`: leading run `Track`(brewery),
  `Brewing`(noise), `Company`(noise), then `Taking`(not in brewery → stop) → name kept `Taking Shape`
  → query `Track Taking Shape`. ✓ (preserved)
- #270 31133 `Browar Magic Road` / `x Upside Down: Road to Upside`: lone `x` dropped; name leading
  token `Upside` not in brewery → stop immediately → no name tokens dropped → `Road`/`Upside`
  preserved. ✓ (fixed)

**A3. Fallback** (`out.length ? … : (cleanName || cleanBrewery || name.trim())`) unchanged.

### Part B — head-retry in `lookupBeer` (`src/domain/untappd-lookup.ts`) (#271)

In the per-part loop, after `results = await args.search.search(query)`:

- If `results.length === 0` **and** the name has a trimmable tail, run **one** additional search with
  the head only, and adopt its results if non-empty.
- **Tail delimiter**: first occurrence of `, ` (comma), ` #\d` (hash-number), or ` - `/` — ` (dash).
  `head` = the name substring up to (excluding) that delimiter.
- **Gate**: retry only when `results === 0` and `headQuery !== query` (a tail actually existed and
  was removed). This makes it a strict fallback — if the full query already returned candidates, no
  retry happens; if the head query also returns 0, nothing changes.
- **Safety invariant (documented in code)**: the head query only widens the candidate **search**.
  All downstream match gates — brewery gate, `nameKeys`, `fuzzyTargets` — continue to use the **full
  original name**. A candidate surfaced only by the head must still match the full name to be
  returned, so head-retry cannot introduce a false match.
- **Cost / traffic**: +1 HTTP search on the subset of orphans that (a) returned 0 and (b) have a
  tail. It goes through `args.search`, so it inherits the Untappd circuit breaker, Webshare proxy,
  and backoff automatically. `triedUrls` records the head query URL too (for `enrich_failures`).

### Part C — Validation

1. **Unit tests (Vitest), required by CLAUDE.md.**
   - `normalize.test.ts` for `cleanSearchQuery`: 31133 (`Road`/`Upside` preserved), 31135 (leading
     `x` dropped, rest intact), #126 regression (`Track Taking Shape`), and a plain non-collab case.
   - New lookup test for head-retry: mock `BeerSearch` returning `[]` for the full query and a
     candidate for the head; assert the second search fires with the head; assert that a head
     candidate which does **not** match the full name yields `not_found` (safety invariant); assert
     no retry when the full query already returns results.
2. **Prod dry-run replay (`./tmp/`, read-only).** Script reads `matcher_bug` rows from
   `enrich_failures` on the read-only prod DB, runs each through old vs new `cleanSearchQuery`, and
   reports: count now producing a non-empty / changed query, per-row before→after diffs, and any row
   whose query got **shorter in a suspicious way** (regression watch). Manual review of the diff
   before merge. (Head-retry itself is not replayed against live Untappd; its behaviour is covered by
   the mocked unit test.)

## Risks

- **A2 heuristic edge**: a beer whose name legitimately *starts* with a brewery token loses that
  leading token (same as current behaviour — the brewery already contributes it). Acceptable; the
  dry-run diff surfaces any surprising shortening.
- **B dash delimiter**: ` - ` can appear in real names (`X - Imperial Edition`). Safe here because
  retry only fires after the full query returned 0, and matching still gates on the full name.
- **Traffic**: head-retry adds Untappd calls on a failing subset. Bounded; inherits breaker/proxy.
  Validate observed call volume against the breaker budget after deploy (per hot-loop discipline).

## Out of scope / follow-ups

- Collab-partner identification/removal from names (residual #270/#271 over-constraint).
- Broader query-noise classes tracked in #229 / #254.
