# Design — Google Maps walking-route button in `/route` (closes #193)

**Date:** 2026-06-24
**Issue:** [#193](https://github.com/ysilvestrov/warsaw-beer-bot/issues/193) — Add map into `/route` output.

## Goal

Let the user open the computed pub crawl as a real walking route in their map app,
straight from the `/route` result — "so the user can see where to go".

## Decision (from brainstorming)

- **Deep link, not a rendered map image.** A clickable link gives real turn-by-turn
  navigation in the user's own map app, fits the existing architecture (pub coords are
  already on hand), and needs no map-API key or tile infrastructure — consistent with the
  project's self-hosted / no-paid-keys philosophy. A static PNG route image was considered
  and deferred (would need a paid Static Maps key or an OSM-tile renderer; pure visual gain
  only).
- **Google Maps only.** Telegram's Bot API does not expose the client OS/platform in a
  normal command or callback query (the `User` object carries no platform field; only a
  Telegram Mini App can read `WebApp.platform`). We therefore cannot reliably detect an
  iPhone, so — per the issue's "and/or" and the user's rule "Apple Maps only if we know
  it's an iPhone, otherwise only Google" — we ship **Google Maps only**. Google's URL works
  on Android, iOS, and web alike.
- **Inline keyboard button**, not an in-text link — cleaner, idiomatic Telegram UX, keeps
  the result text unchanged.

## Architecture

### New pure module: `src/domain/maps.ts`

```ts
export interface Coord { lat: number; lon: number; }

// Returns a Google Maps walking-directions URL for the ordered stops, or null
// when there is nothing to route (0 stops).
export function googleMapsWalkingUrl(stops: Coord[]): string | null;
```

Behaviour:

- **0 stops** → `null` (caller omits the button).
- **1 stop** → `https://www.google.com/maps/dir/?api=1&destination=LAT,LON&travelmode=walking`.
  Origin is omitted, so Google starts from the user's current location and routes to the
  single pub.
- **≥2 stops** →
  `https://www.google.com/maps/dir/?api=1&origin=LAT,LON&destination=LAT,LON&waypoints=LAT,LON|LAT,LON|…&travelmode=walking`
  - `origin` = first stop, `destination` = last stop, `waypoints` = the middle stops in
    order. This reproduces the numbered list in the result message exactly.
- **Coordinate formatting:** each `lat,lon` rendered to 6-decimal fixed precision.
- **Waypoint cap:** the consumer Google Maps URL supports at most 9 intermediate
  waypoints. If there are more than 9 middle stops, keep the **first 9 in order** (rare —
  `N` is user-chosen and the qualifying-pub pool is usually small). Origin and destination
  are always the true first/last stops regardless of the cap.
- **Encoding:** the `|` waypoint separator is URL-encoded (`%7C`); the comma between lat and
  lon is left literal (as in Google's own examples). Build the query so coordinates and
  separators are encoded correctly.

### Integration in `src/bot/commands/route.ts`

- After `buildRoute` yields `result.pubIds`, derive the ordered coordinate list from
  `pubsById`: `result.pubIds.map((id) => { const p = pubsById.get(id)!; return { lat: p.lat!, lon: p.lon! }; })`.
  (`lat`/`lon` are guaranteed non-null — a pub without coords is skipped at the
  `pub.lat == null || pub.lon == null` guard when `routePubs` is built.)
- Build `const mapsUrl = googleMapsWalkingUrl(coords);`.
- For the **final** result message, replace the `notify(text, { force: true })` call with a
  direct `telegram.editMessageText(chatId, messageId, undefined, text, { parse_mode: 'HTML', reply_markup })`
  where `reply_markup` is an inline keyboard with a single URL button when `mapsUrl` is
  non-null, and omitted otherwise. The throttled `notify` stays in use for the progress
  updates only.
- Button label: new i18n key `route.open_in_maps`.

### i18n

Add `route.open_in_maps` to `src/i18n/types.ts` and the three locales:

- en: `🗺 Open route in Google Maps`
- uk: `🗺 Маршрут у Google Maps`
- pl: `🗺 Trasa w Google Maps`

## Error handling

- `mapsUrl === null` → send the result text with no `reply_markup`. In practice a route
  always has ≥1 pub (the `!routePubs.length` guard returns early), so the button is
  effectively always present.
- A failed final `editMessageText` is swallowed the same way the existing `notify` swallows
  edit failures (`.catch(() => {})`), so an attached keyboard never breaks the handler.

## Out of scope / unchanged

- No static/rendered map image (deferred).
- No Apple Maps / OSM links.
- No user-location anchoring for multi-stop routes (origin = first pub, to match the
  displayed order). The single-stop case starts from the user's location only because there
  is no prior stop to anchor on.
- Route computation, distance matrix, OSRM usage, and the result text format are untouched.

## Testing (Vitest)

`src/domain/maps.test.ts`:

- 0 stops → `null`.
- 1 stop → `destination=LAT,LON`, no `origin`, no `waypoints`, `travelmode=walking`.
- 2 stops → `origin` + `destination`, no `waypoints`.
- 3 stops → `origin` + `destination` + exactly one `waypoints` entry.
- >9 middle stops → `waypoints` capped at 9 entries; `origin`/`destination` still the true
  first/last.
- `|` separator is URL-encoded (`%7C`); coordinates rendered at 6-decimal precision.

The pure helper carries the test weight. `route.ts`'s background async flow is already
exercised by `route.test.ts`; the button wiring is a thin, type-checked addition and does
not need a new integration test.

## Spec

Update `spec.md` `/route` section to note the inline "Open route in Google Maps"
walking-directions button on the result. Extension docs are not affected (bot-only change).
