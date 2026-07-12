# Design: Inline Untappd links on beer names (`/beers`, `/newbeers`)

**Issue:** #185 — "Add ability to open beers in Untappd app right from the /beers and /newbeers list."
**Date:** 2026-06-22

## Goal

When a user is at the pub and browsing `/beers` or `/newbeers`, let them tap a beer
name to open it directly in the Untappd app (for a quick check-in). No extra UI.

## Approach

Inline HTML text links, not inline-keyboard buttons. Both lists are sent as
`replyWithHTML` text messages. Buttons-per-beer don't scale (`/newbeers` shows up
to 15, `/beers` can show many taps) and Telegram blocks the `untappd://` scheme.
An `https://untappd.com/beer/{id}` link is an Untappd universal link, so on mobile
it opens the Untappd app when installed, and the browser otherwise.

Only **matched** beers (real `beers.untappd_id`, the 🟢 ones) can be linked.
Orphans (⚪, no `untappd_id`) stay plain text — there is nothing to open.

URL is built with the existing `buildBeerPageUrl(bid)` helper in
`src/sources/untappd/beer-page.ts` (`https://untappd.com/beer/{bid}`).

## Components / changes

### `/beers` — `src/bot/commands/beers-build.ts`
Single change in the per-tap line render (currently `<b>{display}</b>`): when
`tap.untappd_id != null`, wrap as `<a href="{url}"><b>{display}</b></a>`. The data
(`tap.untappd_id`) is already returned by `tapsForSnapshotWithBeer`. Display text
stays HTML-escaped as today. Icons / ABV / rating chips unchanged. Empty `N/A`
taps unchanged (never linked).

### `/newbeers` — thread the real Untappd id through the grouping pipeline
`CandidateTap` today carries only the **local** `beer_id`
(`match_links.untappd_beer_id`, which is set even for orphans). The real id is
`tap.untappd_id` (`beers.untappd_id`), which is `null` for orphans. So:

- `newbeers-format.ts`: add `untappd_id: number | null` to `CandidateTap` and to
  `BeerGroup`.
- `newbeers-build.ts`: populate `untappd_id: tap.untappd_id` when building each
  `CandidateTap`.
- `groupTaps`: carry the group's `untappd_id` from its representative tap. Matched
  groups (grouped by local `beer_id`) have a consistent `untappd_id`; orphan
  groups (grouped by `(normalized_brewery, normalized_name)`) get `null`.
- `formatGroupedBeers`: when `g.untappd_id != null`, wrap the bold display name in
  the link; otherwise plain `<b>…</b>`.

## Error handling / edge cases

- Display names remain HTML-escaped; the href is a numeric id (no escaping needed).
- Orphans and `N/A` slots: no link.
- Grouping precedence is unchanged — `untappd_id` rides along with the existing
  representative-tap selection in `groupTaps`.

## Testing (Vitest)

- `beers-build.test.ts`: matched tap → output contains
  `<a href="https://untappd.com/beer/{id}">`; orphan tap → no anchor.
- `newbeers-format.test.ts`: group with `untappd_id` → linked name; group without
  → plain bold; HTML escaping preserved.

## spec.md updates (same PR)

- `/beers` format line (§477): matched beer names are tappable Untappd links.
- `/newbeers` formatting step 5 (§463): bold name is a tappable Untappd link for
  matched beers.

## Out of scope (YAGNI)

- Inline-keyboard buttons; `untappd://` deep-link scheme.
- Links for orphans (no id to link).
- `/route` output changes.
