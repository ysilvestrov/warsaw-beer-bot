# #769 — Collab Co-Brewer ABV Tie-Break: Design

**Date:** 2026-10-01  
**Status:** proposed  
**Issue:** #769  

## Problem

Orphan issue #769 tracks orphan failures where Untappd returns the same-named beer across co-brewers of a collaboration, but the matcher fails closed because scored candidates tie.

### 1. Row 38475: `Sarabanda & Palatum Brewery / Wheat Love 11°` @ 4.5%

The internal enrich failure row stores:

```text
id: 38475
brewery: Sarabanda & Palatum Brewery
name: Wheat Love 11°
abv: 4.5
```

Live Algolia search returns two candidates from the co-brewers of the collaboration:

| bid | beer_name | brewery_name | ABV | rating_count | global_rating |
|---:|---|---|---:|---:|---:|
| 5756147 | Wheat Love | Browar Sarabanda | 4.5% | 106 | 3.34 |
| 5751710 | Wheat Love | Palatum | 4.8% | 59 | 3.46 |

Both candidates represent the exact same collaboration beer (*American Wheat Ale* brewed jointly by Browar Sarabanda and Browar Palatum with Mosaic & Strata hops, original extract 11°). Both breweries created an entry for it on Untappd under their respective brewery accounts.

**Failure Mechanism:**
1. `BREWERY_COLLAB_SEP` splits `Sarabanda & Palatum Brewery` into `['sarabanda palatum', 'sarabanda', 'palatum']`. Both candidates pass the strict brewery gate (`Browar Sarabanda` matches `sarabanda`, `Palatum` matches `palatum`). Both land in `strictPool`.
2. In `normalizeName('Wheat Love 11°')`, the style word `Wheat` is stripped by `STYLE_WORDS`. The Czech grade `11°` is stripped as numeric noise. The remaining normalized token is single: `'love'`.
3. `nameKeys` requires $\ge 2$ tokens after `normalizeName`. Therefore, `nameKeys` yields an empty set (`Set(0)`). Stage 2a exact name-key intersection (`keyHits`) finds 0 hits and is skipped.
4. Both candidates proceed to Stage 2a.5 (strict near-name) and Stage 2b (fuzzy). Both candidates evaluate to the same candidate identity `'love'`. Both score equal maximum score 1.0 (`nearMatches` and `matches`).
5. `pickScoredCandidate` sees a tie of 2 distinct top-scored candidates (`top.length === 2`). Under #409, ties delegate to `dominantCandidate(top, abv)`.
6. `dominantCandidate` requires $\ge 1\,000$ ratings (`FLAGSHIP_MIN_RATINGS = 1000`) and a 5x dominance ratio. Because these craft beers have 106 and 59 ratings, `dominantCandidate` returns `null`.
7. `pickScoredCandidate` returns `null`. The stage returns terminal `notFound()`.
8. The matcher fails closed, never using the fact that Candidate 1 matches the input ABV exactly (4.5% vs 4.5%) while Candidate 2 diverges (4.8%).

### 2. Row 38482: `Wrowar Brewery / Disco Gooses 3 12°` @ 4.9%

Auto-triage grouped row 38482 into #769 under the hypothesis of a `Brewery` vs `Brewing` suffix divergence. Live replay disproved this hypothesis:
- `normalizeBrewery` strips both `brewery` and `brewing` via `BREWERY_NOISE`; both normalize to `wrowar`. The brewery gate is not broken.
- Untappd search candidate `Wrowar Brewing — Disco Gooses` (bid 6095328, 5.0%) is **Version 1** of the Disco Gooses series (lychee & mango).
- The beer on tap is **Version 3** (`Disco Gooses 3 12°` @ 4.9%, raspberry & red currant).
- Version 3 exists on Untappd as an independent registered beer: `Wrowar Brewing — Disco Gooses 3.0` (bid `6028011`, 4.9% ABV).
- `digitIdentity` correctly rejected `Disco Gooses` (v1) for `Disco Gooses 3` (v3). Matching them would have been a `Severity-2` false match.
- Row 38482 is not a collab matcher bug. It is resolved operationally by pinning it to its true Untappd bid `6028011` (`npm run pin-match -- --beer 38482 --untappd 6028011`).

---

## Decision

Add a strict **Collab Co-Brewer ABV Tie-Break** (`collabCoBrewerTiebreak`) to `lookupBeer` in [src/domain/untappd-lookup.ts](file:///home/ysi/warsaw-agy-bb/src/domain/untappd-lookup.ts).

The tie-break acts as a refusal refinement for an unresolved tie among top-scored candidates in the strict-only near-name stage (Stage 2a.5) and fuzzy stage (Stage 2b). It executes only when `pickScoredCandidate` returns `null` (no single winner and no dominant candidate) and before returning `notFound()`.

The tie-break accepts a candidate only when **all** of the following conditions hold:

1. **Input brewery is an explicit collaboration:**
   Splitting the input brewery by `BREWERY_COLLAB_SEP` yields $\ge 2$ non-empty normalized parts (`collabParts.length >= 2`).
2. **Top-scored candidates only:**
   The tie-break inspects only candidates in the top-score cohort from the current stage.
3. **Identical candidate name identity:**
   Every candidate in the tie shares the exact same candidate identity:
   `candIdentValue(a) === candIdentValue(b)`.
   (They are alternative entries for the same beer name, not distinct beers of the series).
4. **Co-brewers representation:**
   Every candidate in the tie strictly matches a *different* normalized collaboration part of the input brewery:
   Each candidate's brewery aliases match at least one `collabPart`, and no two tied candidates map exclusively to the same co-brewer.
5. **Known input and candidate ABVs:**
   The input ABV is known (`inputAbv != null`), and each tied candidate has a known non-null ABV.
6. **Strictly closer ABV within tolerance:**
   Exactly one candidate's ABV is within `ABV_TOLERANCE` of the input ABV (`|cand.abv - inputAbv| <= ABV_TOLERANCE`), AND that candidate's ABV distance to `inputAbv` is strictly smaller than every other candidate's distance:
   `|cand_winner.abv - inputAbv| < |cand_other.abv - inputAbv|`.
7. **Unique winning candidate:**
   Exactly one distinct `bid` satisfies all conditions.

If any condition fails (e.g. non-collab brewery, different candidate names, missing ABV, equidistant ABVs where neither is strictly closer, or multiple candidates with identical matching ABV), the tie-break returns `null`, and `lookupBeer` preserves its existing `notFound()` refusal.

---

## Placement

Place `collabCoBrewerTiebreak` inside [src/domain/untappd-lookup.ts](file:///home/ysi/warsaw-agy-bb/src/domain/untappd-lookup.ts).

In Stage 2a.5 (strict near-name):
```ts
if (nearMatches.length > 0) {
  const nearHit = pickScoredCandidate(nearMatches, abv);
  if (nearHit) return { kind: 'matched', result: nearHit };
  const boundaryHit = collabTokenBoundaryRescue({ brewery, name, abv }, strictPool);
  if (boundaryHit) return { kind: 'matched', result: boundaryHit };
  const collabHit = collabCoBrewerTiebreak({ brewery, name, abv }, nearMatches);
  return collabHit ? { kind: 'matched', result: collabHit } : notFound();
}
```

In Stage 2b (fuzzy):
```ts
if (matches.length > 0) {
  const fuzzyHit = pickScoredCandidate(
    matches.map((match) => ({ result: match.item, score: match.score })),
    abv,
  );
  if (fuzzyHit) return { kind: 'matched', result: fuzzyHit };
  const collabHit = collabCoBrewerTiebreak(
    { brewery, name, abv },
    matches.map((match) => ({ result: match.item, score: match.score })),
  );
  return collabHit ? { kind: 'matched', result: collabHit } : notFound();
}
```

**Rationale:**
- Refusal refinement: executes only after existing stages and #409 popularity dominance have failed to resolve a winner.
- Non-intrusive: does not modify `pickScoredCandidate`, `dominantCandidate`, `nameKeys`, `normalizeName`, or fuzzy scoring algorithms.
- Fully preserves all existing guarantees and tests (including order independence and fail-closed behavior for single-brewery ties).

---

## Claims and Evidence

| Recorded fact | Claim | Evidence required before recording |
|---|---|---|
| `beers.untappd_id = 5756147` via standard `recordLookupSuccess` | Orphan row 38475 is Browar Sarabanda's Untappd entry of the collaboration | Input brewery `Sarabanda & Palatum Brewery` splits into co-brewers `sarabanda` and `palatum`; candidates from both co-brewers have identical identity `'love'` and equal top score 1.0; Sarabanda entry has ABV 4.5% (exact match to input 4.5%); Palatum has ABV 4.8% (delta 0.3); Sarabanda is uniquely closer to input ABV within `ABV_TOLERANCE`. |
| Row 38482 pinned to `untappd_id = 6028011` with `untappd_id_source = 'curated'` | Orphan row 38482 is `Wrowar Brewing — Disco Gooses 3.0` | Shop label `Disco Gooses 3 12°` @ 4.9% specifies version 3; Untappd registered name is `Disco Gooses 3.0` (bid 6028011) @ 4.9% from brewery `Wrowar Brewing`. |

---

## Spec Update (`spec.md`)

Add the following description to `spec.md` under the matching section (§3.1):

> Коли strict-only near-name стадія або fuzzy Stage 2b має нічию серед top-кандидатів, але popularity resolver (`dominantCandidate`) не може вибрати переможця й мав би завершити lookup як `not_found`, `lookupBeer` має strict collab co-brewer tie-break (#769):
> 1. Вхідна броварня є колаборацією (`BREWERY_COLLAB_SEP`) із $\ge 2$ нормалізованими частинами.
> 2. Усі кандидати нічиєї мають однакову ідентичність назви (`candIdentValue`).
> 3. Кожен кандидат представляє окремого учасника цієї колаборації (co-brewers).
> 4. Вхідний ABV та ABV кандидатів відомі.
> 5. Рівно один кандидат має ABV у межах `ABV_TOLERANCE` і є строго ближчим до вхідного ABV, ніж інші кандидати нічиєї.
> 6. Рівно один distinct `bid` задовольняє ці умови.
> За відсутності будь-якого з цих доказів або за рівної близькості ABV результат лишається `not_found`.

---

## Rejected Alternatives

1. **Permit arbitrary ABV tie-break in `pickScoredCandidate` for all tied candidates:**
   Rejected. Under #409, broken ties between different variants of the same single brewery (e.g. `Hazy Discovery Warsaw` vs `Hazy Discovery Berlin`) would produce false matches. Disambiguation by ABV is safe only when the candidates share identical name identity and originate from distinct co-brewers of a collaboration.
2. **Loosen `nameKeys` to admit single-token names:**
   Rejected. Admitting 1-token names into Stage 2a exact key matching would cause massive false matches across generic style words (`Pils`, `Lager`, `Stout`).
3. **Change `normalizeName` to stop stripping `wheat`:**
   Rejected. `STYLE_WORDS` operates across all catalog and shop data. Modifying it would disrupt dozens of existing matches where `Wheat` is shop-added style noise.
4. **Treat row 38482 as a matcher bug:**
   Rejected. `Disco Gooses` (v1) and `Disco Gooses 3` (v3) are distinct beers. Matching them would be a false match. Row 38482 is properly resolved via curated pin to `Disco Gooses 3.0`.
