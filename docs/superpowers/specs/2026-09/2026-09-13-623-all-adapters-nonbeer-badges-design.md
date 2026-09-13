# #623 — explicit non-beer badges across shop adapters

**Date:** 2026-09-13
**Status:** approved
**Issue:** [#623](https://github.com/ysilvestrov/warsaw-beer-bot/issues/623)
**Depends on:** [#615](https://github.com/ysilvestrov/warsaw-beer-bot/issues/615), merged in #626

## Problem

Flasker now returns shop-confirmed non-beer cards through `Card.nonBeer` and the overlay renders a
non-clickable red `✕`. The other nine adapters still discard products as soon as an existing
adapter-specific rule recognizes them as merchandise, food, a soft drink, a pack, or another
non-beer. A user therefore cannot distinguish that deliberate classification from a parsing
failure or a missing rating.

The change must expose decisions the adapters already make. It must not broaden or reinterpret
their classification rules, and it must not turn missing identity, missing metadata, or a network
failure into a non-beer claim.

## Decision

### 1. Reuse the `Card.nonBeer` contract from Flasker

Each adapter returns a `Card` with `nonBeer: true` and `skip: true` when one of its current,
deterministic per-card non-beer rules matches. The adapter keeps the product element and may leave
`brewery` and `name` empty because confirmed non-beer cards never participate in matching,
enrichment, or the match cache.

`runOverlay` checks `card.nonBeer` before computing a normalized cache key. It renders the shared
red `✕`, marks the host element seen, and continues without a cache read or API call. Normal cards
retain their current cache-key and hydration ordering, including Flasker's pre-cache detail
classification.

An alternative `parseNonBeerCards()` adapter method was rejected because it would require every
adapter to repeat its card selector and classification loop. Central classification was also
rejected because the evidence is shop-specific and already lives next to each parser. Reusing the
existing card state changes the smallest shared surface and preserves ownership of classification.

### 2. Preserve every existing classification rule

Only the output of a positive per-card rule changes:

| Adapter | Existing evidence that now produces `nonBeer` |
|---|---|
| BeerRepublic | shared `isNonBeerName` match on the visible product title |
| OneMoreBeer | shared non-beer name, local merch or soft-drink token, or the ABV/style-guarded non-alcoholic soft-drink-family rule |
| BeerFreak | shared non-beer name, local bundle rule, or numbered multi-beer-series rule |
| Bierloods22 | existing package-title rule on visible or published title |
| WineTime | shared `isNonBeerName` match on the published or visible title |
| Hoptimaal | existing per-product collection URL under Beer Club, merch, spirits, bundles, or packages |
| Piwne Mosty | published metadata outside its eligible beer/drink categories, shared non-beer name, or local non-beer title token |
| Funkyshop | shared non-beer name or the local set/glassware/merch/deposit rule in the title or description |
| Beershop | shared `isNonBeerName` match on the parsed visible identity |

An adapter still silently omits a card when required DOM is absent, a beer identity cannot be
parsed, or no positive non-beer rule matched. Such omissions remain unknown, not confirmed
non-beer.

### 3. Keep whole-page non-beer gates silent

The user selected the existing behavior for whole-page non-beer categories. `isNonBeerPage(url)`
continues preventing the overlay from starting on known merchandise, snacks, soft-drink, or other
non-beer routes. Equivalent whole-page metadata gates, such as Beershop's category id, continue
returning no cards. The extension does not fill those pages with `✕` badges.

The distinction is intentional:

- a non-beer card found inside an otherwise processed grid gets `✕`;
- a page that is wholly outside the beer overlay's scope stays untouched.

This also preserves the existing safeguards that avoid broad page skips when a category can mix
eligible cider, mead, kvass, or beer with accessories.

### 4. Rendering and re-render behavior stay shared

All adapters use the `setNonBeer` renderer introduced by #615:

- glyph `✕` in the standard top-right badge position;
- high-contrast red glyph on the incumbent dark badge background;
- `role="img"` and `aria-label="Не пиво"`;
- no Untappd URL, focus target, click, mouseup, or auxiliary-click behavior;
- `pointer-events: none` and the default cursor.

The host card receives `data-beerseen` after the badge is attached. The standard observer therefore
does not repeatedly process it, while replacement DOM nodes are classified and badged normally.
The existing refresh flow removes the badge and seen marker and lets the adapter classify the card
again.

## Failure behavior

| Condition | Result |
|---|---|
| Existing deterministic per-card non-beer rule matches | Render `✕`, mark seen, do not read/write match cache or call `/match`/enrichment |
| Required title, brewery, metadata, or DOM is missing without a positive non-beer signal | Omit silently; do not claim non-beer |
| Card is a valid beer | Preserve existing cache, `/match`, enrichment, and badge flow |
| URL or metadata identifies a whole non-beer page | Keep the page untouched |
| Adapter parse or network operation fails | Preserve current fail-safe behavior; never infer `nonBeer` from failure |
| Grid is replaced | Classify fresh nodes and render `✕` again where applicable |

## Claims and their evidence

| Recorded fact | Claim | Evidence required before recording |
|---|---|---|
| `card.nonBeer = true` | This individual product is not beer | One of that adapter's pre-existing deterministic per-card rules matched shop-published title, description, category, style/ABV, or URL evidence |
| Red `✕` plus `data-beerseen` | The product was processed and confirmed non-beer | The same `card.nonBeer` state; overlay tests prove no cache/API/enrichment path runs |
| No overlay on a whole non-beer page | The entire route/category is outside overlay scope | Existing `isNonBeerPage` or whole-page metadata gate; this change does not add or broaden one |

No database state, durable cache entry, cursor, coverage range, or server-side verdict is added.
`nonBeer` remains page-local DOM state and is recomputed after refresh or a new page lifecycle.

## Tests

1. Update each adapter's focused tests so its existing non-beer cases return confirmed non-beer
   cards rather than `[]`, while false-positive guards and malformed-card behavior stay unchanged.
2. Update adapter conformance so every `<id>.nonbeer.html` fixture yields one or more cards and all
   are `nonBeer + skip`; retain an explicit path for documented no-non-beer exemptions if one is
   added later.
3. Add conformance-level overlay assertions that non-beer fixtures render `✕`, receive
   `data-beerseen`, and make no `/match` call.
4. Extend content tests to prove the non-beer branch runs before cache-key calculation and performs
   no cache read/write, matching, or enrichment.
5. Keep the shared badge accessibility and interaction tests from #615 as the single renderer
   contract; do not duplicate them per adapter.
6. Preserve whole-page gate tests: known non-beer routes and Beershop's whole-page category metadata
   still produce no overlay.
7. Run targeted site/content/conformance tests, then the extension and repository full gates:
   `npm test` and `npm run typecheck` in both package roots, plus the extension production build.

## Specification and user documentation

- Update `spec.md` §6 so adapters return confirmed per-card non-beers for the shared `✕` state while
  whole-page gates remain silent.
- Update `docs/adapter-authoring.md` so new adapters follow the same contract and their non-beer
  fixtures assert explicit classification instead of an empty parse.
- Update `docs/extension-install-uk.md` to remove the Flasker-only qualification from the badge
  legend and token-free behavior description.
- Add one user-facing `[Unreleased]` changelog entry: non-beer products mixed into supported shop
  listings now show a red, non-clickable `✕` instead of appearing unprocessed.

## Scope

Expected implementation files are the nine adapter modules and their focused tests,
`extension/src/content/index.ts`, its tests, and `extension/src/sites/conformance.test.ts`.
Expected documentation files are `spec.md`, `docs/adapter-authoring.md`,
`docs/extension-install-uk.md`, and `extension/CHANGELOG.md`.

The change does not alter Flasker's classification, any shop's non-beer vocabulary, whole-page
gates, server APIs, database state, cache schema, extension permissions, or Chrome Web Store
publishing.

Because the implementation spans the shared overlay contract, nine adapters, tests, and
documentation, planning must follow the repository's large-change rule: first implement and review
the core contract plus adapters, then write a separate periphery plan for specification and
user-facing documentation against the reviewed core.
