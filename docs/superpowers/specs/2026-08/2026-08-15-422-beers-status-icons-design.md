# Design: Personal beer status icons in `/beers`

**Issue:** #422 — New icons for `/beers` command

## Goal

Make `/beers <pub>` useful for choosing what to try at a particular pub by showing
whether each tap is already in the caller's beer history. Reuse the status language
from the browser extension while keeping the command's existing global Untappd
rating visible.

## Command behavior

The command continues to list every tap from the selected pub's latest snapshot.
It does not apply the user's beer filters and does not remove already-tried beers.
Only the final status annotation becomes personal to the caller:

| Beer state | Status annotation |
|---|---|
| Tried, with a personal rating | `✅ 4.2` |
| Tried, without a personal rating | `✅` |
| Not tried, with a real `untappd_id` | `⭐` |
| Not tried, without a real `untappd_id` | `⚪` |

The existing global rating field remains in place. A tried beer with a global
rating of 3.9 and a personal rating of 4.2 therefore renders as
`... • 3.9 • ✅ 4.2`.

Empty `N/A` tap slots keep their compact `{tap number} • N/A` rendering without
rating or status fields.

## Personal history and ratings

Pass the caller's Telegram ID from the command handler to `buildBeersMessage`.
The builder reads personal data through the existing storage helpers:

- `triedBeerIds` determines tried status from the required two-source union
  `checkins ∪ untappd_had`;
- `latestRatingsByBeer` supplies the most recent non-null personal check-in rating
  for each beer.

A beer linked to a local catalog row can therefore show `✅` even when that row is
still an orphan without an `untappd_id`. Personal ratings come only from check-ins;
an `untappd_had`-only beer displays a bare `✅`.

No schema, migration, new storage query, or new abstraction is needed.

## Rendering rules

For each non-empty tap, use the linked local `beer_id` to check personal history
and personal ratings. Tried status takes precedence over catalog match status.
For a tap that is not tried, a non-null `untappd_id` produces `⭐`; otherwise it
produces `⚪`.

Beer links, pub resolution, style, ABV, global rating, ordering, escaping, and
ambiguity handling remain unchanged.

## Tests

Update the focused `beers-build` tests before implementation to cover:

- a tried beer with a latest personal rating renders `✅ 4.2` while preserving the
  global rating;
- a beer present only in `untappd_had` renders bare `✅`;
- an untried catalog beer renders `⭐`;
- an untried orphan renders `⚪`;
- tried beers remain listed and `N/A` slots remain unchanged.

Run the focused builder test, then the full project test suite and typecheck.

## Specification update

Update `spec.md`'s `/beers` section to document the personalized status rules and
clarify that the command reads the had-list for annotation but never filters by it.

## Out of scope

- Filtering or reordering `/beers` by tried status.
- Changing `/newbeers`, `/route`, or browser-extension badges.
- Adding personal ratings to beers without a matching local catalog row.
- Changing the global rating format or adding new translations.
