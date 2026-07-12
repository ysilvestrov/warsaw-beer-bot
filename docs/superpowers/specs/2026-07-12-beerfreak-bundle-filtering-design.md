# BeerFreak Bundle Filtering Design

**Issue:** #284  
**Date:** 2026-07-12

## Problem

The BeerFreak adapter emits some bundle products as individual beers. In particular,
the reported `WORLD CUP SERIES - 5 SPECIAL BEER` and `Дегустаціний сет від Honir
Brewery` listings reach orphan enrichment even though neither represents one Untappd
beer.

The adapter already applies the shared `isNonBeerName` filter, but the shared patterns
do not cover these BeerFreak-specific title forms.

## Scope

Add BeerFreak-local bundle detection. Do not change the shared non-beer helper or the
behavior of other shop adapters.

The filter must recognize:

- standalone `set` and Cyrillic `сет` bundle wording, including Ukrainian tasting-set
  titles;
- `mix pack` wording;
- numbered multi-beer series/special-beer constructions such as
  `SERIES - 5 SPECIAL BEER`.

Matching must be case-insensitive and boundary-aware. Incidental substrings inside a
legitimate beer name must not cause rejection.

## Design

Add a small private BeerFreak title predicate alongside the adapter's existing parsing
helpers. `parseCards` will reject a product when either the shared `isNonBeerName`
helper or the BeerFreak-local predicate classifies its raw metadata/DOM title as a
bundle.

Filtering occurs before brewery/name parsing and before detail URLs are registered.
Rejected products therefore never become cards, never trigger ABV detail fetches, and
never reach matching or orphan enrichment.

No registry, manifest, API, storage, or matcher changes are required.

## Testing

Use focused BeerFreak adapter tests with minimal product-card HTML and embedded product
metadata. Tests will first reproduce the reported English and Ukrainian examples, then
cover `mix pack` and boundary-sensitive false-positive guards for legitimate beer
titles.

Run the focused BeerFreak test file during the red/green cycle. After implementation,
run the full extension test suite, typecheck/build commands defined by the extension,
and `git diff --check`.

## Documentation

Update `spec.md` section 6 to state that BeerFreak locally rejects tasting sets and
multi-beer packs. Update `extension/CHANGELOG.md` in the same change, as required for
browser-extension modifications.
