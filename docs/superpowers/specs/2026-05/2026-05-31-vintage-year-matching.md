# Vintage Year Matching — Design Spec

> **Status:** Approved for implementation (2026-05-31)

## Problem

`normalizeName` strips digit-only tokens (including years), so `"AFFECTION 2023"` and `"Affection (2025)"` both normalize to `"affection"`. The current `matchBeer` exact-match fallback returns the most recent catalog entry by `id DESC`, causing cross-vintage matches: ontap's 2023 beer links to the user's checked-in 2025 beer and gets filtered from `/newbeers`.

**Confirmed wrong matches in DB:**
- `AFFECTION 2023` → `Affection (2025)` (user has had both 9873 and 9847)
- `Farm To Glass 2026 : Citra` → `Farm to Glass '25: Citra` (2026 matched to '25)
- `Farm To Glass 2026 : Mosaic` → `Farm To Glass '25: Mosaic`

## Goal

When the ontap name contains an explicit 4-digit year, prefer a catalog entry with the same year. Fall back to no-year entries if no year-match exists. Use ABV to further disambiguate when a year-match has a suspicious ABV discrepancy (likely an ontap data entry error).

---

## Architecture

### New helper: `extractYear(name: string): number | null`

Extracts the first 4-digit year matching `/\b(19|20)\d{2}\b/` from a **raw** (un-normalized) name. Returns `null` if none found.

Must be called on the raw `input.name`, not the normalized `nn`, because `normalizeName` strips digit tokens.

### Modified exact-match selection in `matchBeer`

The current exact match block (lines 63–80 in `matcher.ts`) becomes:

```
exacts = catalog entries with matching normalized brewery + name, sorted id DESC

if exacts is empty → go to fuzzy (unchanged)

inputYear = extractYear(input.name)

if inputYear is null:
  → existing logic: ABV hit first, else exacts[0]

if inputYear is non-null:
  yearMatch  = exacts where extractYear(c.name) === inputYear   (sorted id DESC)
  noYear     = exacts where extractYear(c.name) === null         (sorted id DESC)
  wrongYear  = exacts where extractYear(c.name) ∉ {inputYear, null}  (sorted id DESC)
  // wrongYear excluded from normal selection path

  if yearMatch is non-empty:
    candidate = yearMatch[0]   (most recent year-matching entry)

    abvMismatch = input.abv ≠ null
               && candidate.abv ≠ null
               && |input.abv − candidate.abv| > ABV_TOLERANCE (0.3)

    if NOT abvMismatch:
      → return candidate  (year matches, ABV OK or not checkable)

    // ABV mismatch: likely an ontap data entry error on the year-specific row.
    // Try alternatives that have a better ABV match.
    abvHit = first of noYear  where |c.abv − input.abv| ≤ 0.3
          ?? first of wrongYear (id DESC) where |c.abv − input.abv| ≤ 0.3
    if abvHit:
      → return abvHit
    // Nothing with matching ABV: accept the ontap ABV error, stay on year-match.
    → return candidate

  if yearMatch is empty:
    // No same-year catalog entry; fall back to no-year entries.
    if noYear is non-empty:
      → apply existing logic to noYear only (ABV hit first, else noYear[0])
    else:
      → return null  (only wrong-year entries exist; don't cross-match vintages)
```

### Retroactive cleanup (run after deploy)

Delete the 3 confirmed wrong match_links via SQL, then run `/refresh`. The corrected matcher will re-create match_links using the new logic.

```sql
DELETE FROM match_links
WHERE ontap_ref IN (
  'AFFECTION 2023',
  'Farm To Glass 2026 : Citra',
  'Farm To Glass 2026 : Mosaic'
);
```

After `/refresh`:
- `AFFECTION 2023` → inputYear=2023, no 2023 in catalog, noYear=[`Affection` id=9847] → matches `Affection` (best available without 2023-specific Untappd entry)
- `Farm To Glass 2026 : Citra` → inputYear=2026, no 2026 in catalog, noYear=[`Farm to Glass '25: Citra`] (the `'25` is not a 4-digit year) → matches `'25` entry (limitation of 4-digit detector)

Note: `Affection 2023` will still map to `Affection` (id=9847) since the user has also checked in that. A proper fix requires `Affection (2023)` to exist as a separate Untappd catalog entry — which enrich-orphans cannot create without a match_link pointing to an orphan beer. This is an acceptable limitation for now.

---

## Files Changed

| File | Change |
|------|--------|
| `src/domain/matcher.ts` | Add `extractYear`; replace lines 71–80 with year-aware selection |
| `src/domain/matcher.test.ts` | New tests for year-preference, ABV-mismatch fallback, no-year fallback, wrongYear-only null |

**Not changed:** `normalize.ts`, storage, bot, jobs.

---

## Test Cases

| Scenario | Input | Catalog candidates | Expected |
|----------|-------|-------------------|----------|
| Year match, ABV OK | `Affection 2025, abv=7.0` | `[Affection(2025) abv=7.1, Affection(2024) abv=6.8, Affection abv=7.0]` | `Affection(2025)` |
| Year match, ABV mismatch → noYear ABV hit | `Affection 2025, abv=7.0` | `[Affection(2025) abv=9.9, Affection abv=7.0]` | `Affection` (noYear ABV match) |
| Year match, ABV mismatch → wrongYear ABV hit | `Affection 2025, abv=7.0` | `[Affection(2025) abv=9.9, Affection(2024) abv=7.0]` | `Affection(2024)` (wrongYear ABV match) |
| Year match, ABV mismatch, no alternatives | `Affection 2025, abv=7.0` | `[Affection(2025) abv=9.9]` | `Affection(2025)` (accept ABV error) |
| No year match → noYear fallback | `Affection 2023` | `[Affection(2025), Affection(2024), Affection]` | `Affection` (noYear) |
| No year match, no noYear → null | `Affection 2023` | `[Affection(2025), Affection(2024)]` | `null` |
| No year in input → existing behavior | `Affection, abv=7.0` | `[Affection(2025) abv=7.1, Affection(2024) abv=6.8]` | `Affection(2025)` (id DESC) |
| noYear only with ABV | `Affection, abv=7.0` | `[Affection(2025) abv=7.1, Affection abv=7.0]` | `Affection` (ABV hit) |
| wrongYear only → null | `Affection 2023` | `[Affection(2025)]` | `null` |
| No year input, no year in catalog | `Affection` | `[Affection]` | `Affection` |
