# Beer Style in Command Results Design

**Issue:** #186

## Goal

Show each beer's known style inline in `/newbeers`, `/beers`, and `/route` results so users can distinguish styles such as Stout and Sour before choosing a beer or route.

## User-visible behavior

- Render a known style inline after the bold beer name and before the existing rating and ABV metadata.
- Use the existing bullet separator, for example: `<b>Beer Name</b> • Imperial Stout ⭐ 4.1 8%`.
- Omit the style and its separator when `style` is `null`; do not render a placeholder.
- HTML-escape style text before including it in Telegram HTML.
- Preserve the existing special rendering of empty `/beers` taps such as `2 • N/A`.

## Data flow

`tapsForSnapshotWithBeer` already returns the tap's nullable `style`, so no schema, migration, scraper, or storage-query change is required.

- `/newbeers`: add `style` to `CandidateTap` and `BeerGroup`, populate it from the tap, carry it through grouping, and render it in `formatGroupedBeers`.
- `/route`: populate `CandidateTap.style`, carry the grouped style into `RouteBeerLine`, and render it with the same inline layout as `/newbeers`.
- `/beers`: render `tap.style` directly in each non-empty tap line.

When duplicate taps are grouped, style follows the same representative selection as display name and ABV: prefer the highest-rated representative's non-null style, then fall back to any non-null style in the group. Ranking and filtering remain unchanged.

## Testing

Use focused TDD coverage in the existing command test files:

- grouping preserves the representative style and falls back to a known style;
- `/newbeers` and `/route` render and HTML-escape known styles, while omitting unknown styles cleanly;
- `/beers` renders a known style inline and retains the current output for unknown styles and empty taps;
- the complete test suite remains green.

## Scope

This change affects presentation only. It does not change style ingestion, matching, filtering, route construction, localization, command limits, or the database schema.
