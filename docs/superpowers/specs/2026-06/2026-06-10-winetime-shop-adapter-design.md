# WineTime Shop Adapter Design

## Goal

Add WineTime (`winetime.com.ua`) as a supported browser-extension shop for issue #88. The extension should parse WineTime beer catalog cards, send stable brewery/name pairs through the existing match flow, and render badges using the shared overlay behavior.

## Scope

In scope:

- Add a `winetime` `SiteAdapter`.
- Capture a static WineTime beer-category fixture.
- Register the adapter and add manifest host matches.
- Add focused adapter, registry, manifest, and conformance coverage.
- Update `extension/CHANGELOG.md` and `spec.md`.

Out of scope:

- Backend or API changes.
- WineTime-specific matching behavior.
- ABV parsing from WineTime catalog cards.
- Custom re-render or pagination machinery.

## Architecture

WineTime support follows the existing per-site adapter architecture in `extension/src/sites/`. The adapter id is `winetime`, matching `extension/tests/fixtures/winetime.html`.

The adapter is SSR-style:

- `hostMatch` accepts `winetime.com.ua` and subdomains.
- `parseCards` reads visible `a.product-micro` cards.
- `waitForGrid` is omitted.
- `reRenderContainerSelector` is optional and only used if the fixture exposes a stable product-grid container.

No shared extension behavior changes are needed. The existing overlay, cache, background worker, and `POST /match` contract remain unchanged.

## Data Flow

1. The content script runs on WineTime pages through manifest matches.
2. `registry.pickAdapter(url)` selects the `winetime` adapter.
3. `parseCards(root)` finds product cards.
4. For each card, the adapter reads `data-productkey`.
5. The adapter resolves that id against `window.initialData.category.products` when available.
6. Product metadata supplies `manufacturer.title` for brewery and `title` for the raw product name.
7. If metadata is unavailable or unparsable, the adapter falls back to visible card title and brewery text.
8. Parsed cards flow through the existing match and badge rendering path.

## Name Cleanup

Use conservative metadata-first cleanup:

- Strip a leading `Пиво`.
- Strip trailing package volume such as `0,33 л`, `0,5 л`, or similar liter/ml forms.
- Strip obvious trailing catalog descriptors such as color, filtration, and alcohol-free markers when they appear as trailing descriptors.
- Strip a repeated brewery prefix only when it exactly matches the metadata brewery and leaves a non-empty name.
- Keep the original cleaned title if a rule would produce an empty string.

Do not infer ABV. WineTime catalog cards show volume and category descriptors, not reliable ABV.

## Error Handling

Parsing must stay read-only and fail-soft:

- Invalid or missing `window.initialData` should not throw out of `parseCards`.
- Cards without a usable name are skipped.
- Missing brewery is allowed as an empty string, matching existing adapter behavior.
- Unexpected page changes should degrade to DOM fallback before skipping cards.

## Testing

Implementation should follow TDD:

- Start with `extension/src/sites/winetime.test.ts` against `extension/tests/fixtures/winetime.html`.
- Cover metadata parsing, fallback parsing, conservative title cleanup, empty-result guards, and `waitForGrid` absence.
- Add registry tests for apex and subdomain WineTime URLs.
- Add manifest tests for apex and wildcard WineTime host patterns.
- Rely on `extension/src/sites/conformance.test.ts` for fixture presence, parse well-formedness, selector validity, and re-render after grid replacement.

Targeted verification should include:

- `cd extension && npm test -- src/sites/winetime.test.ts`
- `cd extension && npm test -- src/sites/conformance.test.ts src/sites/registry.test.ts src/manifest.test.ts`
- `cd extension && npm test`

## Documentation

Update `extension/CHANGELOG.md` under `[Unreleased]` with WineTime support.

Update `spec.md` section 6 to list `winetime` as a supported adapter, including the SSR catalog, embedded product metadata, `winetime.com.ua` host, and omitted ABV.
