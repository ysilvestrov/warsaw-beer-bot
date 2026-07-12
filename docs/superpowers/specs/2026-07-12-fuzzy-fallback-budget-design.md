# Design: bound fuzzy-fallback CPU per request (#279)

## Problem

When an input beer has no brewery-bucket candidates, `matchPrepared`
(`src/domain/matcher.ts:406-420`) falls back to a fast-fuzzy search over the **entire
catalog** (`prepared.fullSearcher()`). Measured on prod data (30,869 beers, 2026-07-11):
**~89 ms per fallback item**, even with the searcher already built (#277 removed the
build cost but not the per-item search cost).

`MatchBody` allows up to 200 beers per request (`src/api/routes/match.ts:20`), and the
endpoint is optional-auth. A page whose adapter garbles brewery names (#255), a shop full
of beers not in the catalog, or junk input from an anonymous caller makes most items miss
the exact path and the brewery bucket → 200 × 89 ms ≈ **18 s of fuzzy CPU in a single
request** on the shared bot/API event loop. `matchBeerList` yields between items so the
process stays responsive, but the CPU is still spent and concurrent users queue behind it.

The full-catalog fallback is also rarely productive for genuinely unknown beers: it seldom
clears the 0.75 fuzzy threshold plus the `nameTokensDiverge` divergence guard, so most of
that CPU produces `matched_beer: null` anyway — the same result the item would get with no
fallback at all.

## Goal

Cap the number of items per request allowed to hit `fullSearcher()`, and thread a small
stats object through the batch so we can observe the fallback's real hit-rate in prod (and
confirm whether the cap is ever reached).

- **Budget** gates the full-catalog path only. Brewery-bucket fuzzy (`searcherFor(pool)`)
  stays unlimited — its pool is small (cheap) and it is the productive path.
- Items beyond the budget return `matched_beer: null` (stay ⚪ in the extension, whose
  per-beer client cache means this matches their usual outcome).
- No behavior change for the exact path or for the brewery-bucketed fuzzy path.

Out of scope (separate issues): token-index prefilter of `fullSearcher` input (#279 option
2), `refreshOntap`'s in-loop rebuild (#278), `worker_threads` (#84).

## Design

### 1. Budget + stats object (`matcher.ts`)

One mutable object created per request, shared across all items in the batch:

```ts
export const FULL_FALLBACK_BUDGET = 20;

export interface FallbackBudget {
  remaining: number;      // full-catalog fallbacks still allowed (starts at limit)
  attempts: number;       // items that reached the full-catalog path
  hits: number;           // of those, produced a non-null match
  budgetSkipped: number;  // items denied full search because budget was exhausted
}

export function createFallbackBudget(limit = FULL_FALLBACK_BUDGET): FallbackBudget;
```

With the default limit, worst-case fuzzy CPU per request drops from ~18 s (200 × 89 ms) to
~1.8 s (20 × 89 ms).

### 2. `matchPrepared(input, prepared, budget?)`

Split the currently-unified fuzzy branch so the empty-pool path is gated. Today:

```ts
const pool = breweryMatches;
const searcher = pool.length ? prepared.searcherFor(pool) : prepared.fullSearcher();
// ... single search + divergence guard ...
```

becomes:

- **`pool.length > 0`** → `searcherFor(pool)`, unchanged, ungated.
- **empty pool** → full-catalog path:
  - `budget.attempts++`
  - if `budget.remaining <= 0` → `budget.budgetSkipped++`, `return null`
  - else `budget.remaining--`, run `fullSearcher()`; on a non-null match `budget.hits++`.

`budget` is **optional**. When absent — the single-beer `matchBeer` back-compat entry point
and existing unit tests — the full fallback runs ungated exactly as today. No behavior
change for that caller.

The divergence guard (`nameTokensDiverge`) and threshold are unchanged; a "hit" is simply a
non-null fuzzy result returned from the full-catalog path.

### 3. `matchBeerList` (`match-list.ts`)

Owns the budget lifecycle: creates one `createFallbackBudget()` per call (= per request),
passes it to every `matchPrepared`, and returns it alongside results. Return type changes:

```ts
// before: Promise<MatchListResult[]>
// after:
Promise<{ results: MatchListResult[]; fallback: FallbackBudget }>
```

### 4. `match.ts` route

After the batch, log one structured `info` line per request:

```ts
log.info(
  { items: beers.length, fullFallback: { attempts, hits, budgetSkipped } },
  'match fallback stats',
);
```

`budgetSkipped > 0` flags any request that actually hit the cap; `hits / attempts` gives
the productivity ratio we wanted to measure — readable straight from journalctl, no separate
measurement pass. Low request volume makes `info` cheap.

## Testing (Vitest, TDD)

- **`matcher.test.ts`**
  - Exhausted budget makes a would-be full fallback return `null` and increments
    `budgetSkipped`; `remaining` is not driven negative.
  - `attempts` counts every item reaching the full path; `hits` counts only non-null full
    matches; the brewery-bucket path touches none of the counters.
  - `budget`-absent call preserves current ungated behavior.
- **`match-list.test.ts`**
  - One budget is shared across all items in a batch (Nth full fallback past the limit is
    skipped) and returned in the new `{ results, fallback }` shape.
- **`match.test.ts`**
  - Route wires the new return shape through and still returns `{ results }`; existing
    assertions updated for the changed `matchBeerList` signature.

## Spec + docs

- `spec.md`: add a short note to the "Brewery-gate як first-token індекс (продуктивність)"
  section (§ around line 701) that the full-catalog fuzzy fallback is bounded per request
  (`FULL_FALLBACK_BUDGET`), items beyond it return `matched_beer: null`.
- No extension impact → no `docs/extension-install-uk.md` change.

## Planned review (≈ 1 week after deploy, ~2026-07-19)

The `info` stats are instrumentation with a decision attached, not fire-and-forget. About a
week after this ships, review the aggregated prod logs and decide:

- Pull `match fallback stats` lines from journalctl (UTC) since deploy and aggregate
  `attempts`, `hits`, `budgetSkipped` across requests.
- **Hit-rate (`hits / attempts`)** — if the full-catalog fallback is essentially never
  productive (near-zero), consider lowering `FULL_FALLBACK_BUDGET` further or dropping the
  fallback entirely. If it is meaningfully productive, keep or raise the budget.
- **`budgetSkipped`** — how often, and on which requests, the cap is actually hit. If it is
  effectively never reached, the current limit is comfortably safe. If it is hit often on
  legitimate (non-garbage) input, that argues for option 2 (token-index prefilter) so those
  items get a cheap full search instead of being dropped.

Outcome: either close #279 as sufficient, adjust the constant, or open a follow-up for the
token-prefilter. Track this as a checkbox on the #279 PR / issue so it is not forgotten.

## Related

#277 (catalog cache — removed prepare/build cost but not this per-item cost), #84
(worker_threads), #255 (brewery-name garbling adapters).
