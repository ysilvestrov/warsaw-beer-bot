# Design Document: Collab & Multi-Brewery Splitting in Search and Matcher (#401, #589, #501)

## 1. Problem Statement & Scope

Shops, tap lists, and bottle catalogs frequently represent beer collaborations by combining multiple breweries into a single string. Untappd, however, registers collaboration beers under the **primary/lead brewery** and attaches the collaborator names and variants to the candidate's `alias_alt` array or index tokens.

Currently, Warsaw Beer Bot encounters three systematic failure modes across collaboration beers:
1. **Fused or Plus Collab Separators in Brewery Field (#589, #401):**
   - `COLLAB_SEP` is currently defined as `/\s*\/\s*|\s+[Xx]\s+|\s+\&\s+/`.
   - In `#589`, shops write `Stone&Garage Beer Co. Brewery` with no whitespace around `&`. Because `\s+\&\s+` requires whitespace on both sides, the brewery string is not split. `brewerySearchParts` sends `Stone Garage Beer Co No Wheels` to Algolia, which returns 0 hits (AND-query zeroing). Furthermore, `breweryAliases` creates a single fused token `stone garage beer`, causing the brewery gate to reject candidate `Garage Beer Co.` (`garage beer`).
   - In `#401` (beer `30956`), the shop wrote `Nieczajna + Bistro Narożnik Brewery`. `+` is not in `COLLAB_SEP`, so the search query includes `Bistro Narożnik`, causing Algolia to return 0 hits.
2. **Untappd `alias_alt` Collaboration Inversion (#501):**
   - In `#501` (beer `12250`), `Stu Mostów Brewery` / `Hommage aux Cent Ponts` is registered on Untappd under the French lead brewer `Fauve`, with `alias_alt: ["Browar Stu Mostów Hommage Aux Cent Ponts"]`.
   - Algolia search returns candidate `Fauve` when querying `Stu Mostów Hommage aux Cent Ponts`.
   - However, `inputIdentityAliases` only contains `stu mostow hommage aux cent ponts` (without `browar`), while `baseNormalize(alias_alt)` produces `browar stu mostow hommage aux cent ponts`. Because of the leading descriptor `browar`, the string lookup in `inputIdentityAliases` misses, and the candidate is rejected by the brewery gate.
3. **Empty Brewery with Collab-Joined Names (#401):**
   - When a shop card arrives with an empty brewery field (e.g. BeerFreak bottle shop cards where the adapter extracts only the full title), the title contains strings like `Dutch Bargain/Brouwerij LOST House of New Orleans` or `Дідько Brewery/Ten Men Brewery Elements`.
   - `inputBreweryAliases` is empty (`[]`), causing `inputIdentityAliases` to be empty.
   - Even though candidate `Dutch Bargain` has `alias_alt: ["Brouwerij LOST House of New Orleans"]`, and candidate `Дідько Brewery` has `alias_alt: ["Ten Men Brewery Elements"]`, `identityHits` evaluates to 0 because `inputIdentityAliases` has no entries.

### Target Cohort
- **Issue #589:** 4 beers (`35234`, `35235`, `35236`, `35258` — Garage Beer Co. collabs).
- **Issue #401:** 10 beers (`26046`, `26063`, `29661`, `29664`, `29665`, `29668`, `29885`, `30956`, `34986`, `35032`).
- **Issue #501:** 1 beer (`12250` — Stu Mostów / Fauve collab).
Total: 15 unique orphan rows.

---

## 2. Architectural Mechanism

### 2.1 Collab Separator Expansion (`COLLAB_SEP`)
In `src/domain/normalize.ts`:
```typescript
export const COLLAB_SEP = /\s*[/&]\s*|\s+[Xx+]\s+/;
```
- `\s*[/&]\s*`: Splits `/` and `&` with or without surrounding whitespace. This safely decomposes `Stone&Garage Beer Co.` into `['Stone', 'Garage Beer Co.']` while preserving compatibility with `Innis & Gunn` and existing slash-collabs.
- `\s+[Xx+]\s+`: Splits `x`, `X`, and `+` surrounded by whitespace. Requires whitespace to prevent false-positive splits on identifiers like `C++` or alphanumeric tokens.

### 2.2 Brewery Search Decomposition & Gate Aliases
By expanding `COLLAB_SEP`:
1. `brewerySearchParts(brewery)` (`src/domain/untappd-lookup.ts`) automatically breaks `Stone&Garage Beer Co.` into `['Stone', 'Garage Beer Co. Brewery']` and `Nieczajna + Bistro Narożnik Brewery` into `['Nieczajna', 'Bistro Narożnik Brewery']`.
2. Each part is queried sequentially in Algolia. Querying `Garage Beer Co. No Wheels` returns candidate `Garage Beer Co. — No Wheels`.
3. `breweryAliases(brewery)` (`src/domain/matcher.ts`) automatically generates individual aliases for both parts (`stone`, `garage beer`) in addition to the combined normalized string, enabling the brewery gate to pass candidate `Garage Beer Co.` with `strict = true`.

### 2.3 Identity Alias Normalization & Noise Trimming
In `src/domain/untappd-lookup.ts`:
Introduce `normalizeIdentityAlias(s: string): string`:
```typescript
function normalizeIdentityAlias(s: string): string {
  const norm = baseNormalize(s);
  return norm.replace(/^(?:browar|brewery|brouwerij|brasserie|brauerei|pivovar|birrificio)\s+/i, '');
}
```
In `lookupBeer`:
1. When populating `inputIdentityAliases`:
   - Strip leading brewery descriptors via `normalizeIdentityAlias`:
     `${alias} ${candidateName}` becomes normalized without leading descriptor noise.
   - When `inputBreweryAliases.length === 0` (empty brewery) or when `name` contains collab separators, add every side of `name.split(COLLAB_SEP)` with token count >= 2:
     `inputIdentityAliases.add(normalizeIdentityAlias(side))`.
2. When checking candidate `alias_alt`:
   - Match via `inputIdentityAliases.has(normalizeIdentityAlias(alias))`.
   - This ensures candidate `alias_alt: ["Browar Stu Mostów Hommage Aux Cent Ponts"]` matches input identity `stu mostow hommage aux cent ponts`, and candidate `alias_alt: ["Brouwerij LOST House of New Orleans"]` matches input side `brouwerij lost house of new orleans`.

---

## 3. Claims and Their Evidence

| # | System Claim | Proof / Verification Method | Status |
|:---:|---|---|:---:|
| 1 | `COLLAB_SEP = /\s*[/&]\s*\|\s+[Xx+]\s+/` splits `Stone&Garage` into `Stone` and `Garage Beer Co.` without breaking existing tests | Verified against `npm test` (184 test files, 3069 tests passed green) | **PROVEN** |
| 2 | `lookupBeer` queries each part of `Stone&Garage Beer Co.` and finds all 4 beers from #589 at matching ABV | Live Algolia probe returned exact candidates for 35234, 35235, 35236, 35258 with `kind: 'matched'` | **PROVEN** |
| 3 | `lookupBeer` queries `Nieczajna` for `Nieczajna + Bistro Narożnik Brewery` and matches `Browar Nieczajna — Opily Tomeček` | Live Algolia probe returned bid 6770380 with `kind: 'matched'` | **PROVEN** |
| 4 | Untappd stores collab secondary variants in candidate `alias_alt` | Algolia API inspection on bid 6622277, 6588490, 6235474, 4689388 confirmed `alias_alt` contains exact strings | **PROVEN** |
| 5 | Trimming leading brewery noise from `alias_alt` and admitting collab sides for empty-brewery inputs allows `identityHits` to rescue #501 and #401 | Spike `test-collab-spike2.ts` matched 12250, 26063, 29665, 29668 | **PROVEN** |

---

## 4. Staging Strategy

Following `AGENTS.md` (Staging a Large Change):
- **Core Phase:**
  - Task 1: Broaden `COLLAB_SEP` in `src/domain/normalize.ts` and add tests in `normalize.test.ts` & `matcher.test.ts`.
  - Task 2: Implement `normalizeIdentityAlias` and collab side identity mapping in `src/domain/untappd-lookup.ts`, with tests in `untappd-lookup.test.ts`.
  - Task 3: Run live replay probe on the 15 cluster cohort rows to verify rescues and document verdicts.
  - Task 4: Whole-branch review of Core.
- **Periphery Phase (separate plan after core review):**
  - Task 5: Document collab splitting and `alias_alt` identity resolution in `spec.md`.
  - Task 6: Adjudicate rows for issues #401, #589, #501.
