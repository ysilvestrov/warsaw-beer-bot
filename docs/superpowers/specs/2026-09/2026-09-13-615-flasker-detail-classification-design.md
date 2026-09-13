# #615 — Flasker detail-page classification and explicit non-beer badge

**Date:** 2026-09-13  
**Status:** approved  
**Issue:** [#615](https://github.com/ysilvestrov/warsaw-beer-bot/issues/615)  
**Follow-up:** [#623](https://github.com/ysilvestrov/warsaw-beer-bot/issues/623) — extend the explicit non-beer state to the other shop adapters

## Problem and live evidence

On 2026-09-13 the Flasker home page rendered 24 product cards. Running the real
`flasker.parseCards` against that live DOM emitted 17 cards. The seven omitted cards were the six
reported beers plus one glass. At the same time, `Термос для пляшки 0,33мл` was emitted as
`Термос / для пляшки` and therefore reached `/match`, where it could receive a white-circle badge.

The issue's original diagnosis identifies the dominant mechanism but not the whole causal chain:

1. Four beers (`КРАКЕН` ×3 and `Real Smoothie Ale`) reach `parseTitle`, have no volume token, and
   return `null` at the primary volume gate.
2. Two beers (`Сало з часником та перцем` and `LardoMato/Сало з часником`) are rejected earlier:
   the Flasker title-level non-beer regex treats every occurrence of `сало` as food merchandise.
3. The thermos contains a volume and no known non-beer title token, so it passes both gates.

The product pages carry the missing evidence. A live probe of all seven reported products found:

| Product | Product categories | JSON-LD brand | Untappd link |
|---|---|---|---|
| `КРАКЕН з Васабі` | `Томатне` | `Vibrant Pour` | yes |
| `КРАКЕН Tom Yum` | `Томатне` | `Vibrant Pour` | no |
| `КРАКЕН у власному чорнилі` | `Томатне` | `Vibrant Pour` | no |
| `Сало з часником та перцем` | `Томатне` | `Vibrant Pour` | yes |
| `Real Smoothie Ale: Mango, Passion Fruit` | `САУРИ` | `Vibrant Pour` | no |
| `LardoMato/Сало з часником` | `Томатне` | `Vibrant Pour` | yes |
| `Термос для пляшки` | `Сувеніри` | `Flasker` | no |

The current `spec.md` statement that a beer always contains volume and merchandise never does is
therefore false in both directions. Product category is the shop's explicit classification and is
the deciding signal for this adapter.

## Decision

### 1. Build provisional Flasker cards from the listing

Flasker keeps extracting the visible title, product URL, tags and category hint from the three
supported listing shapes. A title is parseable when either a volume or an ABV token supplies the
end boundary of the beer name; when both exist, the earlier token remains the boundary.

The synchronous title and listing-category gates remain useful cheap evidence, but they are no
longer terminal when a card has ABV and a product URL. Such a card becomes provisional and requires
detail-page confirmation. This is what permits a beer named after food (`Сало … 4.5%`) to survive
long enough to reach its authoritative category.

Cards admitted only by the new path are fail-closed: until detail classification succeeds, they
carry `skip = true`. A failed or malformed detail response therefore cannot turn an arbitrary
percent-bearing product into a beer.

Cards that already passed the old volume/title rules remain fail-open on detail failure. The new
network dependency must not remove badges from established Flasker beer cards during a transient
shop failure.

### 2. Hydrate every Flasker candidate before cache lookup

The adapter contract gains an explicit pre-cache detail-hydration mode. `runOverlay` computes each
card's original cache key, then invokes Flasker's detail loader before reading or rendering cached
match results. This ordering has two required properties:

- a cached thermos cannot bypass classification and render its old white-circle result;
- the cache key continues to use the listing identity, preserving the key/read/write invariant
  established by #384 when detail hydration canonicalizes a brewery.

Only Flasker opts into this mode. BeerFreak, Funkyshop and every other adapter keep the existing
miss-only detail hydration behavior.

The Flasker total-pass cap of 20 is removed. The live home grid contains 24 cards and classification
must cover the whole grid. All eligible product URLs are fetched concurrently once; the existing
URL-keyed promise cache deduplicates repeated URLs and re-render passes within the content-script
lifetime. The same response supplies categories, JSON-LD brand and a published Untappd bid, so the
classification adds no second request per product.

### 3. Classify from product categories

`parseProductDetail` extracts WooCommerce product categories only from
`.posted_in a[href*="/product-category/"]` in addition to the existing brand and Untappd-link
fields. Flasker also renders brand links inside `.posted_in`; the URL constraint prevents a brewery
such as `Vibrant Pour` from being mistaken for a product category.

- Any explicit Flasker non-beer category (`Сувеніри`, accessories, merch, snacks, gifts and the
  existing localized category vocabulary) makes the card confirmed non-beer.
- A provisional card is admitted as beer only after a successful detail response contains
  categories and none is a known non-beer category.
- A successful response with no usable category does not confirm a provisional card.
- A failed response records no classification. It never produces the non-beer badge.

This is a negative-category veto, not a closed allowlist of beer styles: Flasker can add a new beer
style without an extension release, while an explicit merchandise category remains decisive.

### 4. Render confirmed non-beer instead of silently dropping it

`Card` gains an explicit confirmed-non-beer state separate from the existing generic `skip` flag.
For Flasker only, `runOverlay` renders that state through the shared badge renderer:

- glyph: `✕`;
- placement and geometry: the existing top-right overlay badge;
- presentation: the incumbent translucent dark badge with a high-contrast red glyph;
- accessibility: `role="img"` and `aria-label="Не пиво"`;
- interaction: no URL, click or auxiliary-click handler, hover treatment, focus target, or pointer
  cursor. The badge has `pointer-events: none`, like other non-interactive status glyphs.

The host card is marked seen after the badge is attached. The card is excluded from `/match`,
enrichment and beer-result cache writes. Refresh removes both badge and seen marker through the
existing `resetCard` path, after which classification runs again.

The red `✕` means only "Flasker explicitly classified this product as non-beer." It must not stand
for a missing match, missing rating, parse failure, or network failure.

Other adapters continue silently excluding non-beer products in #615. Migrating them to the same
contract is deliberately isolated in #623.

## Failure behavior

| Condition | Result |
|---|---|
| Detail category confirms beer | Continue to cache lookup, `/match` and normal badge flow |
| Detail category confirms non-beer | Render non-clickable red `✕`; mark seen; no API or cache write |
| Detail fetch fails for an established volume/title beer | Preserve current fail-open beer behavior |
| Detail fetch fails for a provisional card | No badge and no API call; retry on a later page lifecycle |
| Detail HTML has no usable categories for a provisional card | No badge and no API call |
| Detail HTML has no usable categories for an established beer | Preserve current behavior |

## Claims and their evidence

| Recorded fact | Claim | Evidence required before recording |
|---|---|---|
| `card.nonBeer = true` during Flasker hydration | The product is not beer | Successful product-page response contains at least one category matched by the explicit Flasker non-beer category vocabulary |
| Red `✕` plus `data-beerseen` on a host card | The card was processed and confirmed non-beer | The same `card.nonBeer` classification; badge test proves no link/handlers/focus and overlay test proves no `/match` call |
| Normal match-cache result for a no-volume Flasker card | The product is eligible beer and the result belongs to the listing identity | Product title carries parseable ABV; successful detail response has categories and no non-beer category; cache key was captured from the pre-hydration listing identity |
| `brand`, `bid` and `bidSlug` written onto a card | The product page published those identity signals | Existing JSON-LD brand and Untappd-link parsers applied to the same successful response |

No database row, cursor, coverage range or durable verdict is introduced. The non-beer decision is
page-local DOM state and is re-observed after refresh or a new page lifecycle.

## Tests

The regression tests live with the behavior they protect:

1. `flasker.test.ts`: all six reported no-volume/food-named beers become provisional cards and,
   after beer-category details, retain `VibrantPour` identity and ABV.
2. `flasker.test.ts`: the thermos detail fixture (`Сувеніри`) becomes confirmed non-beer.
3. `flasker.test.ts`: category extraction covers beer and non-beer product metadata; malformed and
   failed details never claim non-beer.
4. `flasker.test.ts`: a pass with 24 unique product URLs attempts all 24, replacing the existing
   20-request cap assertion.
5. `content/index.test.ts`: pre-cache hydration runs before a cached result can render; confirmed
   non-beer renders `✕`, is marked seen, and never reaches `/match`, enrichment or cache writes.
6. `badge.test.ts`: the `✕` badge uses the intended red treatment and accessible label, has no link,
   click/auxclick behavior or pointer cursor, and remains idempotent/resettable.
7. Existing Flasker fixture, conformance, re-render, refresh and normal badge tests remain green.

The RED instrument is the adapter-level test using the six real titles and category responses: on
current `main`, four return no card at the volume gate and two return no card at the title gate.

After implementation, run targeted Flasker/content/badge tests, the extension suite and typecheck,
then the repository full gate: `npm test` and `npm run typecheck` in both package roots.

## Specification and user documentation

Update `spec.md` §6 to replace the volume assertion with the provisional-card and product-category
rules, document pre-cache all-card hydration, remove the 20-card Flasker cap, and add the confirmed
non-beer `✕` badge to the badge state contract.

Under `extension/CHANGELOG.md` `[Unreleased]`, write one user-facing entry led by the visible symptom:
six Flasker beers that lacked package volume now receive their normal badges, while merchandise is
explicitly marked with a red `✕` instead of a misleading white circle.

Update `docs/extension-install-uk.md` so the badge legend explains `✕ = магазин позначив товар як
не-пиво` and states that it is not clickable.

## Scope

Expected core implementation files:

- `extension/src/sites/types.ts`
- `extension/src/content/index.ts`
- `extension/src/content/index.test.ts`
- `extension/src/content/badge.ts`
- `extension/src/content/badge.test.ts`
- `extension/src/sites/flasker.ts`
- `extension/src/sites/flasker.test.ts`

Expected specification and user-facing files:

- `spec.md`
- `extension/CHANGELOG.md`
- `docs/extension-install-uk.md`

The change does not modify the server API, database, enrichment policy, cache schema, other shop
adapters, manifest permissions or Chrome Web Store publishing flow.

Because the implementation plan will exceed four dependent tasks, planning and execution split at
the core/periphery boundary required by `AGENTS.md`: implement and review the parsing/hydration/badge
mechanism first; only then plan the specification, changelog and user-guide updates against the
reviewed core.
