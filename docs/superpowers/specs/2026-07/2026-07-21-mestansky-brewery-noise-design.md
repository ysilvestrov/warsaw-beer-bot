# "Měšťanský pivovar" brewery-gate reconciliation

**Issue:** follow-up from #321 deploy (2026-07-21). Recurring Czech brewery-gate miss.
**Date:** 2026-07-21
**Scope:** Brewery hard-gate only. Restore the strict brewery match for orphans whose Untappd
brewery is `Měšťanský pivovar <place>` while the shop lists just `<place>`.

## Problem

`breweryAliasesMatch` reduces to a **leading-prefix** token match (`matcher.ts` `aliasFirstToken` /
`tokenPrefix`): the shorter alias's tokens must be a leading prefix of the longer's. Czech "burgher's
breweries" file on Untappd as `Měšťanský pivovar <place>`, so the leading `mestansky` token blocks
the shop's bare `<place>` from ever matching. Verified — all 9 affected orphans return `strict=false`:

| Untappd (normalizeBrewery) | shop (normalizeBrewery) | orphans |
|---|---|---|
| `mestansky havlickuv brod` | `havlickuv brod` | 12246 |
| `mestansky kojetin` | `kojetin` | 12271, 29971 |
| `mestansky kutna hora` | `kutna hora` | 30095 |
| `mestansky v policce` | `policka` | 11993, 12198, 25630, 30206, 32458 |

`Měšťanský pivovar` ("burgher's/civic brewery") is a generic Czech brewery-type descriptor — the same
category as the `pivovar` / `browar` / `brewery` tokens already in `BREWERY_NOISE`. An Untappd search
for the word returns ~15 breweries, so this is a broad, recurring pattern, not a one-off.

## Design

Two small changes.

### 1. `mestansky` → `BREWERY_NOISE` (`src/domain/normalize.ts`)

Add the diacritic-stripped token `mestansky` to `BREWERY_NOISE`. It is stripped everywhere brewery
noise is (normalizeBrewery, stripBreweryNoise, cleanSearchQuery, stripBreweryFromName), so both sides
reduce to the place name:

- `Měšťanský pivovar Havlíčkův Brod` → `havlickuv brod` == shop `havlickuv brod` → strict ✅
- `Měšťanský pivovar Kojetín` → `kojetin` == `kojetin` → strict ✅
- `Měšťanský pivovar Kutná Hora` → `kutna hora` == `kutna hora` → strict ✅

Generic and future-proof: distinguishes the ~15 breweries by their (distinct) place names, so there
is no false-merge risk — two `Měšťanský pivovar X`/`Y` still differ by `X`/`Y`. Rescues the four
**nominative-place** orphans (12246, 12271, 29971, 30095).

### 2. Curated alias `['policka', 'v policce']` (`src/domain/brewery-aliases.ts`)

The Polička cluster additionally fails because Untappd uses the Czech **locative declension**
`v Poličce` while the shop lists `Polička`. After the noise strip the Untappd side normalizes to
`v policce` and the shop to `policka` — a genuine place-name equivalence (not a generic descriptor),
so it belongs in the curated non-transitive alias layer. Precedent: `bracki zamkowy w cieszynie`
keeps a preposition token. One pair covers all five shop spellings (`Polička Brewery`,
`Pivovar Policka Brewery`, `Měšťanský Pivovar Polička Brewery` all → `policka`). Verified with
`npm run alias-key`. Rescues 11993, 12198, 25630, 30206, 32458.

## The brewery gate is only half of a match

Restoring the strict gate does not guarantee a name-stage match. Per the #329 practice, each of the
9 orphans is verified **end-to-end against its real `enrich_failures` candidates** (brewery gate AND
name stage); only the ones that actually resolve are re-armed. Expected interactions:

- Grade/degree names (`Otakar 11`, `Zlata 12`, `Rebel 12`, `Hradební 10°`) land on the now-deployed
  #321 grade stage once the brewery gate passes.
- Pale/dark pairs (`Hradební světlé` vs `tmavé`) rely on #321's dark exclusion.
- Any orphan that still misses at the name stage after the gate opens is **flagged, not forced** —
  it routes to name-stage work (#319) or a future batch, not this change.

## Testing

- `normalize.test.ts`: `normalizeBrewery('Měšťanský pivovar Kutná Hora')` → `'kutna hora'`; confirm a
  non-noise brand token is untouched.
- `brewery-aliases.test.ts` / `matcher` alias test: `['policka','v policce']` pair present and
  `breweryAliasesMatch` passes shop↔Untappd Polička forms.
- `untappd-lookup` end-to-end tests for the representative orphans using their real candidate strings
  (nominative Kutná Hora → grade match; Polička declension → gate opens).

## Deploy / re-arm

After merge + deploy, re-arm the orphans that verify as full matches (reset
`untappd_lookup_count`/`untappd_lookup_at` as the `warsaw-beer-bot` user). Several already have
`untappd_lookup_count = 0` (eligible; retry when on tap) — re-arm only the backed-off ones.

## Out of scope

- Non-Měšťanský brewery-alias gaps (e.g. the `kamenica`↔`kamenice` pair from #321) — separate.
- Name-stage divergence that survives the gate (#319 / future batches).
- Stripping the bare preposition `v` globally — kept inside the curated alias form instead.
