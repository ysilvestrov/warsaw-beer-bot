# Google Maps walking-route button in `/route` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inline "Open route in Google Maps" walking-directions button to the `/route` result so the user can navigate the computed pub crawl (closes #193).

**Architecture:** A new pure helper `src/domain/maps.ts` turns the ordered pub coordinates into a Google Maps walking-directions URL. `route.ts` derives those coords from the existing `result.pubIds` + `pubsById`, builds the URL, and attaches it as a single inline URL button on the final result message (the throttled progress `notify` is untouched).

**Tech Stack:** TypeScript, Telegraf (`Markup.inlineKeyboard` / `Markup.button.url`), Vitest.

---

## File Structure

**Create:**
- `src/domain/maps.ts` — pure `googleMapsWalkingUrl(stops: Coord[]): string | null`.
- `src/domain/maps.test.ts` — unit tests for the helper.

**Modify:**
- `src/bot/commands/route.ts` — import the helper + `Markup`; build coords/url; attach the button on the final edit.
- `src/i18n/types.ts` — declare `route.open_in_maps`.
- `src/i18n/locales/{en,uk,pl}.ts` — add the button label.
- `spec.md` — note the button in the `/route` section.

**Unchanged:** route computation, distance matrix, OSRM, `route-format.ts`, the progress `notify`.

---

### Task 1: Pure helper `googleMapsWalkingUrl`

**Files:**
- Create: `src/domain/maps.ts`
- Test: `src/domain/maps.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/maps.test.ts`:

```ts
import { googleMapsWalkingUrl, type Coord } from './maps';

const A: Coord = { lat: 52.1, lon: 21.0 };
const B: Coord = { lat: 52.2, lon: 21.1 };
const C: Coord = { lat: 52.3, lon: 21.2 };

describe('googleMapsWalkingUrl', () => {
  it('returns null for no stops', () => {
    expect(googleMapsWalkingUrl([])).toBeNull();
  });

  it('uses destination-only (start = user location) for a single stop', () => {
    const url = googleMapsWalkingUrl([A])!;
    expect(url).toContain('destination=52.100000,21.000000');
    expect(url).not.toContain('origin=');
    expect(url).not.toContain('waypoints=');
    expect(url).toContain('travelmode=walking');
  });

  it('uses origin + destination and no waypoints for two stops', () => {
    const url = googleMapsWalkingUrl([A, B])!;
    expect(url).toContain('origin=52.100000,21.000000');
    expect(url).toContain('destination=52.200000,21.100000');
    expect(url).not.toContain('waypoints=');
  });

  it('puts the middle stops into waypoints for three stops', () => {
    const url = googleMapsWalkingUrl([A, B, C])!;
    expect(url).toContain('origin=52.100000,21.000000');
    expect(url).toContain('destination=52.300000,21.200000');
    expect(url).toContain('waypoints=52.200000,21.100000');
  });

  it('url-encodes the waypoint separator', () => {
    const D: Coord = { lat: 52.4, lon: 21.3 };
    const url = googleMapsWalkingUrl([A, B, C, D])!;
    // two middle stops B,C joined by encoded pipe
    expect(url).toContain('waypoints=52.200000,21.100000%7C52.300000,21.200000');
  });

  it('caps intermediate waypoints at 9, keeping true first/last', () => {
    // 12 stops => 10 middle => capped to 9 waypoints
    const stops: Coord[] = Array.from({ length: 12 }, (_, i) => ({
      lat: 50 + i,
      lon: 20 + i,
    }));
    const url = googleMapsWalkingUrl(stops)!;
    expect(url).toContain('origin=50.000000,20.000000');
    expect(url).toContain('destination=61.000000,31.000000');
    const wp = url.match(/waypoints=([^&]*)/)![1];
    expect(wp.split('%7C')).toHaveLength(9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/maps.test.ts`
Expected: FAIL — module `./maps` does not exist yet.

- [ ] **Step 3: Implement the helper**

Create `src/domain/maps.ts`:

```ts
export interface Coord {
  lat: number;
  lon: number;
}

// Google Maps consumer URL supports at most 9 intermediate waypoints.
const MAX_WAYPOINTS = 9;

function fmt(c: Coord): string {
  return `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
}

// Builds a Google Maps walking-directions URL for the ordered stops.
// - 0 stops  -> null
// - 1 stop   -> destination only (Google starts from the user's location)
// - >=2 stops -> origin = first, destination = last, middle stops as waypoints
//   (capped at MAX_WAYPOINTS, keeping the true first/last).
export function googleMapsWalkingUrl(stops: Coord[]): string | null {
  if (stops.length === 0) return null;

  const base = 'https://www.google.com/maps/dir/?api=1';
  if (stops.length === 1) {
    return `${base}&destination=${fmt(stops[0])}&travelmode=walking`;
  }

  const origin = stops[0];
  const destination = stops[stops.length - 1];
  const middle = stops.slice(1, -1).slice(0, MAX_WAYPOINTS);

  const params = [`origin=${fmt(origin)}`, `destination=${fmt(destination)}`];
  if (middle.length) {
    params.push(`waypoints=${middle.map(fmt).join('%7C')}`);
  }
  params.push('travelmode=walking');

  return `${base}&${params.join('&')}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/domain/maps.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/maps.ts src/domain/maps.test.ts
git commit -m "feat(route): pure googleMapsWalkingUrl helper (#193)"
```

---

### Task 2: Wire the button into `/route` + i18n + spec

**Files:**
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`
- Modify: `src/bot/commands/route.ts`
- Modify: `spec.md`

- [ ] **Step 1: Declare the i18n key**

In `src/i18n/types.ts`, after the line `  'route.failed': string;` (currently line 70), add:

```ts
  'route.open_in_maps': string;
```

- [ ] **Step 2: Add the locale strings**

`src/i18n/locales/en.ts` — after `  'route.failed': '❌ Could not build a route — check the logs.',`:

```ts
  'route.open_in_maps': '🗺 Open route in Google Maps',
```

`src/i18n/locales/uk.ts` — after `  'route.failed': '❌ Не вдалось побудувати маршрут — подивись логи.',`:

```ts
  'route.open_in_maps': '🗺 Маршрут у Google Maps',
```

`src/i18n/locales/pl.ts` — after `  'route.failed': '❌ Nie udało się zbudować trasy — sprawdź logi.',`:

```ts
  'route.open_in_maps': '🗺 Trasa w Google Maps',
```

- [ ] **Step 3: Run typecheck to confirm all locales satisfy the type**

Run: `npm run typecheck`
Expected: PASS (the new key is present in `types.ts` and all three locales).

- [ ] **Step 4: Import the helper and `Markup` in `route.ts`**

In `src/bot/commands/route.ts`, change the Telegraf import (currently line 1):

```ts
import { Composer } from 'telegraf';
```

to:

```ts
import { Composer, Markup } from 'telegraf';
```

Then add this import alongside the other domain imports (e.g. directly after the `route-format` import on line 29):

```ts
import { googleMapsWalkingUrl } from '../../domain/maps';
```

- [ ] **Step 5: Attach the button on the final result edit**

In `src/bot/commands/route.ts`, find the end of the background block (currently lines 220-227):

```ts
      const text = formatRouteResult({
        N,
        distanceMeters: result.distanceMeters,
        pubsInOrder,
        locale,
        t,
      });
      await notify(text, { force: true });
```

Replace the `await notify(text, { force: true });` line with:

```ts
      const coords = result.pubIds.map((id) => {
        const p = pubsById.get(id)!;
        return { lat: p.lat!, lon: p.lon! };
      });
      const mapsUrl = googleMapsWalkingUrl(coords);
      const keyboard = mapsUrl
        ? Markup.inlineKeyboard([[Markup.button.url(t('route.open_in_maps'), mapsUrl)]])
        : undefined;
      await telegram
        .editMessageText(chatId, messageId, undefined, text, {
          parse_mode: 'HTML',
          ...(keyboard ? { reply_markup: keyboard.reply_markup } : {}),
        })
        .catch(() => {});
```

(`pubsById.get(id)!.lat`/`.lon` are non-null: a pub with null coords is skipped where
`routePubs` is built, line 67, and `result.pubIds ⊆ routePubs`. The final edit is a direct
`editMessageText` — like the existing `notify` it swallows edit failures with `.catch`.)

- [ ] **Step 6: Run typecheck + the route tests**

Run: `npm run typecheck && npx vitest run src/bot/commands/route.test.ts src/domain/maps.test.ts`
Expected: PASS (typecheck clean; existing route tests still green; helper tests green).

- [ ] **Step 7: Update `spec.md`**

In `spec.md`, find the `/route` section and add to the result description that the result
carries an inline **🗺 Open route in Google Maps** button — a walking-directions deep link
through the pubs in order (origin = first pub, destination = last, middle pubs as
waypoints; a single-pub route links directions from the user's current location). Match the
surrounding Ukrainian prose of that section.

- [ ] **Step 8: Full test + build**

Run: `npm test && npm run build`
Expected: PASS (all suites; build clean).

- [ ] **Step 9: Commit**

```bash
git add src/i18n/types.ts src/i18n/locales/en.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts src/bot/commands/route.ts spec.md
git commit -m "feat(route): inline Google Maps walking-route button (#193)"
```

---

## Self-Review

**Spec coverage:**
- Deep link, Google Maps only, walking → Task 1 helper (`travelmode=walking`). ✅
- 0/1/≥2-stop behaviour + 9-waypoint cap → Task 1 (`googleMapsWalkingUrl` branches + `MAX_WAYPOINTS`). ✅
- Inline keyboard button, result text unchanged → Task 2 Step 5 (`reply_markup` on the final edit; `text` from `formatRouteResult` untouched). ✅
- `route.open_in_maps` i18n in en/uk/pl + types → Task 2 Steps 1-2. ✅
- Coords from `result.pubIds` + `pubsById`, non-null guarantee → Task 2 Step 5 (comment). ✅
- `mapsUrl === null` → no keyboard → Task 2 Step 5 (`keyboard` undefined branch). ✅
- spec.md `/route` update → Task 2 Step 7. ✅

**Placeholder scan:** No TBD / vague steps — every code step shows full code. ✅

**Type consistency:** `Coord` defined in `src/domain/maps.ts` (Task 1) and consumed via the
inferred `{ lat, lon }` literal in Task 2 Step 5 (structurally identical). `googleMapsWalkingUrl`
signature matches its only call site. `Markup.button.url` / `Markup.inlineKeyboard` match the
existing `extension-release.ts` usage. ✅
