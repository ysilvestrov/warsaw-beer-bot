# #393 — Raise Algolia hitsPerPage to 15 to Prevent Sibling Truncation: Design

**Date:** 2026-10-11  
**Status:** accepted  
**Issue:** #393  

## Problem

Untappd's Algolia search ranks results primarily by textual relevance and popularity (`rating_count`). In `src/sources/untappd/algolia.ts`, `ALGOLIA_HITS_PER_PAGE` was set to `5`, an artifact carried over from the legacy HTML scraper's pagination limit.

When a query targets a brewery's series or tightly related family of variants ("sibling pool"), `hitsPerPage: 5` truncates the candidate list before less popular or newer variants are reached.

### Confirmed Failure Cases

1. **`CITADEL / Томатка` (beer_id 34221, ABV 5.0%)**:
   - Query `CITADEL Томатка` returns **8 hits** in Algolia.
   - The exact-name, exact-ABV beer `Томатка` (5.0%, bid `6697878`) ranks **6th**.
   - With `hitsPerPage = 5`, the exact beer was excluded from the pool, and the matcher accepted `Томатка: Аджика` (4.4%) via the candidate-side-suffix rule — an active **false positive** (wrong match). The row was parked in production (`untappd_lookup_count = 4`) to prevent cron corruption.

2. **`Magic Road / Stout` (beer_id 37450, ABV 4.5%)**:
   - Query `Magic Road Stout` returns **11 hits** in Algolia.
   - The exact beer `Stout` (4.5%, bid `6632734`, released Sep 2026, 35 ratings) ranks **7th**.
   - The top 5 hits contain two distinct 4.5% stouts (`Only Dry Stout` and `Simple Stout`), producing an unresolved tie that left the row orphaned.

3. **`Browar Nieczajna / Session IPA 12°` (beer_id 37462, ABV 5.0%)**:
   - Query `Nieczajna Session IPA` returns **12 hits** in Algolia.
   - The actual product served on tap — `Session IPA - Single Hop: NZ Rhapzody` (5.0%, bid `6828812`, 6 ratings) — ranks **11th**.
   - Another live tap from the database — `Session IPA - Nelson Sauvin & Riwaka` (5.0%, bid `6999832`, 6 ratings) — ranks **12th**.
   - Both variants were dropped by the 5-hit boundary.

---

## Architectural Analysis & Trade-Offs

Issue #393 initially identified three potential directions:
1. **Raise `hitsPerPage` (e.g. to 15).**
2. **Re-query on a saturated pool (pagination / fetch page 2 if `hits.length === 5 && nbHits > 5`).**
3. **Refuse to match a saturated sibling pool.**

### Why Raising `hitsPerPage` to 15 is Superior to Pagination

| Dimension | Direction 1: Raise to 15 | Direction 2: Paging on saturated pool |
| :--- | :--- | :--- |
| **Network Requests** | Exactly 1 HTTP request per search | 2 sequential HTTP requests when `nbHits > 5` |
| **Extension Relay Protocol** | 0 changes (server configures `hitsPerPage`) | Requires multi-step pagination protocol between server and extension |
| **Client Deploy Requirement** | 0 changes; older extension clients inherit immediately | Requires extension update shipped to Chrome Web Store |
| **Algolia API Operations** | 1 operation per search (Algolia bills per query) | 2 operations per saturated search |
| **Latency for End Users** | Single RTT (~100–150ms) | Double RTT (~250–350ms) on saturated searches |
| **Coverage** | Covers 100% of documented sibling pools (size 8–12) | Covers unbounded pools, but at complexity cost |

### False Positive Safety with 15 Hits

Widening candidate pools raises the question of whether lower-ranked candidates could cause false positives:
1. **Exact matches win first:** In `lookupBeer`, Stage 2a (`nameKeys` exact intersection) evaluates before any approximate or suffix rules. As seen in `CITADEL Томатка`, having the true exact match in the pool **prevents** false positives by satisfying Stage 2a before approximate rules can select an incorrect top-5 candidate.
2. **Strict filtering remains intact:**
   - Strict brewery matching required for approximate and fuzzy stages.
   - `NAME_FUZZY_THRESHOLD = 0.85`.
   - `nameTokensDiverge` rejects candidates with diverging flavor/content words.
   - `digitIdentity` strictly vetoes different versions/vintages/grades.
   - `isAlcoholClassMismatch` and `ABV_TOLERANCE = 0.3` veto strength discrepancies.
   - Ties require 10x check-in dominance (`dominantCandidate`) or safely return `not_found`.
3. **Verified on live data:** Testing `Browar Nieczajna / Session IPA 12°` against all 12 Algolia candidates returned `not_found` (safe orphan), because the generic tap name refused to guess among multiple single-hop variants.

---

## Decisions

### 1. Update Server Constant (`src/sources/untappd/algolia.ts`)
Change `ALGOLIA_HITS_PER_PAGE` from `5` to `15`:
```ts
export const ALGOLIA_HITS_PER_PAGE = 15;
```

### 2. Relay Endpoint Propagation (`src/api/routes/enrich.ts`)
The server's `/enrich/candidates` endpoint passes `algoliaQuery(deps, query)` which sets:
```ts
hitsPerPage: ALGOLIA_HITS_PER_PAGE,
```
Because `extension/src/background/index.ts` dynamically forwards `msg.algolia.hitsPerPage`, all extension installations (current and existing) immediately query with `hitsPerPage: 15` without requiring an extension release.

### 3. Specification Update (`spec.md`)
Update § Algolia Search (line 2007) to record `hitsPerPage: 15`.

### 4. Operations: Unpark Row 34221
Upon merge and deployment of this change:
- Re-arm row `34221` (`CITADEL / Томатка`) so the next enrich cron resolves it to canonical bid `6697878`.

---

## Claims and Their Evidence

| Claim | What records it as fact | Evidence proving it |
| :--- | :--- | :--- |
| `CITADEL Томатка` (row 34221) query returns 8 hits, true beer is rank 6 | Issue #393 investigation | Live Algolia query `CITADEL Томатка`: `nbHits: 8`, rank 6 is `Томатка` (bid `6697878`, 5.0%, 147 ratings). |
| `Magic Road Stout` (row 37450) query returns 11 hits, true beer is rank 7 | Issue #393 investigation | Live Algolia query `Magic Road Stout`: `nbHits: 11`, rank 7 is `Stout` (bid `6632734`, 4.5%, 35 ratings). |
| `Browar Nieczajna Session IPA` (row 37462) query returns 12 hits, true beer is rank 11 | Issue #393 investigation | Live Algolia query `Nieczajna Session IPA`: `nbHits: 12`, rank 11 is `Session IPA - Single Hop: NZ Rhapzody` (bid `6828812`, 5.0%, 6 ratings). |
| `hitsPerPage = 15` fixes `CITADEL Томатка` and `Magic Road Stout` without false positives | Live replay | Probed live with tsx simulation: `CITADEL Томатка` $\to$ matched bid `6697878`; `Magic Road Stout` $\to$ matched bid `6632734`; `Nieczajna` $\to$ `not_found` (safe orphan). |
| Extension forwards `hitsPerPage` dynamically from server | Extension source code | `extension/src/background/index.ts` lines 116–124 extracts `hitsPerPage` from `msg.algolia` without hardcoded limit. |
| Algolia API billing treats `hitsPerPage = 15` as 1 operation | Algolia documentation | Algolia operations are counted per query request; payload increase (~5 KB) is negligible against 512 KB API body limits. |

---

## Verification Plan

### Automated Tests
1. **Unit test (`src/sources/untappd/algolia.test.ts`)**:
   - Assert `parseAlgoliaResponse` and `createAlgoliaSearch` send `hitsPerPage: 15`.
2. **Route test (`src/api/routes/enrich.test.ts`)**:
   - Assert `/enrich/candidates` returns `algolia.hitsPerPage = 15`.
3. **Domain lookup test (`src/domain/untappd-lookup.test.ts`)**:
   - Add a test verifying that when Algolia returns a sibling pool where exact match sits at index 5–14 (beyond top 5), `lookupBeer` correctly identifies and matches the exact candidate instead of misattributing or orphaning.
4. **Full Test Suite & Typecheck**:
   - Run `npm test` and `npm run typecheck`.

### Operational Verification
1. Re-arm row `34221` and verify live enrichment matches bid `6697878`.
