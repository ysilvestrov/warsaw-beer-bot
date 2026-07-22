# Search-query noise cleanup — non-decimal periods + calendar years

**Issue:** #295 (`matcher-bug`, tier-1). Auto-filed from orphan-triage.
**Date:** 2026-07-22
**Scope:** Enrichment **search-query building only** — `cleanSearchQuery` in `src/domain/normalize.ts`. No change to the matching normalization (`normalizeName`/`stripSearchNoise`), the brewery gate, the name-matching stages, or the live `/match` path.

## Problem

Some orphans return **zero candidates** from the Untappd (Algolia) search even though the beer is
indexed, because the query carries two kinds of token noise that Algolia mishandles. Confirmed by
live replay of the real failing queries (2026-07-22):

### 1. Non-decimal periods poison the query

Untappd sometimes stores a glued token — e.g. the record `Lee Hill Series Vol.30  Wild Christmas…`
(**no space** after `Vol.`) tokenizes to `vol30`. The shop query `… Vol. 30 …` keeps the period, and
Algolia then fails to reconcile the standalone `30`, returning **0**. Deleting the period so the
query reads `… Vol 30 …` returns the exact beer in one shot:

| beer_id | query as-is → hits | period-deleted → hits |
|---|---|---|
| 31794 | `Upslope Lee Hill Vol. 30 Wild Christmas Ale With Tropical Fruit` → **0** | `Upslope Lee Hill Vol 30 Wild Christmas Ale With Tropical Fruit` → **1** (exact) |
| 31020 | `Revolution Peach Brandy Barrel D.B.V.S.O.J.` (kept) | `… Barrel DBVSOJ` → **2** (exact) |

Deleting periods must **not** convert them to spaces: `V.S.O.J.` → `VSOJ` returns hits, but
`V S O J` returns 0. It must also **preserve decimal version/strength tokens**: `3.0` must not
become `30`. The rule is therefore *delete a period unless it sits between two digits*
(`/(?<!\d)\.|\.(?!\d)/g` → `''`), which also correctly glues `Vol.`→`Vol`, `V.S.O.J.`→`VSOJ`,
`D.B.V.S.O.J.`→`DBVSOJ`, while keeping `3.0`.

### 2. A trailing calendar-year token over-constrains

Algolia ANDs every term, so a bare vintage year requires an indexed name containing that exact year.
Untappd stores vintages parenthetically (`(2019)`) or only for some years, so the year zeroes the
search:

| beer_id | query as-is → hits | year-stripped → hits |
|---|---|---|
| 33075 | `Perennial Vanilla Bean Abraxas 2025` → **0** | `Perennial Vanilla Bean Abraxas` → **11** |
| 31024 | `Revolution Mineshaft Gap 2026` → 0 | `Revolution Mineshaft Gap` → **5** (incl. exact) |

The matcher already discards years for **matching** (`normalizeName`→`isNumericNoise`) and uses
`extractYear` only to *prefer* a same-vintage candidate. So removing the year from the **query** is
consistent: we stop searching for a term we already treat as non-identity. Rule: strip standalone
`(19|20)\d{2}` tokens (`/\b(?:19|20)\d{2}\b/g` → `' '`), mirroring `extractYear`'s year definition.

## Why query-only (critical placement)

`stripSearchNoise` is shared by `cleanSearchQuery` (query) **and** `normalizeName` (matching). If the
period-delete lived in `stripSearchNoise`, the candidate's `Vol.30` would normalize to `vol30`
instead of today's `vol` (baseNormalize turns `.`→space), diverging from the input's `vol` and
dropping the match fuzzy below the 0.85 gate. Verified with the project's `fast-fuzzy`: with matching
normalization **unchanged**, input vs candidate = **0.8824** (matches ✅). So both cleanups live in
`cleanSearchQuery` only; matching normalization is untouched and cannot regress.

The year-strip is idempotent for matching regardless (`isNumericNoise` already drops all digits), but
we keep it in `cleanSearchQuery` too for a single, clearly query-scoped change.

## What is explicitly NOT in scope (issue hypotheses refuted by the evidence)

1. **Brewery-alias-table entries** (Revolution, Trillium, Perennial, Upslope, Almanac). Not needed:
   each shop short-name is already a leading token-prefix of the Untappd canonical after
   `normalizeBrewery` noise-strip, so `breweryAliasesMatch`/`tokenPrefix` already passes. Aliases feed
   the *candidate gate*, not the query. (The issue's "Almanac Beer Co." guess is wrong — Untappd's
   brewery is literally `Almanac`.)
2. **Apostrophe / hyphen normalization.** Live replay returns exact hits today (`Coup D'Etat` → 3,
   `X-Hero Juicy Rush IPA` → 1). Those rows are stale (last failed 2026-06-28, VPS IP-block window) —
   re-arm, not code.
3. **Progressive query-shortening / retrieval-vs-matching decoupling.** Investigated and dropped: the
   Upslope zero was the *period*, not query length — period-deletion fixes it one-shot, so the
   shortening machinery (a `lookupBeer` refactor, extra Algolia calls, larger FP surface, and a #271
   head-retry ordering hazard) buys nothing the two deterministic cleanups don't. YAGNI.

## Design

One function changes: `cleanSearchQuery` (`src/domain/normalize.ts`). Introduce a small query-only
helper and apply it to the cleaned brewery and name strings before tokenization.

```ts
// Query-only token cleanup (NOT used by normalizeName, so matching is unchanged):
//  - delete a period unless it sits between two digits: "Vol." -> "Vol", "V.S.O.J." -> "VSOJ",
//    keep "3.0". Deleting (not spacing) is required — "V S O J" zeroes Algolia, "VSOJ" hits.
//  - strip standalone calendar-year tokens (19xx/20xx): Algolia ANDs terms and Untappd stores
//    vintages parenthetically, so a bare year over-constrains to zero.
export function stripQueryTokenNoise(s: string): string {
  return s
    .replace(/(?<!\d)\.|\.(?!\d)/g, '')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

In `cleanSearchQuery`, wrap the existing `stripSearchNoise` outputs:

```ts
const cleanBrewery = stripQueryTokenNoise(stripSearchNoise(stripLegalForm(brewery)));
const cleanName    = stripQueryTokenNoise(stripSearchNoise(name));
```

Everything downstream (brand-token dedup, name-token filtering, leading/trailing brewery-run
stripping, non-empty fallback) is unchanged.

## Tests (TDD)

`src/domain/normalize.test.ts` — new `stripQueryTokenNoise` and `cleanSearchQuery` cases:

- Period glue: `cleanSearchQuery('Upslope','Lee Hill Vol. 30 …')` → query contains `Vol 30` (no `Vol.`).
- Abbreviation glue: `cleanSearchQuery('Revolution',"Peach Brandy Barrel D.B.V.S.O.J.")` → `DBVSOJ`.
- Decimal preserved: `stripQueryTokenNoise('Stópka 3.0')` keeps `3.0` (not `30`).
- Year strip (trailing): `cleanSearchQuery('Perennial','Vanilla Bean Abraxas 2025')` → no `2025`.
- Year strip (parenthetical, via stripSearchNoise unwrap): `cleanSearchQuery('Revolution','Mineshaft Gap (2026)')` → no `2026`.
- Non-year number kept: `stripQueryTokenNoise('Pinta 555')` keeps `555`.
- No-op safety: a clean name (`cleanSearchQuery('Almanac','Sunshine Sherbet')`) is unchanged.

`src/domain/matcher.test.ts` — regression guard that matching normalization is untouched: a fixture
whose candidate name contains `Vol.30` still matches the shop `Vol. 30` name via the existing fuzzy
path (documents that period-delete did **not** leak into `normalizeName`).

## Ops follow-ups (not code; executed separately, after deploy)

1. **Re-arm** the ~138 stale 0-candidate `matcher_bug` orphans (incl. the Revolution cluster) via
   `rearm-matcher-bug-orphans` (`--ids` mode, #326/#336).
2. **Reclassify** `33045 Almanac / Sunshine Sherbet` → `not_on_untappd` (Untappd only has "Sunset
   Sherbet"). `32682 Nepomucen / Niunia 2026` gets candidates after year-strip but they are
   name-divergent (`Niucon Niunia`) — stays not_found on the name stage; leave as-is.

## Success criteria

- After deploy + re-arm: `31794 Upslope / Lee Hill Vol. 30 …` and `33075 Perennial / Vanilla Bean
  Abraxas 2025` both match; the `D.B.V.S.O.J.`/`V.S.O.J.` Revolution rows match.
- No regression in `normalize.test.ts` / `matcher.test.ts` / `untappd-lookup.test.ts`.
- `spec.md` reviewed for whether the search-query-noise section needs the two cleanups documented;
  update in the same PR if so.
