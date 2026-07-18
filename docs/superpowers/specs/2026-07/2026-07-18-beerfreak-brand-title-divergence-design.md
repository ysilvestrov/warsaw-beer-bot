# Extension/BeerFreak: fix brewery duplicated into name on brand/title divergence (#305)

- **Date**: 2026-07-18
- **Issues**: #305 (narrowed to this class during triage). Related: #295 (matcher — `Trillium / Macaroon Macaroon` moved there). Parent: #255.
- **Files**: `extension/src/sites/beerfreak.ts`, `extension/src/sites/beerfreak.test.ts`.

## Problem

BeerFreak product metadata gives each card a `brand_title` and a `title`. The adapter emits
`brewery = cleanBrewery(brand_title)` and derives the beer name via `cleanName`, which strips the
brewery from the title using an **exact case-insensitive prefix match** of `brand_title` against
`title`:

```ts
const prefix = rawTitle.slice(0, b.length);
if (prefix.toLowerCase() !== b.toLowerCase()) return rawTitle.trim();  // <-- gives up, keeps whole title
```

`brand_title` is an uppercased, `(Country)`-suffixed, and often **divergent** form of the brewery,
while `title` renders the brewery in its real display form. When the two differ, the exact-prefix
check fails and `cleanName` returns the **entire title**, so the brewery ends up duplicated inside
the beer name.

Observed in the fixture (`extension/tests/fixtures/beerfreak.html`):

| `brand_title` (→ `cleanBrewery`) | `title` | today's name |
|---|---|---|
| `HOPPY HOG BREWERY (Україна)` → `HOPPY HOG BREWERY` | `Hoppy Hog Family Brewery Tropical Veil NEIPA` | `Hoppy Hog Family Brewery Tropical Veil NEIPA` ✗ |
| `BROKREACJA BREWERY (Польща)` → `BROKREACJA BREWERY` | `Browar Brokreacja NAFCIARZ 19` | `Browar Brokreacja NAFCIARZ 19` ✗ |

Only two brands in the fixture are genuinely divergent: `HOPPY HOG BREWERY` (title inserts
`Family`) and `BROKREACJA BREWERY` (title localizes to `Browar Brokreacja`). Brands whose cleaned
`brand_title` *is* a prefix of the title head — Volta, Rebrew, Kyiv Local, La Superbe, Sparkle, and
even `SHO BREWERY` / `SHO Brewery (IIIO) …` — already take the fast path correctly and must stay
working, as must the slash-collaborator path (`PINTA/Folkingebrew …`).

### Scope note (why #305 is narrow)

Most of #305's original examples are **already fixed** in code by #213 (slash collaborators,
2026-06-26) and #289 (bundle/series rejection, 2026-07-12), both of which postdate the failure
captures (2026-06-19…28). Those are stale rows that clear once the held extension release ships.
Verified against current code: `WORLD CUP SERIES - 8 SPECIAL BEER` and `Дегустаціний сет …` →
`isBeerFreakBundle=true` (rejected); `Winter Break Variety Twelve Pack` → `isNonBeerName=true`
(rejected). The only genuinely-live parser bug is the brand/title divergence above.
`Trillium / Macaroon Macaroon` (beerrepublic) is a matcher concern → **#295**.

## Design

Fix is local to `cleanName` in `beerfreak.ts`. Keep the exact-prefix fast path; add a token-run
fallback for the divergent case.

```ts
// Words that appear as brewery descriptors in a BeerFreak title's leading brewery
// form (structural forms + "family" for "<X> Family Brewery"). Lowercased.
const BREWERY_DESCRIPTORS = new Set([
  'brewery', 'brewing', 'browar', 'brasserie', 'brouwerij', 'brauerei',
  'pivovar', 'birrificio', 'company', 'co', 'co.', 'family',
]);

// Divergent brand_title: strip the leading brewery *run* from the title. Consume
// leading tokens that are brand-core tokens (from brand_title, minus descriptors)
// or brewery-descriptor words; the remainder is the beer name. Returns '' when no
// brand token matched (so a name that merely starts with a descriptor is not eaten)
// or when nothing remains, letting the caller fall back to the full title.
function stripLeadingBreweryRun(rawTitle: string, brewery: string): string {
  const brandCore = new Set(
    brewery.toLowerCase().split(/\s+/).filter((t) => t && !BREWERY_DESCRIPTORS.has(t)),
  );
  if (brandCore.size === 0) return '';
  const tokens = rawTitle.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let i = 0;
  let matchedBrand = false;
  while (i < tokens.length) {
    const t = normalizedToken(tokens[i]); // existing helper: lowercases, strips ( ) ,
    if (brandCore.has(t)) { matchedBrand = true; i += 1; continue; }
    if (BREWERY_DESCRIPTORS.has(t)) { i += 1; continue; }
    break;
  }
  if (!matchedBrand) return '';
  return tokens.slice(i).join(' ').trim();
}
```

`cleanName` becomes:

```ts
function cleanName(rawTitle: string, brewery: string): string {
  const b = brewery.trim();
  if (!b) return rawTitle.trim();

  const prefix = rawTitle.slice(0, b.length);
  if (prefix.toLowerCase() === b.toLowerCase()) {
    // exact-prefix path (also handles leading slash collaborators)
    return stripLeadingCollaborator(rawTitle.slice(b.length))
      .replace(BREWERY_NOISE_PREFIX_RE, '')
      .trim() || rawTitle.trim();
  }
  // divergent brand_title → token-run strip of the leading brewery form
  return stripLeadingBreweryRun(rawTitle, b) || rawTitle.trim();
}
```

### Behavior

- `Hoppy Hog Family Brewery Tropical Veil NEIPA` (brand `HOPPY HOG BREWERY`) → strip
  `Hoppy`(brand) `Hog`(brand) `Family`(desc) `Brewery`(desc) → `Tropical Veil NEIPA`.
- `Browar Brokreacja NAFCIARZ 19` (brand `BROKREACJA BREWERY`) → strip `Browar`(desc)
  `Brokreacja`(brand) → `NAFCIARZ 19`.
- Exact-prefix brands (Volta/Rebrew/Kyiv Local, and `SHO Brewery (IIIO) …` → `(IIIO) Narcissus`)
  and slash collabs (`PINTA/…`) take the fast path, unchanged.

### Out of scope

- The emitted **brewery** stays `cleanBrewery(brand_title)`; a brewery-form mismatch vs Untappd
  (`HOPPY HOG BREWERY` vs `Hoppy Hog Family Brewery`) is a matcher/alias concern, not this PR.
- Brandless / collaborator path (`splitBrandlessTitle`, #213) and bundle rejection (#289) unchanged.

## Testing

Extend `extension/src/sites/beerfreak.test.ts` (Vitest):

- **Divergent brands fixed** (via `parseCards` over `beerfreak.html`, matching by `name`):
  `Hoppy Hog Family Brewery Tropical Veil NEIPA` → `{ brewery: 'HOPPY HOG BREWERY', name: 'Tropical Veil NEIPA' }`;
  `Browar Brokreacja NAFCIARZ 19` → `{ brewery: 'BROKREACJA BREWERY', name: 'NAFCIARZ 19' }`.
- **No regression (fast path)**: an exact-prefix brand (`Volta Brewery MODERN PILSNER` → name
  `MODERN PILSNER`), the paren-alias case (`SHO Brewery (IIIO) Narcissus` → name `(IIIO) Narcissus`),
  and a slash collab (`PINTA/Folkingebrew Hazy Discovery Groningen` → collaborator handling
  unchanged) still parse as before.
- **Guard**: a title whose name legitimately starts with a descriptor but whose brand tokens are
  absent from the head is not over-stripped (token-run returns '' → full-title fallback).

Existing fixture suffices; no new fixture needed.

## Success criteria

- Divergent-brand BeerFreak cards emit a clean beer name with no duplicated brewery.
- All existing `beerfreak.test.ts` cases still pass.
- Change confined to `cleanName` + one new helper + one descriptor set; brewery emission and other
  paths untouched.
