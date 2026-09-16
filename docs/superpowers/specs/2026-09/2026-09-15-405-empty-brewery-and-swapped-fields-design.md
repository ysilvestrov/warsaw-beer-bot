# #405 — Empty Brewery & Swapped Fields Reconciliation

**Date:** 2026-09-15  
**Status:** draft  
**Issue:** #405 (and decomposed rows from #334)  

---

## 1. Problem

The daily orphan triage agent cataloged 22 rows under issue #405 and 42 rows under #334. Following systematic cluster decomposition, two distinct, high-volume defect mechanisms were isolated where Untappd Algolia search returns the exact target beer at rank 1, but `lookupBeer()` returns `not_found`:

### A. Sub-cohort A1: Empty Input Brewery (`brewery = ''`, 16 rows)
When a shop listing extracts no separate brewery field (e.g. `Loca Deserta Meadery Two Keepers` with `brewery = ''`), Algolia search on the full string returns the target beer (`Loca Deserta Meadery — Two Keepers`, bid 5315178).

In `src/domain/untappd-lookup.ts`:
1. The empty input brewery lands all candidates into `relaxedPool` (#149 bypass).
2. Stage 2a computes:
   ```ts
   const inputKeys = nameKeys(name, brewery);
   ```
   Because `brewery` is empty, `stripBreweryFromName(nameNorm, '')` strips nothing. The resulting key set contains the candidate's brewery tokens (e.g. `{"deserta", "keepers", "loca", "meadery", "two"}`).
3. The candidate's key set is `nameKeys(r.beer_name, r.brewery_name)` (`{"keepers", "two"}`).
4. `intersects(...)` returns false because the sets do not match.
5. In relaxed exact evaluation (`relaxedTargetValues`), the input target value still retains the brewery tokens, whereas the candidate has only the beer name. Exact match fails.
6. The row becomes an orphan despite exact rank 1 availability.

**Affected live rows (16 beers):**
- 15 rows in #405: `34361`, `34362`, `34363`, `34364`, `34365`, `34366` (`Loca Deserta Meadery`), `29666` (`Piwne Podziemie / Beer Underground`), `30361` (`Farsight Brewing`), `25819`, `25822`, `25823`, `25825`, `25827`, `26048`, `29509`.
- 1 row in #334: `29667` (`Sofia Electric Brewing Fruit Fusion Factory - Cherry Blueberry`).

---

### B. Sub-cohort A3: Swapped Brewery & Name Fields (3 rows)
When a shop swaps the brewery and beer name (e.g. `Płynne Złoto Brewery` / `Dziki Wschód 18,5°` or `PanIPAni Brewery` / `Trzech Kumpli`):
1. Untappd registers the beer as `Browar Dziki Wschód — PŁYNNE ZŁOTO` (bid 6757171) or `Browar Trzech Kumpli — Pan IPAni` (bid 1000186).
2. The function `swappedBrandNameScore` (`src/domain/untappd-lookup.ts:404`) was explicitly designed to detect when the input name covers the candidate brewery AND the candidate beer name covers the input brewery.
3. However, `swappedBrandNameScore` is evaluated **exclusively inside `if (strictPool.length > 0)`** at line 553.
4. For swapped fields, the candidate's registered brewery (`Browar Dziki Wschód`) never matches the input brewery (`Płynne Złoto`), so `strictPool` is always empty.
5. The candidate instead lands in `brandPool` (because `candidate.beer_name` contains the input brewery tokens).
6. Consequently, `swappedBrandNameScore` is dead code — mathematically unreachable by construction for the very cases it was written to solve.

**Affected live rows (3 beers):**
- #405: `34375` (`Płynne Złoto Brewery` / `Dziki Wschód 18,5°`), `34228` (`HOPPY` / `THERAPY: Citra х Nectaron NEIPA`).
- #334: `30076` (`PanIPAni Brewery` / `Trzech Kumpli`).

---

## 2. Decision & Architecture

### Component 1: Candidate Brewery Stripping on Empty Input Brewery (Sub-cohort A1)
In `src/domain/untappd-lookup.ts`:
1. In Stage 2a (exact name-key intersection), when `inputBreweryAliases.length === 0`, evaluate name-key intersection against `nameKeys(name, r.brewery_name)` for each candidate `r` in `relaxedPool`.
   - `stripBreweryFromName(normalizeName(name), normalizeBrewery(r.brewery_name))` strips the candidate's brewery tokens from the input name.
   - If the candidate's brewery is genuinely present in the input name, the remaining name keys intersect with the candidate's `nameKeys(r.beer_name, r.brewery_name)`.
2. In the relaxed exact fallback (`relaxedExact` for single-token names like `St-Feuillien Five`):
   - When `inputBreweryAliases.length === 0`, also allow match if:
     `stripBreweryFromName(normalizeName(name), normalizeBrewery(r.brewery_name)) === normalizeName(r.beer_name)`.
3. **Safety Guards**:
   - Only active when `inputBreweryAliases.length === 0` (input brewery is completely empty).
   - Requires that `stripBreweryFromName` actually removed at least one brewery token (preventing generic substring collision).
   - Tie-broken by `pickByAbv` when multiple candidates match.

### Component 2: Reachable `swappedBrandNameScore` on `brandPool` (Sub-cohort A3)
In `src/domain/untappd-lookup.ts`:
1. Move/extend the evaluation of `swappedBrandNameScore`:
   - In the `brandPool` stage (lines 682-690), evaluate `swappedBrandNameScore(targetName.value, inputBreweryAliases, candidate)` across `brandPool`.
2. If `swappedBrandNameScore` succeeds:
   - Verify that ABV is compatible (no contradiction outside `ABV_TOLERANCE`).
   - If exactly one candidate satisfies the two-way swap score with compatible ABV, return `{ kind: 'matched', result: candidate }`.
3. **Safety Guards**:
   - Two-way token coverage is strictly enforced: `aliasTokensCoveredBy(candidateNameTokens, inputBreweryAliases)` AND `aliasTokensCoveredBy(targetTokens, candidateBreweryAliases)`.
   - Requires non-empty tokens on both sides.
   - Requires ABV tolerance compliance when ABV is present.

---

## 3. Claims and Their Evidence

| Recorded fact | Claim | Evidence required before recording |
|---|---|---|
| `lookupBeer({ brewery: '', name: 'Loca Deserta Meadery Two Keepers' })` returns bid 5315178 | Empty input brewery with candidate brewery in name matches on exact name-keys | Unit test in `untappd-lookup.test.ts` passing; `nameKeys(name, r.brewery_name)` intersects `nameKeys(r.beer_name, r.brewery_name)` |
| `lookupBeer({ brewery: '', name: 'St-Feuillien Five' })` returns bid for `Five` | 1-token beer name with candidate brewery in name matches on stripped exact name | Unit test in `untappd-lookup.test.ts` passing; `stripBreweryFromName` leaves exact candidate beer name |
| `lookupBeer({ brewery: 'Płynne Złoto Brewery', name: 'Dziki Wschód 18,5°' })` returns bid 6757171 | Swapped brewery and name fields match via `swappedBrandNameScore` on `brandPool` | Unit test in `untappd-lookup.test.ts` passing; two-way token coverage confirmed |
| `lookupBeer({ brewery: 'PanIPAni Brewery', name: 'Trzech Kumpli' })` returns bid 1000186 | Swapped brewery and brand beer name match via `swappedBrandNameScore` | Unit test in `untappd-lookup.test.ts` passing; exact ABV corroboration (6.0 = 6.0) |
| Negative guard: unrelated brewery name does not match | Candidate brewery not present in name returns `not_found` | Negative unit test asserting `not_found` when brewery tokens do not match |

---

## 4. Test Plan

### Unit Tests (`src/domain/untappd-lookup.test.ts`)
1. **Empty brewery exact key intersection (Sub-cohort A1)**:
   - Input: `brewery: ''`, `name: 'Loca Deserta Meadery Two Keepers'`, candidate `brewery_name: 'Loca Deserta Meadery'`, `beer_name: 'Two Keepers'`.
   - Expected: `matched` with exact candidate.
2. **Empty brewery single-token exact name (Sub-cohort A1)**:
   - Input: `brewery: ''`, `name: 'St-Feuillien Five'`, candidate `brewery_name: 'Brasserie St-Feuillien'`, `beer_name: 'Five'`.
   - Expected: `matched`.
3. **Swapped fields matching (Sub-cohort A3)**:
   - Input: `brewery: 'Płynne Złoto Brewery'`, `name: 'Dziki Wschód 18,5°'`, candidate `brewery_name: 'Browar Dziki Wschód'`, `beer_name: 'PŁYNNE ZŁOTO'`.
   - Expected: `matched`.
   - Input: `brewery: 'PanIPAni Brewery'`, `name: 'Trzech Kumpli'`, candidate `brewery_name: 'Browar Trzech Kumpli'`, `beer_name: 'Pan IPAni'`.
   - Expected: `matched`.
4. **Negative regression guards**:
   - `brewery: ''` with unrelated candidate returns `not_found`.
   - Partial token overlap without full brewery coverage in swapped mode returns `not_found`.
   - ABV contradiction vetoes match.

### Full Gate
- `npm test && npm run typecheck`

---

## 5. Invariants for `spec.md`

In `spec.md` (under `Сила збігу пивоварні (enrich, lookupBeer)` and `Brand-as-beer-name (#138B)`):
1. **Empty brewery candidate-stripping (#405)**:
   When input brewery is empty (#149 bypass), relaxed exact name-key matching compares candidate name-keys against input name-keys computed with the candidate's registered brewery stripped from the input name (`nameKeys(name, candidate.brewery_name)`).
2. **Swapped brand/name matching (#405)**:
   When the candidate's beer name covers the input brewery and the candidate's registered brewery covers the input name tokens (`swappedBrandNameScore`), the match is admitted from `brandPool` with score 0.72 subject to ABV corroboration.
