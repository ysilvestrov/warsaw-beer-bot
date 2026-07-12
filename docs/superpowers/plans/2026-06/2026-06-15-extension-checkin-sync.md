# Extension Check-in Sync (#145) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand "Sync my check-ins" channel — the extension walks the linked user's Untappd check-in feed in their own browser session and relays each page to the server, which parses it and merges per-check-in rows into `checkins`.

**Architecture:** Mirror the existing client-relay enrichment (#89). The MV3 service worker `fetch()`es feed pages with the user's cookies, trims the HTML, and POSTs it to a new server endpoint that parses with cheerio (no `DOMParser` in workers), resolves each beer by canonical bid, and merges idempotently. A persisted server-side cursor (`checkin_sync_state`) makes a capped, newest-first walk resumable across runs so even 5K+ histories complete over several taps.

**Tech Stack:** Node/TypeScript, Hono + zod (server API), better-sqlite3, cheerio (server HTML parsing), Jest (server tests). Browser extension: TypeScript, MV3, Vitest.

**Design doc:** `docs/superpowers/specs/2026-06-15-extension-checkin-sync-design.md`

**Conventions in this repo:**
- Server tests run with `npm test` (Jest). A single file: `npx jest <path>`. A single test: `npx jest <path> -t "<name>"`.
- Extension tests run with `cd extension && npx vitest run <path>`.
- Commit messages use conventional-commit scopes and end with the `Co-Authored-By` trailer.
- Schema is currently at **v12**; the new migration is **v13**.

---

## File Structure

**Server (create):**
- `src/storage/checkin_sync_state.ts` — get/upsert per-user sync cursor.
- `src/storage/checkin_sync_state.test.ts`
- `src/sources/untappd/checkin-feed.ts` — `parseCheckinFeedPage(html)`.
- `src/sources/untappd/checkin-feed.test.ts`
- `src/sources/untappd/__fixtures__/checkin-feed-page.html` — captured real feed HTML.
- `src/api/routes/checkins.ts` — `GET /checkins/sync/state`, `POST /checkins/sync`.
- `src/api/routes/checkins.test.ts`

**Server (modify):**
- `src/storage/schema.ts` — append migration v13.
- `src/api/index.ts` — wire the new route under `authMiddleware`.
- `src/storage/checkins.ts` — add `countCheckins(db, telegramId)`.

**Extension (create):**
- `src/background/handle-checkin-sync.ts` — the resumable two-phase loop.
- `src/background/handle-checkin-sync.test.ts`

**Extension (modify):**
- `src/api/types.ts` — `CheckinSyncState`, `CheckinSyncPageResult` types.
- `src/api/client.ts` — `getCheckinSyncState`, `postCheckinSyncPage`.
- `src/api/client.test.ts`
- `src/background/index.ts` — register `checkin-sync:start` / `checkin-sync:status` messages.
- `src/popup/popup.html` — "Sync my check-ins" button + status line.
- `src/popup/popup.ts` — wire the button to the background loop + progress polling.
- `src/popup/popup.test.ts`
- `package.json` — version bump 0.6.1 → 0.7.0.
- `CHANGELOG.md` — 0.7.0 entry.

**Docs (modify):**
- `spec.md` — `checkin_sync_state` table (v13), two new HTTP endpoints, second writer note.
- `docs/extension-install-uk.md` — document the new popup button.

---

## Task 1: Migration v13 — `checkin_sync_state` table

**Files:**
- Modify: `src/storage/schema.ts` (append to `MIGRATIONS`)

- [ ] **Step 1: Add the migration**

In `src/storage/schema.ts`, append a new object to the `MIGRATIONS` array (after the `version: 12` entry):

```ts
  {
    version: 13,
    sql: `
      CREATE TABLE checkin_sync_state (
        telegram_id    INTEGER PRIMARY KEY
                         REFERENCES user_profiles(telegram_id) ON DELETE CASCADE,
        deepest_max_id TEXT,
        complete       INTEGER NOT NULL DEFAULT 0,
        updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
```

- [ ] **Step 2: Verify migrations still apply**

Run: `npx jest src/storage`
Expected: PASS — existing schema/migration tests run the full ladder including v13 without error.

- [ ] **Step 3: Commit**

```bash
git add src/storage/schema.ts
git commit -m "feat(db): add checkin_sync_state table (v13) for #145

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `checkin_sync_state` storage module

**Files:**
- Create: `src/storage/checkin_sync_state.ts`
- Test: `src/storage/checkin_sync_state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/storage/checkin_sync_state.test.ts`:

```ts
import Database from 'better-sqlite3';
import { migrate } from './schema';
import type { DB } from './db';
import { ensureProfile } from './user_profiles';
import { getSyncState, advanceSyncState } from './checkin_sync_state';

function freshDb(): DB {
  const db = new Database(':memory:') as unknown as DB;
  migrate(db);
  return db;
}

describe('checkin_sync_state', () => {
  it('returns a default state when no row exists', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: null, complete: false });
  });

  it('advances the deepest cursor and persists completeness', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '500', false);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '500', complete: false });
    advanceSyncState(db, 1, '300', false);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '300', complete: false });
  });

  it('keeps the lowest (deepest) cursor when a higher one arrives later', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '300', false);
    advanceSyncState(db, 1, '900', false); // a Phase-1 top-up page; must not rewind the deep cursor
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '300', complete: false });
  });

  it('latches complete=true once set', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '100', true);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '100', complete: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/checkin_sync_state.test.ts`
Expected: FAIL — `Cannot find module './checkin_sync_state'`.

- [ ] **Step 3: Implement the module**

Create `src/storage/checkin_sync_state.ts`:

```ts
import type { DB } from './db';

export interface SyncState {
  deepest_max_id: string | null;
  complete: boolean;
}

export function getSyncState(db: DB, telegramId: number): SyncState {
  const row = db
    .prepare('SELECT deepest_max_id, complete FROM checkin_sync_state WHERE telegram_id = ?')
    .get(telegramId) as { deepest_max_id: string | null; complete: number } | undefined;
  if (!row) return { deepest_max_id: null, complete: false };
  return { deepest_max_id: row.deepest_max_id, complete: row.complete === 1 };
}

// max_id is a numeric Untappd cursor; "deepest" = lowest value. We keep the
// minimum of the existing and incoming cursor so a Phase-1 top-up page (a high
// max_id near "now") never rewinds the Phase-2 deep cursor. complete latches on.
export function advanceSyncState(
  db: DB,
  telegramId: number,
  maxId: string | null,
  complete: boolean,
): void {
  const prev = getSyncState(db, telegramId);
  const deepest = deeper(prev.deepest_max_id, maxId);
  db.prepare(
    `INSERT INTO checkin_sync_state (telegram_id, deepest_max_id, complete, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(telegram_id) DO UPDATE SET
       deepest_max_id = excluded.deepest_max_id,
       complete = MAX(checkin_sync_state.complete, excluded.complete),
       updated_at = CURRENT_TIMESTAMP`,
  ).run(telegramId, deepest, complete || prev.complete ? 1 : 0);
}

function deeper(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Number(b) < Number(a) ? b : a;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/storage/checkin_sync_state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/checkin_sync_state.ts src/storage/checkin_sync_state.test.ts
git commit -m "feat(storage): checkin_sync_state cursor get/advance (#145)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `countCheckins` helper

**Files:**
- Modify: `src/storage/checkins.ts`
- Test: `src/storage/checkins.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/storage/checkins.test.ts` (inside the existing top-level `describe`, or add a new one — match the file's existing structure):

```ts
import { countCheckins } from './checkins';

describe('countCheckins', () => {
  it('counts rows for the given user only', () => {
    const db = freshDb(); // reuse the file's existing freshDb helper
    mergeCheckin(db, { checkin_id: 'a', telegram_id: 1, beer_id: null, user_rating: null, checkin_at: '2026-01-01', venue: null });
    mergeCheckin(db, { checkin_id: 'b', telegram_id: 1, beer_id: null, user_rating: null, checkin_at: '2026-01-02', venue: null });
    mergeCheckin(db, { checkin_id: 'a', telegram_id: 2, beer_id: null, user_rating: null, checkin_at: '2026-01-01', venue: null });
    expect(countCheckins(db, 1)).toBe(2);
    expect(countCheckins(db, 2)).toBe(1);
    expect(countCheckins(db, 3)).toBe(0);
  });
});
```

> If `src/storage/checkins.test.ts` has no `freshDb`/`mergeCheckin` imports in scope, copy the import + in-memory DB setup pattern from `checkin_sync_state.test.ts` (Task 2).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/checkins.test.ts -t countCheckins`
Expected: FAIL — `countCheckins is not a function`.

- [ ] **Step 3: Implement**

Add to `src/storage/checkins.ts`:

```ts
export function countCheckins(db: DB, telegramId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM checkins WHERE telegram_id = ?')
    .get(telegramId) as { n: number };
  return row.n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/storage/checkins.test.ts -t countCheckins`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/checkins.ts src/storage/checkins.test.ts
git commit -m "feat(storage): countCheckins(telegramId) for sync progress (#145)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Capture a real check-in feed fixture

**Files:**
- Create: `src/sources/untappd/__fixtures__/checkin-feed-page.html`

> This task needs a logged-in Untappd session and cannot be invented — the parser
> in Task 5 is written against the **real** DOM. Do this manually, then base the
> Task 5 test's expected values on what this fixture actually contains.

- [ ] **Step 1: Save a feed page**

In a browser logged into Untappd, open `https://untappd.com/user/<your-username>` (the check-in activity feed). Save the full page HTML (View Source → save) to `src/sources/untappd/__fixtures__/checkin-feed-page.html`. Pick a page that has several check-ins, at least one with a personal rating and at least one with a venue.

- [ ] **Step 2: Note the DOM shape**

Open the fixture and record, for the parser in Task 5:
- the container selector for one check-in item and its `checkin_id` (usually a permalink like `/user/<name>/checkin/<id>`);
- where the beer `bid` lives (an attribute or the `/b/.../<bid>` beer link);
- beer name, brewery name selectors;
- the personal rating element (Untappd renders ratings as `data-rating` caps; the user's own rating on their feed);
- the timestamp and the venue;
- how the "Show More" / next page is encoded (the `max_id` value or the oldest item's checkin id);
- the "Total Check-ins" stat in the profile header.

- [ ] **Step 3: Commit the fixture**

```bash
git add src/sources/untappd/__fixtures__/checkin-feed-page.html
git commit -m "test(fixtures): real Untappd check-in feed page for #145 parser

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `parseCheckinFeedPage` parser

**Files:**
- Create: `src/sources/untappd/checkin-feed.ts`
- Test: `src/sources/untappd/checkin-feed.test.ts`

> Selectors below are the **starting point** modeled on `parseUserBeersPage`
> (`src/sources/untappd/scraper.ts`). Adjust them to match the fixture from Task 4
> until the test passes — the fixture is the source of truth, not these guesses.

- [ ] **Step 1: Write the failing test**

Create `src/sources/untappd/checkin-feed.test.ts`. Fill the `expect`ed values from the real fixture (Task 4, Step 2):

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCheckinFeedPage } from './checkin-feed';

const html = readFileSync(join(__dirname, '__fixtures__/checkin-feed-page.html'), 'utf8');

describe('parseCheckinFeedPage', () => {
  it('extracts check-ins with id, bid, names, rating, timestamp, venue', () => {
    const out = parseCheckinFeedPage(html);
    expect(out.checkins.length).toBeGreaterThan(0);
    const first = out.checkins[0];
    expect(first.checkin_id).toMatch(/^\d+$/);
    expect(Number.isInteger(first.bid)).toBe(true);
    expect(first.beer_name.length).toBeGreaterThan(0);
    expect(first.brewery_name.length).toBeGreaterThan(0);
    // At least one check-in in the fixture has a personal rating and one has a venue:
    expect(out.checkins.some((c) => c.user_rating !== null)).toBe(true);
    expect(out.checkins.some((c) => c.venue !== null)).toBe(true);
    // checkin_at is a non-empty string for every entry:
    expect(out.checkins.every((c) => typeof c.checkin_at === 'string' && c.checkin_at.length > 0)).toBe(true);
  });

  it('reports a numeric nextMaxId (cursor for the next older page)', () => {
    const out = parseCheckinFeedPage(html);
    expect(out.nextMaxId).toMatch(/^\d+$/);
  });

  it('reports profileTotal from the header when present', () => {
    const out = parseCheckinFeedPage(html);
    expect(out.profileTotal === null || out.profileTotal > 0).toBe(true);
  });

  it('returns empty + null cursor for a page with no check-ins', () => {
    const out = parseCheckinFeedPage('<html><body></body></html>');
    expect(out.checkins).toEqual([]);
    expect(out.nextMaxId).toBeNull();
  });

  it('skips items missing a checkin_id or bid', () => {
    const broken = '<div class="item"><div class="beer"><a href="/b/x">No bid</a></div></div>';
    expect(parseCheckinFeedPage(broken).checkins).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/sources/untappd/checkin-feed.test.ts`
Expected: FAIL — `Cannot find module './checkin-feed'`.

- [ ] **Step 3: Implement the parser**

Create `src/sources/untappd/checkin-feed.ts` (adjust selectors to the fixture):

```ts
import * as cheerio from 'cheerio';

export interface FeedCheckin {
  checkin_id: string;
  bid: number;
  beer_name: string;
  brewery_name: string;
  user_rating: number | null;
  checkin_at: string;
  venue: string | null;
}

export interface CheckinFeedPage {
  checkins: FeedCheckin[];
  nextMaxId: string | null;
  profileTotal: number | null;
}

function parseRating(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// checkin id from a permalink like /user/<name>/checkin/123456789
function checkinIdFrom(href: string | undefined): string | null {
  const m = (href ?? '').match(/\/checkin\/(\d+)/);
  return m ? m[1] : null;
}

// bid from a beer link like /b/<slug>/<bid> or a data-bid attribute
function bidFrom(row: cheerio.Cheerio<cheerio.Element>): number | null {
  const dataBid = row.find('[data-bid]').first().attr('data-bid');
  if (dataBid && /^\d+$/.test(dataBid)) return parseInt(dataBid, 10);
  const href = row.find('a[href*="/b/"]').first().attr('href') ?? '';
  const m = href.match(/\/b\/[^/]+\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export function parseCheckinFeedPage(html: string): CheckinFeedPage {
  const $ = cheerio.load(html);
  const checkins: FeedCheckin[] = [];

  // One check-in per `.item` in the activity feed (adjust to fixture).
  $('.item').each((_, el) => {
    const row = $(el);

    const permalink = row.find('a[href*="/checkin/"]').first().attr('href');
    const checkin_id = checkinIdFrom(permalink);
    const bid = bidFrom(row);
    if (!checkin_id || bid === null) return;

    const beer_name = row.find('a[href*="/b/"]').first().text().trim().replace(/\s+/g, ' ');
    const brewery_name = row.find('a[href*="/w/"]').first().text().trim().replace(/\s+/g, ' ');

    const user_rating = parseRating(
      row.find('.caps[data-rating]').first().attr('data-rating'),
    );

    // Untappd stores the machine timestamp in the permalink's title/datetime; fall
    // back to the visible relative time text.
    const timeEl = row.find('a[href*="/checkin/"]').first();
    const checkin_at =
      (timeEl.attr('data-href') && timeEl.attr('title')) ||
      timeEl.attr('title') ||
      timeEl.text().trim();

    const venueText = row.find('a[href*="/v/"]').first().text().trim();
    const venue = venueText.length > 0 ? venueText : null;

    checkins.push({ checkin_id, bid, beer_name, brewery_name, user_rating, checkin_at, venue });
  });

  // Next page cursor: prefer an explicit Show-More max_id, else the oldest
  // (last) check-in's id on this page. Null when nothing more to fetch.
  let nextMaxId: string | null = null;
  const moreHref = $('a[data-max-id], .more_checkins a, a.yes-comments').first().attr('data-max-id');
  if (moreHref && /^\d+$/.test(moreHref)) nextMaxId = moreHref;
  else if (checkins.length > 0) nextMaxId = checkins[checkins.length - 1].checkin_id;
  if (checkins.length === 0) nextMaxId = null;

  // Total check-ins from the profile stats header.
  let profileTotal: number | null = null;
  const totalText = $('.stats .check-ins .stat, .stats a[href$="/checkins"] .stat')
    .first()
    .text()
    .replace(/[,\s]/g, '');
  if (/^\d+$/.test(totalText)) profileTotal = parseInt(totalText, 10);

  return { checkins, nextMaxId, profileTotal };
}
```

- [ ] **Step 4: Run test, adjust selectors until green**

Run: `npx jest src/sources/untappd/checkin-feed.test.ts`
Expected: PASS. If selectors don't match the fixture, adjust them (and the test's expected values) against the real DOM until all five tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sources/untappd/checkin-feed.ts src/sources/untappd/checkin-feed.test.ts
git commit -m "feat(untappd): parseCheckinFeedPage — feed → check-ins + cursor (#145)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Server routes — `GET /checkins/sync/state` + `POST /checkins/sync`

**Files:**
- Create: `src/api/routes/checkins.ts`
- Modify: `src/api/index.ts`
- Test: `src/api/routes/checkins.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/routes/checkins.test.ts`. Model the harness on `src/api/routes/enrich.test.ts` (in-memory DB, a seeded API token, the Hono app from `createApiApp`). Use a tiny synthetic feed HTML so the test is independent of the real fixture:

```ts
import Database from 'better-sqlite3';
import { migrate } from '../../storage/schema';
import type { DB } from '../../storage/db';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { hashToken, insertToken } from '../../storage/api_tokens';
import { countCheckins } from '../../storage/checkins';
import { getSyncState } from '../../storage/checkin_sync_state';
import { createApiApp } from '../index';
import pino from 'pino';

const TOKEN = 'tok_test_123';

// Minimal page with ONE check-in (id 555, bid 42) and a next cursor (Show More 200).
const PAGE_ONE = `
<html><body>
  <div class="stats"><div class="check-ins"><span class="stat">3</span></div></div>
  <div class="item">
    <a href="/user/bob/checkin/555" title="2026-06-10 18:00">2h</a>
    <a href="/b/some-brewery-ipa/42" data-bid="42">IPA</a>
    <a href="/w/some-brewery/9">Some Brewery</a>
    <span class="caps" data-rating="4.25"></span>
    <a href="/v/some-bar/7">Some Bar</a>
  </div>
  <a class="more_checkins" data-max-id="200">Show More</a>
</body></html>`;

// Last page: same check-in 555 again (already known), no Show More → feed bottom.
const PAGE_BOTTOM = `
<html><body>
  <div class="item">
    <a href="/user/bob/checkin/555" title="2026-06-10 18:00">2h</a>
    <a href="/b/some-brewery-ipa/42" data-bid="42">IPA</a>
    <a href="/w/some-brewery/9">Some Brewery</a>
  </div>
</body></html>`;

function setup() {
  const db = new Database(':memory:') as unknown as DB;
  migrate(db);
  ensureProfile(db, 1);
  setUntappdUsername(db, 1, 'bob');
  insertToken(db, 1, hashToken(TOKEN)); // match the real insertToken signature in api_tokens.ts
  const app = createApiApp({ db, env: {} as never, log: pino({ level: 'silent' }) });
  return { db, app };
}

function req(app: ReturnType<typeof setup>['app'], path: string, body?: unknown) {
  return app.request(path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /checkins/sync/state', () => {
  it('returns username, zero count, and a fresh cursor', async () => {
    const { app } = setup();
    const res = await req(app, '/checkins/sync/state');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      username: 'bob', deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null,
    });
  });

  it('409 not_linked when no username', async () => {
    const { db, app } = setup();
    db.prepare('UPDATE user_profiles SET untappd_username = NULL WHERE telegram_id = 1').run();
    const res = await req(app, '/checkins/sync/state');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_linked' });
  });
});

describe('POST /checkins/sync', () => {
  it('merges new check-ins, resolves beer by bid, advances cursor', async () => {
    const { db, app } = setup();
    const res = await req(app, '/checkins/sync', { html: PAGE_ONE, maxId: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merged).toBe(1);
    expect(body.alreadyKnown).toBe(0);
    expect(body.pageSize).toBe(1);
    expect(body.nextMaxId).toBe('200');
    expect(body.profileTotal).toBe(3);
    expect(body.serverCount).toBe(1);
    expect(body.complete).toBe(false);
    expect(countCheckins(db, 1)).toBe(1);
    // Beer resolved by bid (untappd_id), not fuzzy:
    const beer = db.prepare('SELECT untappd_id FROM beers WHERE untappd_id = 42').get();
    expect(beer).toBeTruthy();
    expect(getSyncState(db, 1).deepest_max_id).toBe('200');
  });

  it('is idempotent — re-posting the same page merges nothing', async () => {
    const { db, app } = setup();
    await req(app, '/checkins/sync', { html: PAGE_ONE, maxId: null });
    const res = await req(app, '/checkins/sync', { html: PAGE_ONE, maxId: '200' });
    const body = await res.json();
    expect(body.merged).toBe(0);
    expect(body.alreadyKnown).toBe(1);
    expect(countCheckins(db, 1)).toBe(1);
  });

  it('sets complete=true at feed bottom (no nextMaxId)', async () => {
    const { db, app } = setup();
    const res = await req(app, '/checkins/sync', { html: PAGE_BOTTOM, maxId: null });
    const body = await res.json();
    expect(body.nextMaxId).toBeNull();
    expect(body.complete).toBe(true);
    expect(getSyncState(db, 1).complete).toBe(true);
  });

  it('502 blocked on a Cloudflare challenge page', async () => {
    const { app } = setup();
    const res = await req(app, '/checkins/sync', { html: '<html>Just a moment...</html>', maxId: null });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'blocked' });
  });

  it('409 not_linked when no username', async () => {
    const { db, app } = setup();
    db.prepare('UPDATE user_profiles SET untappd_username = NULL WHERE telegram_id = 1').run();
    const res = await req(app, '/checkins/sync', { html: PAGE_ONE, maxId: null });
    expect(res.status).toBe(409);
  });

  it('401 without a token', async () => {
    const { app } = setup();
    const res = await app.request('/checkins/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: PAGE_ONE }),
    });
    expect(res.status).toBe(401);
  });
});
```

> Before running: open `src/storage/api_tokens.ts` and `src/api/routes/enrich.test.ts`
> to confirm the exact `insertToken` signature and token-seeding pattern; mirror it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/api/routes/checkins.test.ts`
Expected: FAIL — route module missing / 404s.

- [ ] **Step 3: Implement the route**

Create `src/api/routes/checkins.ts`:

```ts
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { getProfile } from '../../storage/user_profiles';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin, countCheckins } from '../../storage/checkins';
import { getSyncState, advanceSyncState } from '../../storage/checkin_sync_state';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';
import { parseCheckinFeedPage } from '../../sources/untappd/checkin-feed';
import { isBlockPage } from '../../sources/untappd/block';

const SyncBody = z.object({
  html: z.string(),
  maxId: z.string().nullable().optional(),
});

export function checkinsRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.get('/checkins/sync/state', (c) => {
    const telegramId = c.get('telegramId');
    const username = getProfile(deps.db, telegramId)?.untappd_username ?? null;
    if (!username) return c.json({ error: 'not_linked' }, 409);
    const state = getSyncState(deps.db, telegramId);
    return c.json({
      username,
      deepest_max_id: state.deepest_max_id,
      complete: state.complete,
      serverCount: countCheckins(deps.db, telegramId),
      profileTotal: null,
    });
  });

  app.post('/checkins/sync', zValidator('json', SyncBody), (c) => {
    const telegramId = c.get('telegramId');
    const username = getProfile(deps.db, telegramId)?.untappd_username ?? null;
    if (!username) return c.json({ error: 'not_linked' }, 409);

    const { html } = c.req.valid('json');
    if (isBlockPage(html)) return c.json({ error: 'blocked' }, 502);

    const page = parseCheckinFeedPage(html);
    let merged = 0;
    let alreadyKnown = 0;

    deps.db.transaction(() => {
      for (const ci of page.checkins) {
        const existed = deps.db
          .prepare('SELECT 1 FROM checkins WHERE telegram_id = ? AND checkin_id = ?')
          .get(telegramId, ci.checkin_id);
        const beerId = upsertBeer(deps.db, {
          untappd_id: ci.bid,
          name: ci.beer_name,
          brewery: ci.brewery_name,
          style: null,
          abv: null,
          rating_global: null,
          normalized_name: normalizeName(ci.beer_name),
          normalized_brewery: normalizeBrewery(ci.brewery_name),
        });
        mergeCheckin(deps.db, {
          checkin_id: ci.checkin_id,
          telegram_id: telegramId,
          beer_id: beerId,
          user_rating: ci.user_rating,
          checkin_at: ci.checkin_at,
          venue: ci.venue,
        });
        if (existed) alreadyKnown++;
        else merged++;
      }
      advanceSyncState(deps.db, telegramId, page.nextMaxId, page.nextMaxId === null);
    })();

    return c.json({
      merged,
      alreadyKnown,
      pageSize: page.checkins.length,
      nextMaxId: page.nextMaxId,
      profileTotal: page.profileTotal,
      serverCount: countCheckins(deps.db, telegramId),
      complete: page.nextMaxId === null,
    });
  });
}
```

- [ ] **Step 4: Wire the route**

In `src/api/index.ts`, import and mount under `authMiddleware` (mirror the `/enrich/*` lines):

```ts
import { checkinsRoute } from './routes/checkins';
```

and after the `enrichRoute(app, deps);` block:

```ts
  app.use('/checkins/*', authMiddleware(deps.db));
  checkinsRoute(app, deps);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/api/routes/checkins.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Run the full server suite**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/api/routes/checkins.ts src/api/routes/checkins.test.ts src/api/index.ts
git commit -m "feat(api): /checkins/sync + /checkins/sync/state relay endpoints (#145)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Extension API client + types

**Files:**
- Modify: `extension/src/api/types.ts`
- Modify: `extension/src/api/client.ts`
- Test: `extension/src/api/client.test.ts` (append)

- [ ] **Step 1: Add types**

Append to `extension/src/api/types.ts`:

```ts
export interface CheckinSyncState {
  username: string;
  deepest_max_id: string | null;
  complete: boolean;
  serverCount: number;
  profileTotal: number | null;
}

export interface CheckinSyncPageResult {
  merged: number;
  alreadyKnown: number;
  pageSize: number;
  nextMaxId: string | null;
  profileTotal: number | null;
  serverCount: number;
  complete: boolean;
}
```

- [ ] **Step 2: Write the failing client test**

Append to `extension/src/api/client.test.ts` (mirror the existing `postEnrichResult` test style — mock `global.fetch`):

```ts
import { getCheckinSyncState, postCheckinSyncPage, ApiError } from './client';

describe('getCheckinSyncState', () => {
  it('GETs state and returns the parsed body', async () => {
    const body = { username: 'bob', deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null };
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const out = await getCheckinSyncState('http://x', 'tok');
    expect(out).toEqual(body);
  });

  it('throws not_linked-bearing server error on 409', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'not_linked' }), { status: 409 }));
    await expect(getCheckinSyncState('http://x', 'tok')).rejects.toMatchObject({ code: 'not_linked' });
  });
});

describe('postCheckinSyncPage', () => {
  it('POSTs html+maxId and returns the page result', async () => {
    const body = { merged: 1, alreadyKnown: 0, pageSize: 1, nextMaxId: '200', profileTotal: 3, serverCount: 1, complete: false };
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    global.fetch = spy;
    const out = await postCheckinSyncPage('http://x', 'tok', '<html>', null);
    expect(out).toEqual(body);
    expect(spy).toHaveBeenCalledWith('http://x/checkins/sync', expect.objectContaining({ method: 'POST' }));
  });

  it('maps 502 to blocked', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'blocked' }), { status: 502 }));
    await expect(postCheckinSyncPage('http://x', 'tok', '<html>', null)).rejects.toMatchObject({ code: 'blocked' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd extension && npx vitest run src/api/client.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 4: Extend the error type and add client functions**

In `extension/src/api/client.ts`, widen `ApiErrorCode` and add the two functions:

```ts
export type ApiErrorCode = 'unauthorized' | 'server' | 'network' | 'not_linked' | 'blocked';
```

```ts
import type { CheckinSyncState, CheckinSyncPageResult } from './types';

export async function getCheckinSyncState(
  baseUrl: string,
  token: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CheckinSyncState> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/checkins/sync/state`, {
      headers: { Authorization: `Bearer ${token}` },
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (res.status === 409) throw new ApiError('not_linked');
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  return (await res.json()) as CheckinSyncState;
}

export async function postCheckinSyncPage(
  baseUrl: string,
  token: string,
  html: string,
  maxId: string | null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CheckinSyncPageResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/checkins/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, maxId }),
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
  if (res.status === 401) throw new ApiError('unauthorized');
  if (res.status === 409) throw new ApiError('not_linked');
  if (res.status === 502) throw new ApiError('blocked');
  if (!res.ok) throw new ApiError('server', `status ${res.status}`);
  return (await res.json()) as CheckinSyncPageResult;
}
```

> Add the `import type { CheckinSyncState, CheckinSyncPageResult }` to the existing
> top-of-file type import from `./types` rather than a second import line.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd extension && npx vitest run src/api/client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/src/api/types.ts extension/src/api/client.ts extension/src/api/client.test.ts
git commit -m "feat(extension/api): checkin-sync state + page client calls (#145)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Background two-phase sync loop

**Files:**
- Create: `extension/src/background/handle-checkin-sync.ts`
- Test: `extension/src/background/handle-checkin-sync.test.ts`

The loop is written as a pure async function with injected dependencies so it can be
unit-tested without `chrome.*`. The message wiring (Task 9) supplies the real deps.

- [ ] **Step 1: Write the failing test**

Create `extension/src/background/handle-checkin-sync.test.ts`:

```ts
import { runCheckinSync, type CheckinSyncDeps } from './handle-checkin-sync';
import type { CheckinSyncPageResult } from '../api/types';

function page(over: Partial<CheckinSyncPageResult>): CheckinSyncPageResult {
  return { merged: 25, alreadyKnown: 0, pageSize: 25, nextMaxId: '1', profileTotal: 100, serverCount: 0, complete: false, ...over };
}

function baseDeps(over: Partial<CheckinSyncDeps>): CheckinSyncDeps {
  return {
    getState: async () => ({ username: 'bob', deepest_max_id: null, complete: false, serverCount: 0, profileTotal: 100 }),
    fetchFeed: async () => '<html>feed</html>',
    submitPage: async () => page({}),
    onProgress: () => {},
    sleep: async () => {},
    pageCap: 200,
    ...over,
  };
}

describe('runCheckinSync', () => {
  it('Phase 1 stops on the first fully-known page', async () => {
    const submitPage = vi.fn(async () => page({ merged: 0, alreadyKnown: 25, pageSize: 25, nextMaxId: '1' }));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(submitPage).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('done');
  });

  it('walks to feed bottom and reports complete', async () => {
    let n = 0;
    const submitPage = vi.fn(async () => (++n < 3 ? page({ nextMaxId: String(10 - n) }) : page({ nextMaxId: null, complete: true })));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(submitPage).toHaveBeenCalledTimes(3);
    expect(out.complete).toBe(true);
  });

  it('Phase 2 resumes from the saved deep cursor when Phase 1 is fully known', async () => {
    const getState = async () => ({ username: 'bob', deepest_max_id: '500', complete: false, serverCount: 5000, profileTotal: 8000 });
    const calls: (string | null)[] = [];
    const submitPage = vi.fn(async (_html: string, maxId: string | null) => {
      calls.push(maxId);
      if (calls.length === 1) return page({ merged: 0, alreadyKnown: 25 }); // Phase 1 top: fully known
      return page({ nextMaxId: null, complete: true }); // Phase 2 from cursor → bottom
    });
    await runCheckinSync(baseDeps({ getState, submitPage }));
    // First call is Phase 1 (maxId null/undefined), second resumes at the cursor 500:
    expect(calls[0]).toBeNull();
    expect(calls[1]).toBe('500');
  });

  it('halts and reports the page cap', async () => {
    const submitPage = vi.fn(async () => page({ nextMaxId: '1' })); // never bottoms out
    const out = await runCheckinSync(baseDeps({ submitPage, pageCap: 3 }));
    expect(submitPage).toHaveBeenCalledTimes(3);
    expect(out.status).toBe('capped');
    expect(out.complete).toBe(false);
  });

  it('surfaces not_linked from getState', async () => {
    const getState = vi.fn(async () => { throw Object.assign(new Error(), { code: 'not_linked' }); });
    const out = await runCheckinSync(baseDeps({ getState }));
    expect(out.status).toBe('not_linked');
  });

  it('surfaces blocked from submitPage', async () => {
    const submitPage = vi.fn(async () => { throw Object.assign(new Error(), { code: 'blocked' }); });
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(out.status).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/background/handle-checkin-sync.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the loop**

Create `extension/src/background/handle-checkin-sync.ts`:

```ts
import type { CheckinSyncState, CheckinSyncPageResult } from '../api/types';

export interface SyncProgress {
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
}

export type SyncStatus = 'done' | 'capped' | 'not_linked' | 'blocked' | 'error';

export interface SyncOutcome {
  status: SyncStatus;
  complete: boolean;
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
}

export interface CheckinSyncDeps {
  getState: () => Promise<CheckinSyncState>;
  fetchFeed: (username: string, maxId: string | null) => Promise<string>;
  submitPage: (html: string, maxId: string | null) => Promise<CheckinSyncPageResult>;
  onProgress: (p: SyncProgress) => void;
  sleep: (ms: number) => Promise<void>;
  pageCap: number;
  delayMs?: number;
}

export const DEFAULT_DELAY_MS = 4000;

function errCode(e: unknown): string | null {
  return e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : null;
}

export async function runCheckinSync(deps: CheckinSyncDeps): Promise<SyncOutcome> {
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  let mergedThisRun = 0;
  let serverCount = 0;
  let profileTotal: number | null = null;
  let pages = 0;

  let state: CheckinSyncState;
  try {
    state = await deps.getState();
  } catch (e) {
    const code = errCode(e);
    return done(code === 'not_linked' ? 'not_linked' : 'error');
  }
  serverCount = state.serverCount;
  profileTotal = state.profileTotal;

  // Walk a sequence of cursors. Phase 1 starts at "now" (null). When a page is
  // fully known we break Phase 1; if a deep cursor exists and we're not complete,
  // Phase 2 resumes there. A single loop handles both via a cursor queue.
  const startCursors: (string | null)[] = [null];
  if (state.deepest_max_id !== null && !state.complete) startCursors.push(state.deepest_max_id);

  for (let phase = 0; phase < startCursors.length; phase++) {
    let maxId = startCursors[phase];
    // Phase 2's first request uses the saved cursor directly; Phase 1 uses null.
    let firstOfPhase = true;
    while (pages < deps.pageCap) {
      let html: string;
      try {
        html = await deps.fetchFeed(state.username, firstOfPhase && phase === 0 ? null : maxId);
      } catch (e) {
        return finish(errCode(e) === 'blocked' ? 'blocked' : 'error');
      }
      let res: CheckinSyncPageResult;
      try {
        res = await deps.submitPage(html, firstOfPhase && phase === 0 ? null : maxId);
      } catch (e) {
        return finish(errCode(e) === 'blocked' ? 'blocked' : errCode(e) === 'not_linked' ? 'not_linked' : 'error');
      }
      pages++;
      firstOfPhase = false;
      mergedThisRun += res.merged;
      serverCount = res.serverCount;
      if (res.profileTotal !== null) profileTotal = res.profileTotal;
      deps.onProgress({ serverCount, profileTotal, mergedThisRun });

      if (res.complete) return finish('done', true);
      // Phase 1: stop at known territory; Phase 2: a fully-known page means the
      // deep walk reached imported history → also stop this phase.
      if (res.pageSize > 0 && res.alreadyKnown === res.pageSize) break;
      if (res.nextMaxId === null) return finish('done', true);
      maxId = res.nextMaxId;
      if (pages < deps.pageCap) await deps.sleep(delayMs);
    }
    if (pages >= deps.pageCap) return finish('capped', false);
  }
  return finish('done', false);

  function finish(status: SyncStatus, complete = false): SyncOutcome {
    return { status, complete, serverCount, profileTotal, mergedThisRun };
  }
  function done(status: SyncStatus): SyncOutcome {
    return { status, complete: false, serverCount, profileTotal, mergedThisRun };
  }
}
```

- [ ] **Step 4: Run test, adjust until green**

Run: `cd extension && npx vitest run src/background/handle-checkin-sync.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/handle-checkin-sync.ts extension/src/background/handle-checkin-sync.test.ts
git commit -m "feat(extension/bg): resumable two-phase check-in sync loop (#145)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Wire the loop into the service worker

**Files:**
- Modify: `extension/src/background/index.ts`

This adds the real `chrome.*`-backed deps, a single-flight guard, progress mirrored
to `chrome.storage.session`, and the `checkin-sync:start` / `checkin-sync:status`
message handlers. (Covered by the popup test in Task 10 + manual verification; no
new unit test for the chrome glue.)

- [ ] **Step 1: Add the handler + message wiring**

Append to `extension/src/background/index.ts`:

```ts
import { getCheckinSyncState, postCheckinSyncPage, ApiError } from '../api/client';
import { runCheckinSync, type SyncOutcome, type SyncProgress } from './handle-checkin-sync';

export interface CheckinSyncStartMessage { type: 'checkin-sync:start' }
export interface CheckinSyncStatusMessage { type: 'checkin-sync:status' }

const SYNC_PAGE_CAP = 200;
const SYNC_STATE_KEY = 'checkinSync';

interface StoredSyncStatus {
  running: boolean;
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
  outcome: SyncOutcome['status'] | null;
  complete: boolean;
}

async function writeSyncStatus(s: StoredSyncStatus): Promise<void> {
  await chrome.storage.session.set({ [SYNC_STATE_KEY]: s });
}

async function readSyncStatus(): Promise<StoredSyncStatus> {
  const s = await chrome.storage.session.get(SYNC_STATE_KEY);
  return (s[SYNC_STATE_KEY] as StoredSyncStatus | undefined) ?? {
    running: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: null, complete: false,
  };
}

function feedUrl(username: string, maxId: string | null): string {
  const base = `https://untappd.com/user/${encodeURIComponent(username)}`;
  return maxId === null ? base : `${base}?max_id=${encodeURIComponent(maxId)}`;
}

export async function handleCheckinSyncStart(): Promise<{ type: 'checkin-sync:started'; alreadyRunning: boolean }> {
  const cur = await readSyncStatus();
  if (cur.running) return { type: 'checkin-sync:started', alreadyRunning: true };

  const { token, baseUrl } = await getSettings();
  if (!token) {
    await writeSyncStatus({ ...cur, running: false, outcome: 'error' });
    return { type: 'checkin-sync:started', alreadyRunning: false };
  }

  await writeSyncStatus({ running: true, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: null, complete: false });

  // Fire-and-forget; popup polls checkin-sync:status. Errors are captured into status.
  void (async () => {
    const onProgress = async (p: SyncProgress) => {
      const s = await readSyncStatus();
      await writeSyncStatus({ ...s, serverCount: p.serverCount, profileTotal: p.profileTotal, mergedThisRun: p.mergedThisRun });
    };
    const outcome = await runCheckinSync({
      getState: () => getCheckinSyncState(baseUrl, token),
      fetchFeed: async (username, maxId) => {
        const res = await fetch(feedUrl(username, maxId), { credentials: 'include' });
        if (!res.ok) throw new ApiError(res.status === 403 || res.status === 429 ? 'blocked' : 'server');
        return res.text();
      },
      submitPage: (html, maxId) => postCheckinSyncPage(baseUrl, token, html, maxId),
      onProgress: (p) => { void onProgress(p); },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      pageCap: SYNC_PAGE_CAP,
    });
    await writeSyncStatus({
      running: false,
      serverCount: outcome.serverCount,
      profileTotal: outcome.profileTotal,
      mergedThisRun: outcome.mergedThisRun,
      outcome: outcome.status,
      complete: outcome.complete,
    });
  })();

  return { type: 'checkin-sync:started', alreadyRunning: false };
}

export async function handleCheckinSyncStatus(): Promise<{ type: 'checkin-sync:status:ok' } & StoredSyncStatus> {
  return { type: 'checkin-sync:status:ok', ...(await readSyncStatus()) };
}
```

And extend the `onMessage` listener:

```ts
  if (t === 'checkin-sync:start') { handleCheckinSyncStart().then(sendResponse); return true; }
  if (t === 'checkin-sync:status') { handleCheckinSyncStatus().then(sendResponse); return true; }
```

> Note on keep-alive: the inter-page `setTimeout` can be interrupted if the MV3
> worker is evicted mid-sleep. That is acceptable — the server cursor makes the next
> "Sync" tap resume safely, and `chrome.storage.session` preserves the last reported
> progress for the popup. (A `chrome.alarms`-based pacer is a possible later
> hardening; not required for correctness.)

- [ ] **Step 2: Type-check the extension build**

Run: `cd extension && npx tsc --noEmit`
Expected: PASS — no type errors. (`chrome.storage.session` requires `@types/chrome`; already a dep.)

- [ ] **Step 3: Run the extension suite**

Run: `cd extension && npm test`
Expected: PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add extension/src/background/index.ts
git commit -m "feat(extension/bg): wire checkin-sync start/status messages (#145)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Popup button + progress

**Files:**
- Modify: `extension/src/popup/popup.html`
- Modify: `extension/src/popup/popup.ts`
- Test: `extension/src/popup/popup.test.ts` (append)

- [ ] **Step 1: Add the button + status to the HTML**

In `extension/src/popup/popup.html`, add inside `<main class="card">` after the existing `.row`:

```html
      <div class="row">
        <button id="syncCheckins" type="button">Sync my check-ins</button>
      </div>
      <p id="syncStatus" class="status" aria-live="polite"></p>
```

- [ ] **Step 2: Write the failing test**

Append to `extension/src/popup/popup.test.ts` a test for the pure status-formatting
helper (mirror how the file tests `canRefresh`):

```ts
import { formatSyncStatus } from './popup';

describe('formatSyncStatus', () => {
  it('shows progress while running', () => {
    expect(formatSyncStatus({ running: true, serverCount: 1200, profileTotal: 8200, mergedThisRun: 30, outcome: null, complete: false }))
      .toBe('Syncing… 1200 / 8200');
  });
  it('shows count only when total is unknown', () => {
    expect(formatSyncStatus({ running: true, serverCount: 1200, profileTotal: null, mergedThisRun: 30, outcome: null, complete: false }))
      .toBe('Syncing… 1200');
  });
  it('prompts to continue when capped', () => {
    expect(formatSyncStatus({ running: false, serverCount: 5000, profileTotal: 8200, mergedThisRun: 5000, outcome: 'capped', complete: false }))
      .toBe('Synced 5000 of 8200 — tap Sync again to continue.');
  });
  it('reports full sync on completion', () => {
    expect(formatSyncStatus({ running: false, serverCount: 8200, profileTotal: 8200, mergedThisRun: 100, outcome: 'done', complete: true }))
      .toBe('✓ Fully synced (8200).');
  });
  it('tells unlinked users to link first', () => {
    expect(formatSyncStatus({ running: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'not_linked', complete: false }))
      .toBe('Link your Untappd account in the bot first (/link).');
  });
  it('reports rate limiting', () => {
    expect(formatSyncStatus({ running: false, serverCount: 10, profileTotal: 8200, mergedThisRun: 10, outcome: 'blocked', complete: false }))
      .toBe('Untappd is rate-limiting — try again later.');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd extension && npx vitest run src/popup/popup.test.ts`
Expected: FAIL — `formatSyncStatus` not exported.

- [ ] **Step 4: Implement the helper + wiring**

Add to `extension/src/popup/popup.ts`:

```ts
export interface SyncStatusView {
  running: boolean;
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
  outcome: 'done' | 'capped' | 'not_linked' | 'blocked' | 'error' | null;
  complete: boolean;
}

export function formatSyncStatus(s: SyncStatusView): string {
  if (s.running) {
    return s.profileTotal !== null
      ? `Syncing… ${s.serverCount} / ${s.profileTotal}`
      : `Syncing… ${s.serverCount}`;
  }
  switch (s.outcome) {
    case 'not_linked': return 'Link your Untappd account in the bot first (/link).';
    case 'blocked': return 'Untappd is rate-limiting — try again later.';
    case 'error': return 'Sync failed — check your connection and token, then retry.';
    case 'capped': return `Synced ${s.serverCount} of ${s.profileTotal ?? '?'} — tap Sync again to continue.`;
    case 'done':
      return s.complete
        ? `✓ Fully synced (${s.serverCount}).`
        : `Synced ${s.serverCount}${s.profileTotal !== null ? ` of ${s.profileTotal}` : ''}.`;
    default: return '';
  }
}
```

Then in `initPopup()`, wire the button (poll status every ~1.5s while running):

```ts
  const syncBtn = el<HTMLButtonElement>('syncCheckins');
  const syncStatus = el<HTMLElement>('syncStatus');
  if (syncBtn && syncStatus) {
    const render = (s: SyncStatusView) => {
      syncStatus.textContent = formatSyncStatus(s);
      syncBtn.disabled = s.running;
    };
    const poll = () => {
      chrome.runtime.sendMessage({ type: 'checkin-sync:status' }, (s?: SyncStatusView) => {
        if (!s) return;
        render(s);
        if (s.running) setTimeout(poll, 1500);
      });
    };
    syncBtn.addEventListener('click', () => {
      syncBtn.disabled = true;
      syncStatus.textContent = 'Starting…';
      chrome.runtime.sendMessage({ type: 'checkin-sync:start' }, () => poll());
    });
    poll(); // reflect an in-progress run when the popup (re)opens
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd extension && npx vitest run src/popup/popup.test.ts`
Expected: PASS.

- [ ] **Step 6: Full extension suite + typecheck**

Run: `cd extension && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/src/popup/popup.html extension/src/popup/popup.ts extension/src/popup/popup.test.ts
git commit -m "feat(extension/popup): 'Sync my check-ins' button + progress (#145)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Update `spec.md`

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Add the data model**

In §3 (after §3.13 `enrich_failures`, before `schema_version`), add a `checkin_sync_state` subsection documenting the table from Task 1 (columns `telegram_id` PK/FK, `deepest_max_id`, `complete`, `updated_at`) and noting it is the resumable cursor for the extension check-in sync (v13). Bump the migration-history list (§3.16) with v13.

- [ ] **Step 2: Document the endpoints**

In §4, under the HTTP API section (after the `/enrich/*` entry), add:
- `GET /checkins/sync/state` — auth like `/match`; returns `{ username, deepest_max_id, complete, serverCount, profileTotal }`; `409 not_linked` when no linked username.
- `POST /checkins/sync` — body `{ html, maxId? }`; parses the relayed feed page (`parseCheckinFeedPage`), upserts each beer by bid and `mergeCheckin`s, advances `checkin_sync_state`; returns `{ merged, alreadyKnown, pageSize, nextMaxId, profileTotal, serverCount, complete }`; `409 not_linked`, `502 blocked`.

Note that `checkins` now has a **second writer** besides `/import`: the client-relay sync channel, beer-resolved by canonical bid.

- [ ] **Step 3: Verify and commit**

Re-read the edited sections for consistency with Tasks 1/5/6.

```bash
git add spec.md
git commit -m "docs(spec): checkin_sync_state + /checkins/sync endpoints (#145)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: Update `docs/extension-install-uk.md` + release bump

**Files:**
- Modify: `docs/extension-install-uk.md`
- Modify: `extension/package.json`
- Modify: `extension/CHANGELOG.md`

- [ ] **Step 1: Document the popup button (Ukrainian)**

Add a section to `docs/extension-install-uk.md` describing the new **«Sync my check-ins»** popup button: that `/link` у боті — обов'язкова передумова; що кнопка завантажує чекіни з твоєї сесії Untappd і відправляє на сервер; що для великої історії кнопку треба натиснути кілька разів («tap again to continue»), і що повне покриття досягається за кілька запусків. Match the file's existing tone and structure.

- [ ] **Step 2: Bump version**

In `extension/package.json`, change `"version": "0.6.1"` → `"version": "0.7.0"`.

- [ ] **Step 3: Add a CHANGELOG entry**

Prepend a `## 0.7.0` section to `extension/CHANGELOG.md` describing the on-demand check-in sync (button, resumable, `/link` required), matching the file's existing format.

- [ ] **Step 4: Final full verification**

Run: `npm test`
Run: `cd extension && npm test && npx tsc --noEmit`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/extension-install-uk.md extension/package.json extension/CHANGELOG.md
git commit -m "docs(extension): document check-in sync button + cut 0.7.0 (#145)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification checklist

- [ ] `npm test` (server) green.
- [ ] `cd extension && npm test` (vitest) green; `npx tsc --noEmit` clean.
- [ ] Manual smoke (per `superpowers:verification-before-completion`): load the unpacked extension, link an Untappd account in the bot, open the popup, click **Sync my check-ins**, confirm the count climbs and `checkins` rows appear server-side; click again on a large history and confirm it resumes deeper rather than re-walking the top.
- [ ] `spec.md` and `docs/extension-install-uk.md` updated in the same branch (CLAUDE.md gate).
- [ ] Open PR; wait for AI review; address comments (per the PR-review-loop habit).
