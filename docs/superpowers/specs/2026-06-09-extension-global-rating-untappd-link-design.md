# Extension global-rating badge + Untappd link — design

**Date:** 2026-06-09
**Status:** approved (brainstorming)
**Builds on:** [browser extension client](2026-06-07-browser-extension-client-design.md), [extension beta distribution](2026-06-08-extension-beta-distribution-design.md)

## Problem

The overlay badges only **drunk** beers (`✅` + the user's rating). A beer the user
hasn't drunk but that exists in the catalog with a global Untappd rating gets no badge,
so the shopper sees nothing for it — even though we know its global score. And there is
no way to jump from a badge to the beer's Untappd page.

## Goal

1. Badge catalog beers the user **hasn't** drunk with `⭐ <global rating>` (distinct from
   the drunk `✅`).
2. Make **both** badges clickable — clicking opens that beer's Untappd page in a new
   foreground tab, without navigating away from the shop.

## Decisions (from brainstorming)

- Drunk badge stays `✅` + `user_rating` (unchanged).
- New not-drunk badge: `⭐` + `rating_global` (the catalog's global Untappd score).
- The `⭐` badge appears only when the match has **both** an `untappd_id` (bid) **and** a
  `rating_global` — without a rating there's nothing to show, and without a bid there's
  nowhere to link.
- Both badges clickable when `untappd_id` is present → open
  `https://untappd.com/beer/<untappd_id>` (verified: the numeric-bid URL resolves to the
  beer page; no slug needed).
- New **foreground** tab via `window.open(url, '_blank', 'noopener')`.

## Data flow

`untappd_id` already lives in `beers` but is dropped before reaching the extension.
Thread it through the existing match chain — no new matching logic:

```
beers.untappd_id (numeric bid; NULL for orphans)
 └─ loadCatalog (src/storage/beers.ts)            + untappd_id in SELECT + CatalogRow
     └─ matchBeerList (src/domain/match-list.ts)  + untappd_id on MatchedBeer
         └─ POST /match response                   + untappd_id (extension/src/api/types.ts)
             └─ badge.ts                            new ⭐ branch + click handler
```

## Components

### 1. Server — propagate `untappd_id` (3 files)

- **`src/storage/beers.ts`** — `loadCatalog` adds `untappd_id` to the `SELECT` and to
  `CatalogRow`. (The matcher ignores it; it just rides along for output.)
- **`src/domain/match-list.ts`** — `MatchedBeer` gains `untappd_id: number | null`,
  populated from the catalog row when building each matched result. `CatalogBeerWithRating`
  carries `untappd_id` so `byId.get(m.id)` exposes it.
- **`extension/src/api/types.ts`** — `MatchedBeer` gains `untappd_id: number | null` to
  mirror the server response.

No new endpoint, no auth/permission change.

### 2. Extension — badge rendering (`extension/src/content/badge.ts`)

Replace the `if (!result.is_drunk) return` early-out with a small state machine:

- `matched_beer == null` → no badge.
- `is_drunk` → `✅` (+ `user_rating` when present) — current behaviour.
- not drunk **and** `untappd_id != null` **and** `rating_global != null` →
  `⭐ <rating_global.toFixed(1)>`.
- otherwise (matched orphan: no bid / no global rating) → no badge.

### 3. Extension — click to Untappd (`extension/src/content/badge.ts`)

When `matched_beer.untappd_id != null`, the badge is interactive:

- `pointerEvents: 'auto'`, `cursor: 'pointer'`.
- click handler: `e.preventDefault(); e.stopPropagation();` (the badge sits on top of the
  product card, which is usually itself a link — suppress the card's navigation), then
  `window.open('https://untappd.com/beer/' + untappd_id, '_blank', 'noopener')`.

A drunk-but-orphan beer (`untappd_id == null`, rare) still shows `✅` but is not clickable.

### 4. Cache invalidation (`extension/src/cache/store.ts`)

Cached `MatchResult` entries predate `untappd_id`; reading them would yield
non-clickable badges until they expire. Bump the storage key `PREFIX` (`'mc:'` →
`'mc2:'`) so stale entries are never read (the old keys also self-expire within the 8h
TTL). No migration needed.

## Error handling / edge cases

- Missing `untappd_id` or `rating_global` → fall through to "no badge" / "not clickable";
  never render a dead link.
- `window.open` returning null (popup blocked) is a no-op from our side; acceptable — the
  user can retry. `noopener` prevents the opened page from accessing `window.opener`.

## Testing

- **`badge.ts`** (vitest, jsdom): drunk → `✅`; not-drunk + bid + global → `⭐` with the
  global value; not-drunk orphan (no bid or no rating) → no badge; unmatched → no badge;
  click on a badge with a bid calls `window.open` with the exact Untappd URL and calls
  `preventDefault`/`stopPropagation`; a badge without a bid is not clickable.
- **`src/storage/beers.ts`** — `loadCatalog` returns `untappd_id`.
- **`src/domain/match-list.ts`** — a matched result carries `matched_beer.untappd_id`.
- **`src/api/routes/match.ts`** — `/match` response includes `untappd_id`.
- Existing extension + bot suites stay green.

## Spec / CHANGELOG

- **`spec.md §6`** — add a line: the overlay also badges un-drunk catalog beers with
  `⭐ <global rating>`, and any badge with an Untappd bid links to the beer's Untappd page.
- **`extension/CHANGELOG.md`** — entry under `[Unreleased]`. The version bump + release is
  a separate step (the one-command release flow).

## Out of scope

- Background-tab / side-by-side-window opening (chose foreground tab).
- Showing a badge for beers with no global rating, or for unmatched beers.
- Changing the drunk badge's appearance or the matching algorithm.
