# Design: web-fallback spend guard + per-call observability (#351)

**Date:** 2026-07-27
**Issue:** #351 — *enrich: stop spending web-search budget on parser_bug/not_on_untappd orphans + log every fallback call*
**Follows:** `2026-07-26-brave-websearch-swap-design.md` (#139 / PR #348, live 2026-07-26)
**Prerequisite for:** #349 (Algolia hydration by bid + style corroborator + ambiguity guard)
**Status:** design approved, ready for planning

## Problem

The Brave web fallback went live on 2026-07-26. Day-1 production numbers (posted on #349):
30/30 daily units spent in two cron runs, 8 successes (2 matches + 6 merges), 22 misses.
Two problems surfaced, both independent of the gate redesign in #349.

### 1. The metered path inherits the free path's eligibility filter

`listLookupCandidates` (`src/storage/beers.ts:156`) excludes only `review_class = 'wontfix'`
and `retired_at IS NOT NULL`. That is correct for a free Algolia retry — a shipped matcher
fix should rescue those orphans on the next cron tick — but `runWebFallback` sits behind the
same filter, and every call costs a metered request plus a 30-day per-beer cooldown.

Of the 22 misses on day 1, ~10 could never have matched: 5 non-beer rows (kvass ×2, wine
11.5%, cider, 40% nalewka), 4 parser garble (`Cookie Monster Ice Destilated N/D°·13%`,
`Bajlando za mango 16°·5,8%%`, `SPOxBeer&Bones Saison`, `Green IQ <0,5%`), 1 already triaged
`not_on_untappd`.

`parser_bug` means the query string itself is wrong — a web search of the same wrong string
cannot help, and it burns the beer's 30-day cooldown, so the retry after the parser fix ships
is delayed by a month. `not_on_untappd` means triage already established the page does not exist.

There is a second, larger hole: **`/enrich/result` never passes through `listLookupCandidates`
at all.** The relay path goes straight to `lookupWithFallback` → `runWebFallback`, so on that
path even `wontfix` and `retired_at` are unfiltered — a shop page scanned in the extension can
spend a metered unit on a beer the cron has permanently given up on.

### 2. Successful fallback calls are invisible

`createBraveResolver` logs only non-200s and exceptions, so 30 successful calls produced zero
log lines. For a miss there is no way to tell "Brave returned nothing" from "`gateWebCandidate`
rejected a correct candidate" — the exact split #349 needs to size its scope. Day-1 merge
attribution had to be reconstructed arithmetically (units spent minus surviving `web_tried_at`
stamps), because merged orphan rows are deleted.

Compounding it, `applyLookupOutcome` returns `not_found` for a merge
(`src/domain/lookup-outcome.ts:52`), so the runs logged `matched:1` / `matched:2` for 8 real
successes. Worse than a cosmetic counter: on the relay path the same code answers the extension
`{status:'not_found'}` while holding the canonical bid, so a user scanning a shop page sees no
badge on a beer that *is* on Untappd.

### What day 1 already tells us about #349

The pre-deploy dry run listed 5 cases as "correct candidate present, blocked **only** by a null
ABV": 289, 30071, 30077, 31198, 31435. In production **4 of those 5 succeeded** (289, 30071,
30077 merged; 31435 matched) — the dry run did not hydrate, while `hydrateAbv` (Algolia by name)
does fill the candidate side in the live path. So hydration-by-bid in #349 is an incremental
improvement, not the unlock; the flagship 29404 is blocked by a **null input ABV on our side**,
which only the style corroborator can address. Worth re-checking against real rejection stages
once this issue ships.

## Non-goals

- Non-beer rows (kvass, wine, cider, spirits). They carry no distinguishing `review_class` and
  need a separate signal; out of scope here.
- The daily digest. `enrichMatched24h` counts `beers` rows (`src/storage/stats.ts:89`) and a
  merged orphan is deleted, so merges can never appear there without a new counter store —
  not worth it for one digest line.
- `/enrich/candidates` eligibility. Client-side Untappd search is free and can still rescue a
  `parser_bug` beer; only the metered path is tightened.
- Anything in `extension/**`. The diff is zero there, so no version bump and no
  `docs/extension-install-uk.md` change.

## Design

Three independent pieces. No migration, no env change.

### 1. Eligibility predicate — `isWebFallbackBlocked`

New helper in `src/storage/enrich_failures.ts`, beside the existing `isWontfix` (already
consumed by `/enrich/candidates`, `src/api/routes/enrich.ts:95` — same shape, proven precedent):

```ts
isWebFallbackBlocked(db, beerId): boolean
// true when an enrich_failures row exists with
//   review_class IN ('wontfix','parser_bug','not_on_untappd')
//   OR retired_at IS NOT NULL
```

Called **first** in `runWebFallback` — before the cooldown read and before
`tryConsumeWebSearchQuota`. Returns `null` with no quota spent and **no `web_tried_at` stamp**:
a skip must be free, otherwise a `parser_bug` beer collects a 30-day cooldown and waits a month
after the parser fix instead of retrying on the next cron tick.

`matcher_bug` and untriaged (`NULL`) rows stay eligible — that is the class the fallback exists
for. Placing the predicate inside `runWebFallback` covers the cron and the relay path with one
rule and closes the `/enrich/result` hole described above.

### 2. Stage-aware gate core + one log line per spent call

`runWebFallback` currently **duplicates** the gate inline (so it can hydrate ABV lazily) while
the exported `gateWebCandidate` lives separately — the drift risk #349 planned to clean up.
Making the loop call `gateWebCandidate` would destroy the information the log needs, because it
returns a bare boolean. Instead, extract the shared core so it returns a *reason*:

```ts
// exported from src/domain/web-fallback.ts for direct testing
evaluateCandidate(input, cand): 'accept' | 'reject:brewery' | 'reject:name-token' | 'needs-abv'
```

Stages 1–2 need no hydration. `'needs-abv'` is exactly the point where the loop calls
`hydrateAbv` and then decides `accept` / `reject:abv`. `gateWebCandidate` becomes a thin wrapper
over the same core for an already-hydrated candidate, so its semantics and its 6 existing tests
are unchanged. The duplication disappears and the log gets its stage for free.

This overlaps #349's "fold in while we are here" bullet about the duplicated gate; that bullet
should be struck from #349 once this ships.

One `log.info` per **spent** call in `runWebFallback`, `msg: 'web-fallback call'`:

| field | meaning |
| --- | --- |
| `beerId`, `brewery`, `name` | what we searched for |
| `results` | candidates returned by `parseBraveResponse` |
| `verdict` | `matched` \| `no-candidates` \| `rejected` |
| `matchedBid` | present when `verdict === 'matched'` |
| `rejected[]` | `{ bid, beer_name, brewery_name, stage, inputAbv, candAbv }` |

`stage` is the `evaluateCandidate` reason. The `reject:abv` rows together with the
`inputAbv`/`candAbv` pair are the number #349 exists for: they show directly how many correct
candidates a null ABV costs us, and whether hydration-by-bid fixes it.

`info` rather than `debug` because production runs at level 30 and the volume is bounded by the
daily cap (≤30 lines/day).

Skips — `review-class`, `cooldown`, `quota` — are `log.debug` with
`msg: 'web-fallback skipped'` and a `reason` field. They repeat every run for the same beers, and
none of them cost money; a quota exhaustion is already visible in `web_search_quota`.

**Known limit:** the loop returns on the first accepted candidate, so only *evaluated* candidates
are logged. Evaluating the rest for statistics would cost an extra Algolia hydration per
candidate. The consequence is that #349's ambiguity question ("how many candidates would have
cleared corroboration") is not answered by this log — it is measured inside #349 when the gate is
rewritten.

### 3. Merge as a first-class outcome

- `EnrichOutcomeKind` gains `'merged'`. `applyLookupOutcome` returns it instead of `'not_found'`
  when the merge actually happened; if the canonical row is somehow absent on a UNIQUE clash,
  the result stays `'not_found'`.
- `EnrichOrphansResult` gains `merged: number` (and in `ZERO_RESULT`). `result[kind]++` then works
  unchanged and the run summary reports the real figure.
- `/enrich/result`: the condition becomes
  `(kind === 'matched' || kind === 'merged') && outcome.kind === 'matched'` →
  `{status:'matched', untappd_id: outcome.result.bid, rating_global: outcome.result.global_rating}`.
  The bid is already in `outcome.result`; nothing needs plumbing through `applyLookupOutcome`.

The extension's `status` union (`extension/src/api/types.ts:48`) already handles
`matched` + `untappd_id`, so **old extension versions benefit without an update** — they simply
start receiving a bid where they previously got nothing. `'merged'` never crosses the API
boundary.

Deliberate YAGNI: `rating_global` comes from `outcome.result`, not from the canonical row. It may
be `null` (Brave supplies no rating), but the extension already handles that
(`res.rating_global ?? null`, `extension/src/content/enrich.ts:52`) and `refresh-tap-ratings`
backfills it on the next run. Fetching the canonical row for one field is not worth it.

## Testing (Vitest)

- `isWebFallbackBlocked`: each blocking class, `retired_at`, missing row, and
  `matcher_bug`/`NULL` → allowed.
- `runWebFallback` with a blocked class: resolver not called, quota not consumed, no stamp
  written, one `debug` line emitted.
- Log content with a fake logger: `results`, `verdict`, and the stages in `rejected[]` — including
  a `reject:abv` case with `inputAbv: null`.
- `evaluateCandidate` stage mapping; the 6 existing `gateWebCandidate` tests must stay green
  without edits.
- `applyLookupOutcome` returns `'merged'`; the `enrich-orphans` counter increments; the route
  returns `matched` + bid on a merge.

## Rollout

Deploy; nothing to enable. After 2–3 days, pull the rejection-stage histogram from the journal
and post it to #349 — that is the input the gate redesign is waiting on.

`spec.md` is updated in the same PR, in two places inside ch. 4 (*User Flows / Commands*): the
**«Web-фолбек на 0 кандидатів (#139)»** block (~line 805) gains the eligibility predicate and the
per-call log, and the **`POST /enrich/candidates` / `POST /enrich/result`** block (~line 834)
records that a merge now answers `matched` with the canonical bid.
