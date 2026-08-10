# #391 — carrying the #382 query ladder into the relay path: design

**Date:** 2026-08-10
**Status:** design approved, pending implementation plan
**Issue:** #391 (`matcher-bug`), the relay half of #382
**Scope:** `src/api/routes/enrich.ts` (both endpoints), `extension/src/content/enrich.ts`,
`extension/src/content/main.ts`, `extension/src/background/index.ts`,
`extension/src/api/{client,types}.ts`. No change to `src/domain/normalize.ts` or
`src/domain/untappd-lookup.ts` — the ladder itself already exists and is deployed.

## 1. The gap

`/enrich/candidates` prepares exactly one Algolia query per beer:

```ts
// src/api/routes/enrich.ts:147
const query = cleanSearchQuery(b.brewery, b.name);
```

#382 replaced the server's own query with a two-rung ladder — a narrow rung that keeps
Cyrillic tokens, widening to today's query only on a zero-hit result. That ladder lives
inside `lookupBeer`, so the cron/enrichment path has it and the relay path does not.

On the relay path `lookupBeer` still *runs* its ladder, but inertly: `/enrich/result`
injects a search adapter that returns the relayed payload regardless of the query
(`src/api/routes/enrich.ts:241`). Every rung therefore sees the same candidate list, and
the `triedUrls` the ladder accumulates describe searches nobody executed. That fiction is
what lands in `enrich_failures.search_url` (§4).

## 2. Live replay — the measured stake on the relay path

Per project policy the issue was replayed against live Algolia before any code was
written. Population: the **145 active `enrich_failures` rows whose `source_url` is
flasker** (the dominant relay source), each run twice through the deployed `lookupBeer`
with a fixed payload — once with the wide rung (today's relay behaviour), once
narrow-first-with-widening (the proposal).

| | rows |
|---|---|
| replayed | 145 |
| two-rung ladder (i.e. affected at all) | 35 |
| verdict changes | 3 |

The three changes:

| beer_id | shop pair | narrow rung | outcome |
|---|---|---|---|
| 29789 | `CITADEL / ...Лохина, Чорна Смородина` | `CITADEL Лохина, Чорна Смородина` | → 6213529 *Берлінський Білий: Лохина, Чорна Смородина* ✅ |
| 30845 | `Гонір / Квас / Kvass` | `Гонір Квас Kvass` | → 1705602 *Гонір — Honir Brewery / Квас* ✅ |
| 34221 | `CITADEL / Томатка` | `CITADEL Томатка` | → 6456882 *Томатка: Аджика* ❌ — this is #393 |

No row that matches today stopped matching.

### 2.1 The wrong one is already contained

34221 is the known #393 defect: `ALGOLIA_HITS_PER_PAGE = 5` truncates the exact-name,
exact-ABV record out of a saturated sibling pool. It is **parked in production**
(`untappd_lookup_count = 4`, terminal backoff), and `/enrich/candidates` gates
eligibility through the same `isEligible(now, untappd_lookup_at, untappd_lookup_count)`
as the cron. The relay path therefore cannot write that wrong link either, and #393
stays out of this design's scope.

### 2.2 Cost of the second rung

| population | two-rung share |
|---|---|
| 1365 orphan rows, all shops | 8.6% |
| 145 flasker relay rows | 24.1% |

The fallback only fires when the narrow rung returns zero hits — 27 of 35 in the flasker
set (~77%). Expected extra Algolia calls per page: roughly 7% (mixed shops) to 19%
(a Ukrainian shop), not a doubling.

## 3. Wire protocol

### 3.1 `/enrich/candidates` response

```ts
const rungs = searchQueryLadder(b.brewery, b.name);   // [narrow] or [narrow, wide]
{
  brewery, name, eligible,
  algolia: algoliaQuery(deps, rungs[rungs.length - 1]),          // unchanged semantics
  algoliaNarrow?: algoliaQuery(deps, rungs[0]),                  // only when rungs.length === 2
}
```

Two properties are load-bearing and both are asserted by tests, not by argument:

1. **`algolia` keeps carrying today's query.** The last rung is by construction
   `cleanSearchQuery(brewery, name)` — the same string the route sends today.
2. **`algoliaNarrow` is absent whenever the rungs agree**, which is every all-Latin
   input (91% of orphans).

An extension below the version that understands the field ignores it and behaves exactly
as today. This is why `algolia` is *not* redefined to be the narrow rung: the replay shows
the narrow rung returns zero hits on 27 of 35 affected rows, so an old client handed a
narrow-only query would post an empty payload, record a false `not_found` and burn a
backoff slot — a measured regression (e.g. 29766 `JAGER / Hazy АРА`, which the wide query
matches today and the narrow one does not).

`algoliaNarrow` is a **full `AlgoliaQuery` object**, not a bare string, despite duplicating
the credentials for up to 200 beers (~25 KB per batch). Both rungs then travel through one
identical execution path in the client (`fetchSearch(AlgoliaQuery)`), with no second code
path where credentials or `hitsPerPage` could drift apart. The batch limit applies to the
request body, not this response.

### 3.2 `/enrich/result` request

One new optional field: `query: string` (bounded by `BEER_TEXT_LIMIT_CHARS`) — the rung the
client actually executed, i.e. the rung that produced the relayed hits.

## 4. Server: an honest `search_url`

`/enrich/result` recomputes `searchQueryLadder(brewery, name)` and accepts `query` only if
it equals one of those rungs; any other value is ignored and the endpoint behaves exactly
as today. The check is a pure function with no network cost, and it keeps a buggy or
forged client from writing arbitrary text into the column that triage reads.

An accepted `query` replaces the search URLs in the `lookupBeer` outcome before
`applyLookupOutcome` writes the failure row (`not_found.searchUrls` →
`[buildSearchUrl(query)]`, `blocked.searchUrl` likewise). `enrich_failures.search_url` then
describes a search that actually happened.

Why this matters beyond tidiness: #381 is open precisely because a wrong query produces a
wrong triage *class*, and the triage agent reads `search_url` as its evidence.

## 5. Client: order, budget, and the two refusals

### 5.1 Order

`runEnrichment` executes `algoliaNarrow` first when present, and falls back to `algolia`
**only when the narrow rung returned zero hits**.

It never widens after a rung that returned candidates, even when the server answers
`not_found`. The narrow rung's term set is a superset of the wide rung's, so its result set
is a subset: widening after a matcher rejection can only re-offer rows the same stages just
rejected (#382 design §3.3).

### 5.2 Budget

`MAX_SEARCHES_PER_PAGE = 20` starts counting **searches** rather than beers, and
`DEFAULT_DELAY_MS` throttles **between searches** rather than between beers. The constant
exists to bound what a single page load draws from the user's session, and with a ladder it
is the calls, not the beers, that are drawn.

Consequence, accepted deliberately: on a Cyrillic-heavy page 2–4 beers of twenty are
deferred rather than searched now. They are not lost — the orphan pool is shared with the
next page load and with the cron.

### 5.3 Refusal to submit a half-run ladder

If the narrow rung returns zero hits and the budget has no slot left for the wide rung, the
beer is **not submitted at all**: no `/enrich/result` call, the badge stays ⚪.

Posting the empty narrow payload would make the server record `not_found` and spend a
backoff slot on a verdict the ladder never finished reaching — strictly worse than silence.

## 6. Plumbing

`query` crosses four boundaries, each of which has silently dropped an optional field
before (#384 shipped dead exactly here):

```
runEnrichment  →  main.ts (enrich:result msg)  →  EnrichResultMessage / handleEnrichResult  →  postEnrichResult
```

`algoliaNarrow` crosses two: `EnrichCandidate` (type) → `runEnrichment` (consumption). Every
boundary gets its own test rather than an end-to-end test of the two ends.

## 7. Tests

**Server**
- two-rung (Cyrillic) input → response carries `algoliaNarrow`; single-rung (Latin) input → field absent.
- `algolia` for a given pair is byte-identical to `cleanSearchQuery(brewery, name)`.
- `/enrich/result` with a `query` equal to a ladder rung → that URL lands in
  `enrich_failures.search_url`; with a foreign `query` → the row is written as it is today.

**Extension**
- narrow rung is searched first when present;
- wide rung is searched only when the narrow returned zero hits;
- non-empty narrow result → no second call, even if the server answers `not_found`;
- budget counts searches: a page whose beers all carry two rungs and all zero on the narrow
  performs 20 searches, not 40;
- narrow-zero with an exhausted budget → no `submitResult` call for that beer;
- `query` reaches `postEnrichResult` with the value of the executed rung.

## 8. Release

No version bump in this PR. 0.14.0 is cut after #386, and that release carries the bump,
the CHANGELOG and `release:store` in one step. Until then this change is inert for users:
the server half alone does nothing, since every published client is 0.13.0 and ignores
`algoliaNarrow`.

`docs/extension-install-uk.md` is unchanged — no new shop, option, button or badge; nothing
user-visible beyond more beers resolving. The check is recorded here per CLAUDE.md rather
than producing an edit.

## 9. Out of scope

- **#393** — `hitsPerPage = 5` truncating a saturated sibling pool. Contained by backoff
  parking on both paths (§2.1).
- **#334** — picking among sibling variants when the shop name is a bare base name.
- **#376** — the flasker adapter's own brewery mis-splits, which produce many of the rows in
  the replay population but are a parser defect, not a query defect.
