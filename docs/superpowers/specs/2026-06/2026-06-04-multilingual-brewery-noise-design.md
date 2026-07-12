# Design — Multilingual brewery-descriptor stop-words

**Date:** 2026-06-04
**Status:** Approved (brainstorming)
**Area:** `src/domain/normalize.ts` (`BREWERY_NOISE`), matching/enrichment gate

## Problem

The Untappd enrichment gate drops valid matches when the local tap label and the
Untappd brewery name use different-language words for "brewery".

Concrete case: the on-tap orphan `Cerna Hora Brewery / MATOUS`. The Untappd search
(query `Cerna Hora MATOUS`) returns exactly one result — `Matouš` by
`Pivovar Černá Hora` — but the beer is recorded `not_found`.

Root cause is **not diacritics** (both sides are diacritic-stripped correctly:
`Černá → cerna`, `Matouš → matous`). It is the brewery hard-gate in
`lookupBeer` (`src/domain/untappd-lookup.ts:52`), which requires alias-set
overlap between the two brewery names via `breweryAliases → normalizeBrewery`:

```
input  "Cerna Hora Brewery"  → aliases: ['cerna hora']
cand   "Pivovar Černá Hora"  → aliases: ['pivovar cerna hora']
overlap? false  → gate fails → not_found   (name fuzzy would pass at 1.0)
```

`BREWERY_NOISE` (`src/domain/normalize.ts:7`) only strips English/Polish
descriptors — `browar, brewery, brewing, co, company` — so the Czech `pivovar`
survives in the candidate alias and blocks the overlap. The same gap affects
German, French, Italian, Dutch, Scandinavian and Spanish breweries.

## Change

Single-point edit: extend the `BREWERY_NOISE` set with the approved multilingual
brewery descriptors. No logic changes — both consumers pick them up automatically:

- `normalizeBrewery` (the matching gate, via `baseNormalize` → diacritic-strip +
  lowercase, then filter against `BREWERY_NOISE`)
- `stripBreweryNoise` (Untappd search-query builder, lowercases the token before
  the set lookup)

New words:

| Word | Language | Note |
|------|----------|------|
| `pivovar`, `pivovary` | Czech / Slovak (+ plural) | proven case (Černá Hora) |
| `brauerei` | German / Austrian | |
| `brasserie` | French / Walloon | |
| `birrificio` | Italian | |
| `brouwerij` | Dutch / Flemish | |
| `bryggeri`, `bryggeriet` | Scandinavian (+ definite form) | |
| `cerveceria` | Spanish | matches `cervecería` after diacritic strip |
| `browary` | Polish plural | `browar` already present |

Explicitly **excluded** as ambiguous (mean "beer", not "brewery", and can be
real name tokens): `cerveza`, `bier`, `piwo`.

## Why this is the whole fix

The Untappd search already returns the correct beer for the diacritic-free
query; only the gate rejects it. Stripping the descriptor (`pivovar`) from the
candidate's normalized brewery makes the alias sets overlap, the existing name
fuzzy (≥0.85) passes, and the beer is matched.

## Scope boundaries (documented, not addressed here)

1. `stripBreweryNoise` lowercases but does **not** strip diacritics, so a
   descriptor written *with* diacritics (e.g. `Cervecería`) is not stripped from
   the **search query**. This is irrelevant to the gate (which strips diacritics
   before the set lookup) and harmless to search (an extra ANDed term only
   narrows results; Untappd usually still matches). Out of scope.
2. Descriptors are matched as whole lowercased tokens, so compound words
   (`brauereigasthof`) are untouched. Acceptable.

## Side effect (accepted)

`normalizeBrewery` also produces the stored `normalized_brewery` column and
drives the `dedupeBreweryAliases` startup job (spec.md brewery-aliases note). On
the next deploy/restart, any two existing catalog rows that now collapse to the
same normalized brewery (e.g. one stored under `Pivovar X`, another under
`X Brewery`) will be **merged**. This is desirable, but it is a data mutation on
startup, not merely a search-behavior change.

## Testing (TDD)

- `src/domain/normalize.test.ts`
  - `normalizeBrewery('Pivovar Černá Hora')` → `'cerna hora'`
  - one assertion per new descriptor (Italian, German, French, Dutch,
    Scandinavian definite form, Spanish post-diacritic, Czech plural, Polish
    plural)
  - `stripBreweryNoise` drops `Pivovar` in any position
- `src/domain/matcher.test.ts` (or `untappd-lookup.test.ts`)
  - brewery hard-gate passes for `Pivovar Černá Hora` ↔ `Cerna Hora Brewery`
    (gate-level / stubbed search result, no live HTTP)

## spec.md update

Append the multilingual descriptors to the brewery-aliases gotcha note
(`spec.md`, brewery-aliases line) and the normalize stop-words description.
