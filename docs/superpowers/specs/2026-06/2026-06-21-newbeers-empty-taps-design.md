# `/newbeers` Empty-Tap Filtering Design

**Date:** 2026-06-21
**Status:** Approved

## Problem

Ontap represents empty tap slots as `N/A`. The parser correctly retains those
rows for the raw `/beers` diagnostic, but `refreshOntap` also sends them through
catalog matching. That creates an orphan beer and a `match_links` row for
`N/A`. `filterInteresting` then treats the local beer id from that link as proof
of an Untappd match, so `/newbeers` and route candidates can show an empty tap as
an unrated beer.

A real Untappd match has a non-null `beers.untappd_id`; a `match_links` row
alone is insufficient. Whether an orphan remains eligible depends on the
consumer: unfiltered `/newbeers` may show it, filtered `/newbeers` may not, and
routes require real matches.

## Requirements

- Unfiltered `/newbeers` must continue to include ordinary orphan beers, even
  when their `untappd_id` is null.
- `/newbeers` must exclude orphans when any style, minimum-rating, or ABV filter
  is active.
- `/newbeers` must always exclude exact empty-tap sentinels (`N/A`), regardless
  of filter state.
- Route candidates must always exclude orphans whose `untappd_id` is null.
- Empty `N/A` tap slots must remain visible in `/beers` as raw diagnostics.
- `refreshOntap` must not match, create catalog rows for, or enrich empty `N/A`
  tap slots.
- Existing handling of real taps, non-beer filtering, user history, and user
  filters must remain unchanged.
- Production database cleanup is outside this code change and requires separate
  approval.

## Design

### Recommendation eligibility

Extend the existing `TapView` contract with `untappd_id` and add an explicit
`require_untappd_match` filter option. `filterInteresting` will continue to
require a local `beer_id`, and will additionally require `untappd_id` only when
that option is enabled.

`/route` always enables `require_untappd_match`. `/newbeers` enables it when at
least one style, minimum-rating, or ABV filter is active. With no active user
filters, ordinary orphans remain visible as they are today.

Because `N/A` is not an ordinary orphan, `/newbeers` independently excludes the
exact empty-tap sentinel before grouping. This keeps empty-tap handling explicit
instead of relying on orphan status, which intentionally varies by consumer.

### Empty-tap ingestion

Continue inserting parsed `N/A` rows into snapshots. This preserves the complete
raw tap view used by `/beers`. In the subsequent catalog loop, detect the exact
case-insensitive trimmed sentinel `N/A` and skip matching, orphan creation, and
inline enrichment for that row.

Only the exact sentinel is excluded. Names merely containing `N/A` are not
affected.

### Existing polluted data

Existing `N/A` match and orphan rows may remain in SQLite, but the corrected
empty-tap gate prevents them from reaching user recommendations. Future
refreshes do not create new `N/A` catalog work. Deleting existing production
rows is a separate operational action because it mutates live data.

## Testing

- Add domain regression tests proving that `require_untappd_match` excludes a
  row with a local `beer_id` but null `untappd_id`, while the default behavior
  retains it.
- Add `buildNewbeersMessage` regression tests proving that an ordinary orphan is
  present without filters and absent with any active filter, while `N/A` is
  absent in both cases.
- Add a route regression test proving that route candidates require a real
  Untappd match.
- Add a `refreshOntap` regression test proving that `N/A` remains in the stored
  snapshot but does not create a catalog or match-link row.
- Update `spec.md` so its `/newbeers` invariant documents the conditional orphan
  behavior instead of claiming that all orphans are always hidden.
- Run focused tests, typecheck, build, and the complete Vitest suite.

## Non-goals

- Changing `/beers` formatting or removing empty slots from it.
- Altering general parser behavior.
- Refactoring catalog matching or enrichment.
- Cleaning the production database automatically.
- Changing the browser extension.
