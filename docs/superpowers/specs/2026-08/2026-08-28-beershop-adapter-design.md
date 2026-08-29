# Beershop Browser Extension Adapter Design

**Date:** 2026-08-28

## Goal

Add Beershop to the browser extension without sending the shop's soft drinks, functional drinks, gifts, merchandise, snacks, or spirits to the beer matcher.

## Supported storefronts

One adapter, `beershop`, supports the language storefronts at `beershop.pl`, `beershop.cz`, `beershop.sk`, `beershop.eu`, and `beershop.de`. Apex hosts, `www`, and other subdomains match; lookalike hosts outside those base domains do not.

All five hosts use the same UPgates SSR card structure. The adapter reads `article.card-item[data-product-id]`, takes the brewery from `.p-i-header strong`, and treats the remaining header text as the product name. A degree token such as `12°` is Plato/extract and remains part of the name; it is never emitted as ABV.

## Non-beer boundary

The adapter uses three complementary gates:

1. `isNonBeerPage(url)` recognizes localized category paths for lemonades/cola/tonics, functional drinks and kombucha/shot categories, gifts/vouchers/merch/openers/packaging, snacks, and the Czech/Slovak spirits category.
2. `parseCards(root)` reads the stable UPgates category ID from the owning document. This protects pagination, filters, and scoped grid re-renders whose URL is not the exact category root.
3. `isNonBeerName` rejects shared product-level gift/set/pack names that appear in otherwise eligible grids.

The route and category-ID gates deliberately preserve cider, alcohol-free beer/radler pages, and kvass. The legacy Polish and Czech `/limonady-1` kombucha category is also excluded because it belongs to the storefront's functional/non-beer taxonomy and publishes category ID `263`.

Search pages do not publish per-card category identity. The adapter does not guess category membership from ambiguous flavor or brand words because that could hide real beers. This limitation remains a documented residual risk unless the storefront exposes a stable per-product category signal in listing markup.

## Integration

Register the adapter in `extension/src/sites/registry.ts` and add match patterns for all five domains to `extension/manifest.config.ts`. Keep the current adapter interface and overlay flow; no new dependency or architectural layer is needed.

## Tests and evidence

Capture live Polish beer-catalog and lemonade/cola HTML fixtures. Focused tests must prove host matching, live card parsing, every localized non-beer route, stable category-ID rejection, scoped re-render category lookup, shared gift-pack filtering, and eligible cider/alcohol-free/kvass routes. Registry, manifest, and adapter conformance tests cover integration.

Before handoff, run the full extension test suite, TypeScript typecheck, production build, and a live Chromium check. The browser check must show badges on the live beer catalog and zero badges on a live non-beer category.

## Documentation

Update `spec.md`, both extension installation guides, and `extension/CHANGELOG.md` in the same change.
