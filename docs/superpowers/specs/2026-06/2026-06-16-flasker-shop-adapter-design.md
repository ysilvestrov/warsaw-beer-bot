# Flasker shop adapter — design

- **Issue:** #86 "Add Flasker to the supported shops" (https://flasker.com.ua/)
- **Date:** 2026-06-16
- **Scope:** A new browser-extension `SiteAdapter` for `flasker.com.ua`. Server,
  bot, and matching layers are unchanged.

## Context

Flasker is a Ukrainian craft-beer shop on **WooCommerce / WordPress**, mostly
server-rendered. The user wants three browsing surfaces badged:

| # | View | URL | DOM shape | Render |
|---|------|-----|-----------|--------|
| 1 | "All Products" block (home/store) | `/`, `/store/` | `li.wc-block-grid__product` | client (Store API) |
| 2 | Classic grid / archives | `/1-2/`, `/product-category/*`, `/product-tag/*` | `li.product` + `h2.woocommerce-loop-product__title` | SSR |
| 3 | Barn2 product table | `/таблиця-товару/` | `tr.wpt_product_table` (`data-title`, `data-href`, `data-product_tag`, `data-product_cat`) | SSR |

The FiboSearch results page (`/?s=…`, `dgwt-wcas`, ajax) renders into one of the
above shapes once hydrated; it is covered implicitly, not as a fourth path.

Two facts about the rest of the system shape this design:

- **Matching is tolerant and brewery-led.** `matcher.ts` buckets candidates by
  the brewery's first token and gates on a **leading-prefix** comparison
  (`breweryAliasesMatch`). An over-captured brewery (e.g. `Vibrant Pour Frost &
  Flame`) still matches catalog `Vibrant Pour` because the catalog alias is a
  prefix of the input. `normalize.ts` strips style words, brewery-noise,
  diacritics, and numeric noise. So the brewery/name split need not be perfect —
  it only needs the true brewery token(s) at the **start** of the brewery field.
- **Flasker already paints its own badge.** A `madbrew-untappd-analytics` plugin
  shows a yellow **global** Untappd rating (`.mbua-untappd-badge`) at each card's
  top-left. Our extension adds the **personal** seen-marker (⚪/⏳/⭐) + catalog
  enrichment — distinct value — but our overlay must not visually collide.

## Title format

All three views expose the same title string:

```
<BREWERY> <beer name> [– <style>] <ABV>% <volume>
```

The brewery is the **leading token(s)**; the beer name follows; a style may
trail (sometimes after a dash). The dash, where present, separates **name from
style** — it is *not* a brewery/name boundary. A style word is also not a
brewery/name boundary: some breweries name beers purely by style.

Real examples (the TDD corpus), annotated brewery · name · style:

- `Burgomistr NEIPA 6% 500ml`               (Burgomistr · — · NEIPA — beer named by style)
- `VOLTA CHARISMA+1 IPA 5.1% 0.33л`          (VOLTA · CHARISMA+1 · IPA)
- `REBREW Труханів Острів SIPA 4,3% 330ml`   (REBREW · Труханів Острів · SIPA)
- `JAGER БОГЕМНИЙ МІЦИК ІРА 5.1% 500ml`       (JAGER · БОГЕМНИЙ МІЦИК · ІРА)
- `Ципа 380 – Triple IPA 7.9% 500ml`         (Ципа · 380 · Triple IPA — dash before style)
- `ШО (IIIO) Totem IPA 6% 0.33l`             (ШО (IIIO) · Totem · IPA — multi-word brewery)
- `Orval {2025} 330ml`                       (no ABV; name ≈ brewery)
- `Barely Beer 0% ABV 330ml`
- `Vibrant IS 9° 330ml`                       (`°` = gravity, not ABV)
- `Vibrant Pour Frost & Flame Imperial Porter 10% 0.33`  (bare-decimal volume, no unit)

Mixed Latin/Cyrillic; comma decimals (`4,3%`); volume units `ml` / `мл` / `l` /
`л`, sometimes a **bare litre decimal** (`0.33`) with no unit.

## Architecture — one adapter, three parse paths

`extension/src/sites/flasker.ts` exports a single `SiteAdapter`:

- `id: 'flasker'`
- `hostMatch(url)` → `url.hostname === 'flasker.com.ua' || endsWith('.flasker.com.ua')`
- `parseCards(root)` — queries the three card selectors, unions the results, and
  routes each element through one shared title→card pipeline. The card element
  (`li` / `tr`) is the badge anchor.
- `waitForGrid(root)` — resolves once any of the three card selectors yields a
  node, with a timeout. Instant on SSR views 2/3; covers view 1's client
  hydration.
- **No `reRenderContainerSelector`** — the three views have different containers;
  global re-render is always on, so it is omitted (per the adapter runbook).

### Title → `{ brewery, name, abv }`

1. **Volume** — find the volume token (see gate below).
2. **ABV** — parse `\d+([.,]\d+)?\s*%` if present (`°` is ignored — it is
   gravity, not ABV). Comma decimals normalised to `.`.
3. The **head string** = the title with its trailing ABV-and-volume tail
   removed; the tail begins at whichever of ABV or volume appears first
   (ABV usually precedes volume, e.g. `… 6% 500ml`).
4. **brewery / name split** of the head string. Default: **brewery = first
   whitespace token**, name = the remainder. Neither the dash/`|` nor a style
   word is used as the boundary (the dash precedes a *style*; some beers are
   named by style). The matcher's leading-prefix gate is **symmetric**, so this
   is safe even for multi-word breweries that under-capture: input `vibrant` is
   still a prefix of catalog `vibrant pour` (same first-token bucket, gate
   passes). A small set of known multi-word/parenthetical breweries
   (`Vibrant Pour`, `ШО (IIIO)`, …) may be promoted to a two-token brewery where
   it cleanly improves the name; TDD decides per the corpus. The Barn2 table's
   `data-product_tag` brewery name is a **bonus hint** where present, not the
   primary path.

The exact heuristic — including multi-word-brewery handling and the
parenthetical case — is finalised by TDD against the corpus above.

## Non-beer filtering (mandatory)

Flasker sells snacks (sauces `ВИТРЕБЕНЬКИ`, salo `Золота Сота`, dried mushrooms
`GribLan`, `ШКВАРКА`), sets, and glassware/merch. Mixed pages (e.g.
`/?s=сало`) interleave beers and snacks. A card is dropped unless it passes all
three checks:

1. **Primary positive gate — volume required.** Keep a card only if its title
   contains a volume token:
   - unit-bearing: `\d+\s*(ml|мл|l|л)\b` (e.g. `330ml`, `0.33л`, `500 мл`), **or**
   - bare litre decimal: `\b0[.,]\d+\b` **not** immediately followed by a weight
     unit (`кг|g|г|gr`).
   No volume ⇒ non-beer. This is the workhorse: snacks/sauces/salo/merch carry no
   volume.
2. **Secondary token gate.** `isNonBeerName(name)` (shared `src/sites/non-beer.ts`)
   plus Flasker-local tokens matched on the title — `набір`, `сет`/`set`,
   `келих`/`glass`, `сувенір`/`souvenir`, `мерч`/`merch`, `сертифікат`, `соус`,
   `сало`, `гриб`, `шкварк`, `снек`/`snack`/`закуск`. Catches sets/glassware that
   *do* quote a volume.
3. **Table-view category** (view 3 only). Drop rows whose `data-product_cat`
   name hits the snack/merch token set (extra reliable signal where available).

No structural assumption beyond "every Flasker beer title carries a volume",
which holds across the observed catalog and is the shop's consistent naming
convention.

## Fixtures & tests

Fixtures under `extension/tests/fixtures/`:

- `flasker.html` — **canonical** conformance fixture = view 2 SSR archive
  (`curl`). Most representative; drives the registry conformance suite.
- `flasker.table.html` — view 3 (`curl`), used by the bespoke test.
- `flasker.block.html` — view 1, captured **rendered** via Playwright (new
  `extension/scripts/capture-flasker-fixture.ts`, adapted from
  `capture-omb-fixture.ts`).
- `flasker.nonbeer.html` — only non-beer products (snacks/sets/merch, `curl`).
  Conformance requires `parseCards → []`.

Tests:

- **Conformance** (`src/sites/conformance.test.ts`) — automatic once registered:
  fixture exists, ≥1 well-formed card, non-beer fixture → `[]`, re-badge after
  grid replacement.
- **Bespoke** (`src/sites/flasker.test.ts`) — quirks only:
  - title split on the full corpus (incl. dash, `|`, multi-word brewery,
    Cyrillic, `Orval`-style name≈brewery);
  - ABV/volume parsing: `ml`/`мл`/`l`/`л`, comma decimals, bare-decimal volume,
    `°` ignored, weight-unit decimals (`0.5кг`) **not** treated as volume;
  - all three views parse (block + table fixtures);
  - table-view `data-product_cat` drop;
  - non-beer FP guard: a real beer survives alongside merch in one grid.

## Registry, manifest, docs

- Register `flasker` in `extension/src/sites/registry.ts` (`ADAPTERS`).
- Add to `content_scripts[].matches` in `extension/manifest.config.ts`:
  `https://flasker.com.ua/*`, `https://*.flasker.com.ua/*`.
- **Update `docs/extension-install-uk.md`** — add Flasker to the supported-shops
  list (required by CLAUDE.md for every user-facing extension change).
- Check `spec.md` supported-shops references and update in the same PR if needed.

## Out of scope

- Server/bot/matching changes.
- Dedicated FiboSearch-dropdown DOM support (results page is covered via the
  three shapes once hydrated).
- Mitigating the native `.mbua-untappd-badge` beyond a placement check in the
  real-browser verification step (nudge our badge position only if it collides).

## Verification

Runbook (`docs/adapter-authoring.md`) step 9: load 1–2 of each view in a real
browser; confirm seen-markers appear on first load, survive pagination/filter,
and do not overlap the shop's native yellow badge.
