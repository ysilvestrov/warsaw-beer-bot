# Daily Status Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the admin a short Ukrainian Telegram status digest once a day (09:00 Warsaw) — mostly health, two content lines — using only metrics derivable from the existing schema.

**Architecture:** A pure `collectStatus(db, now)` gathers metrics via read-only SQL (+ `fs.statSync(db.name)` for file size); a pure `buildStatusMessage(metrics, date)` formats the plain-text message; `dailyStatus(deps)` ties them together and sends via the existing `notifyAdmin`, no-op when `ADMIN_TELEGRAM_ID` is unset. Wired as a `0 9 * * *` cron.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, node-cron, pino, Jest. No new tables/columns, no env.

**Spec:** `docs/superpowers/specs/2026-06-04-daily-status-digest-design.md`

---

### Task 1: Storage — `collectStatus`

**Files:**
- Create: `src/storage/stats.ts`
- Test: `src/storage/stats.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/storage/stats.test.ts`:

```ts
import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub } from './pubs';
import { upsertBeer } from './beers';
import { createSnapshot, insertTaps } from './snapshots';
import { collectStatus } from './stats';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function tap(beerRef: string) {
  return { tap_number: 1, beer_ref: beerRef, brewery_ref: null, abv: null, ibu: null, style: null, u_rating: null };
}

function seed() {
  const db = fresh();
  // beers: matched+rated, matched+no-rating, orphan
  upsertBeer(db, { untappd_id: 100, name: 'A', brewery: 'X', style: null, abv: null, rating_global: 4.0, normalized_name: 'a', normalized_brewery: 'x' });
  upsertBeer(db, { untappd_id: 101, name: 'B', brewery: 'X', style: null, abv: null, rating_global: null, normalized_name: 'b', normalized_brewery: 'x' });
  upsertBeer(db, { untappd_id: null, name: 'C', brewery: 'X', style: null, abv: null, rating_global: null, normalized_name: 'c', normalized_brewery: 'x' });
  // users: one linked, one not
  db.prepare('INSERT INTO user_profiles (telegram_id, untappd_username) VALUES (?, ?)').run(1, 'bob');
  db.prepare('INSERT INTO user_profiles (telegram_id, untappd_username) VALUES (?, ?)').run(2, null);
  // pubs + snapshots
  const a = upsertPub(db, { slug: 'a', name: 'a', address: null, lat: null, lon: null });
  const b = upsertPub(db, { slug: 'b', name: 'b', address: null, lat: null, lon: null });
  const aOld = createSnapshot(db, a, '2026-06-01T12:00:00Z'); // >24h ago
  insertTaps(db, aOld, [tap('B1')]);                          // B1 seen in the past
  const aNew = createSnapshot(db, a, '2026-06-04T06:00:00Z'); // 6h ago, latest for a
  insertTaps(db, aNew, [tap('A1'), tap('A2')]);
  const bNew = createSnapshot(db, b, '2026-06-04T09:00:00Z'); // 3h ago, latest for b
  insertTaps(db, bNew, [tap('B1')]);                          // B1 again → NOT new
  return db;
}

test('collectStatus computes all metrics', () => {
  const db = seed();
  const m = collectStatus(db, new Date('2026-06-04T12:00:00Z'));
  expect(m).toEqual({
    lastScrapeHoursAgo: 3,
    pubsScraped24h: 2,
    beersTotal: 3,
    beersMatched: 2,
    orphansPending: 1,
    ratingsMissing: 1,
    snapshots: 3,
    taps: 4,
    dbSizeMb: null,
    usersTotal: 2,
    usersLinked: 1,
    onTapDistinct: 3, // A1, A2, B1 (latest snapshots of a and b)
    onTapPubs: 2,
    newOnTap24h: 2,   // A1, A2 (B1 also appears in the old snapshot → excluded)
  });
});

test('collectStatus with empty DB: null scrape, zero counts', () => {
  const db = fresh();
  const m = collectStatus(db, new Date('2026-06-04T12:00:00Z'));
  expect(m.lastScrapeHoursAgo).toBeNull();
  expect(m.snapshots).toBe(0);
  expect(m.onTapDistinct).toBe(0);
  expect(m.newOnTap24h).toBe(0);
  expect(m.dbSizeMb).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/stats.test.ts`
Expected: FAIL — cannot find module `./stats`.

- [ ] **Step 3: Write minimal implementation**

Create `src/storage/stats.ts`:

```ts
import fs from 'fs';
import type { DB } from './db';

export interface StatusMetrics {
  lastScrapeHoursAgo: number | null;
  pubsScraped24h: number;
  beersTotal: number;
  beersMatched: number;
  orphansPending: number;
  ratingsMissing: number;
  snapshots: number;
  taps: number;
  dbSizeMb: number | null;
  usersTotal: number;
  usersLinked: number;
  onTapDistinct: number;
  onTapPubs: number;
  newOnTap24h: number;
}

export function collectStatus(db: DB, now: Date): StatusMetrics {
  const nowMs = now.getTime();
  const cutoff24 = new Date(nowMs - 24 * 3600 * 1000).toISOString();

  const count = (sql: string, params: unknown[] = []): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;

  const maxAt = (db.prepare('SELECT MAX(snapshot_at) AS m FROM tap_snapshots').get() as { m: string | null }).m;
  const lastScrapeHoursAgo = maxAt === null ? null : (nowMs - Date.parse(maxAt)) / 3600000;

  const latestCte = `
    WITH latest AS (
      SELECT s.id AS id, s.pub_id AS pub_id FROM tap_snapshots s
      INNER JOIN (SELECT pub_id, MAX(snapshot_at) AS m FROM tap_snapshots GROUP BY pub_id) x
        ON x.pub_id = s.pub_id AND x.m = s.snapshot_at
    )`;

  let dbSizeMb: number | null = null;
  if (db.name && db.name !== ':memory:') {
    try { dbSizeMb = Math.round(fs.statSync(db.name).size / 1e5) / 10; } catch { dbSizeMb = null; }
  }

  return {
    lastScrapeHoursAgo,
    pubsScraped24h: count('SELECT COUNT(DISTINCT pub_id) AS c FROM tap_snapshots WHERE snapshot_at >= ?', [cutoff24]),
    beersTotal: count('SELECT COUNT(*) AS c FROM beers'),
    beersMatched: count('SELECT COUNT(*) AS c FROM beers WHERE untappd_id IS NOT NULL'),
    orphansPending: count('SELECT COUNT(*) AS c FROM beers WHERE untappd_id IS NULL'),
    ratingsMissing: count('SELECT COUNT(*) AS c FROM beers WHERE untappd_id IS NOT NULL AND rating_global IS NULL'),
    snapshots: count('SELECT COUNT(*) AS c FROM tap_snapshots'),
    taps: count('SELECT COUNT(*) AS c FROM taps'),
    dbSizeMb,
    usersTotal: count('SELECT COUNT(*) AS c FROM user_profiles'),
    usersLinked: count('SELECT COUNT(*) AS c FROM user_profiles WHERE untappd_username IS NOT NULL'),
    onTapDistinct: count(`${latestCte} SELECT COUNT(DISTINCT t.beer_ref) AS c FROM taps t WHERE t.snapshot_id IN (SELECT id FROM latest)`),
    onTapPubs: count(`${latestCte} SELECT COUNT(DISTINCT l.pub_id) AS c FROM latest l WHERE l.id IN (SELECT snapshot_id FROM taps)`),
    newOnTap24h: count(
      `SELECT COUNT(*) AS c FROM (
         SELECT DISTINCT t.beer_ref FROM taps t JOIN tap_snapshots s ON s.id = t.snapshot_id
         WHERE s.snapshot_at >= ?
           AND t.beer_ref NOT IN (
             SELECT t2.beer_ref FROM taps t2 JOIN tap_snapshots s2 ON s2.id = t2.snapshot_id
             WHERE s2.snapshot_at < ?
           )
       )`, [cutoff24, cutoff24]),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/storage/stats.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/stats.ts src/storage/stats.test.ts
git commit -m "feat(storage): collectStatus metrics for daily digest"
```

---

### Task 2: Job — `buildStatusMessage` (pure formatter)

**Files:**
- Create: `src/jobs/daily-status.ts`
- Test: `src/jobs/daily-status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/jobs/daily-status.test.ts`:

```ts
import type { StatusMetrics } from '../storage/stats';
import { buildStatusMessage } from './daily-status';

const base: StatusMetrics = {
  lastScrapeHoursAgo: 9.3, pubsScraped24h: 42,
  beersTotal: 12840, beersMatched: 10000, orphansPending: 287, ratingsMissing: 134,
  snapshots: 1976, taps: 29459, dbSizeMb: 13.2,
  usersTotal: 31, usersLinked: 24,
  onTapDistinct: 1118, onTapPubs: 42, newOnTap24h: 37,
};

test('buildStatusMessage: full message exact string', () => {
  const out = buildStatusMessage(base, '2026-06-05 09:00');
  expect(out).toBe(
    [
      '🍺 Статус бота — 2026-06-05 09:00',
      '',
      'Стан',
      '• Останній скрейп: 9 год тому ✅ (42 паби за 24 год)',
      "• Каталог: 12 840 пив · 78% зматчено · 287 orphan'ів у черзі",
      '• Рейтинги: 134 зматчених пив без рейтингу',
      "• БД: 1 976 snapshot'ів / 29 459 кранів · 13.2 МБ",
      "• Користувачі: 31 профіль (24 прив'язано)",
      '',
      'На кранах зараз',
      '• 1 118 унікальних пив у 42 пабах',
      '• Нових на кранах (24 год): 37',
    ].join('\n'),
  );
});

test('buildStatusMessage: stale scrape (>14h) shows warning flag', () => {
  const out = buildStatusMessage({ ...base, lastScrapeHoursAgo: 15 }, '2026-06-05 09:00');
  expect(out).toContain('• Останній скрейп: 15 год тому ⚠️ (42 паби за 24 год)');
});

test('buildStatusMessage: no snapshots shows немає даних', () => {
  const out = buildStatusMessage({ ...base, lastScrapeHoursAgo: null }, '2026-06-05 09:00');
  expect(out).toContain('• Останній скрейп: немає даних ⚠️');
});

test('buildStatusMessage: null dbSizeMb omits size suffix', () => {
  const out = buildStatusMessage({ ...base, dbSizeMb: null }, '2026-06-05 09:00');
  expect(out).toContain("• БД: 1 976 snapshot'ів / 29 459 кранів\n");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/jobs/daily-status.test.ts`
Expected: FAIL — cannot find module `./daily-status`.

- [ ] **Step 3: Write minimal implementation**

Create `src/jobs/daily-status.ts`:

```ts
import type { StatusMetrics } from '../storage/stats';

const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function buildStatusMessage(m: StatusMetrics, date: string): string {
  const matchPct = m.beersTotal > 0 ? Math.round((m.beersMatched / m.beersTotal) * 100) : 0;
  const scrapeLine = m.lastScrapeHoursAgo === null
    ? 'немає даних ⚠️'
    : `${Math.round(m.lastScrapeHoursAgo)} год тому ${m.lastScrapeHoursAgo > 14 ? '⚠️' : '✅'} (${m.pubsScraped24h} паби за 24 год)`;
  const sizeSuffix = m.dbSizeMb === null ? '' : ` · ${m.dbSizeMb} МБ`;
  return [
    `🍺 Статус бота — ${date}`,
    '',
    'Стан',
    `• Останній скрейп: ${scrapeLine}`,
    `• Каталог: ${group(m.beersTotal)} пив · ${matchPct}% зматчено · ${group(m.orphansPending)} orphan'ів у черзі`,
    `• Рейтинги: ${group(m.ratingsMissing)} зматчених пив без рейтингу`,
    `• БД: ${group(m.snapshots)} snapshot'ів / ${group(m.taps)} кранів${sizeSuffix}`,
    `• Користувачі: ${group(m.usersTotal)} профіль (${group(m.usersLinked)} прив'язано)`,
    '',
    'На кранах зараз',
    `• ${group(m.onTapDistinct)} унікальних пив у ${m.onTapPubs} пабах`,
    `• Нових на кранах (24 год): ${m.newOnTap24h}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/jobs/daily-status.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "feat(jobs): buildStatusMessage (Ukrainian plain-text digest)"
```

---

### Task 3: Job — `dailyStatus` (collect + format + send)

**Files:**
- Modify: `src/jobs/daily-status.ts`
- Test: `src/jobs/daily-status.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/daily-status.test.ts`:

```ts
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { dailyStatus } from './daily-status';

const silentLog = pino({ level: 'silent' });

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('dailyStatus: no-op when notifyAdmin is undefined', async () => {
  const db = emptyDb();
  await expect(
    dailyStatus({ db, log: silentLog, now: () => new Date('2026-06-04T07:00:00Z') }),
  ).resolves.toBeUndefined();
});

test('dailyStatus: sends the built message once when notifyAdmin is set', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  await dailyStatus({
    db, log: silentLog,
    notifyAdmin: async (msg: string) => { sent.push(msg); },
    now: () => new Date('2026-06-04T07:00:00Z'),
  });
  expect(sent).toHaveLength(1);
  expect(sent[0].startsWith('🍺 Статус бота — ')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/jobs/daily-status.test.ts`
Expected: FAIL — `dailyStatus` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to the top of `src/jobs/daily-status.ts` (imports) and bottom (new exports):

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import { collectStatus } from '../storage/stats';
```

```ts
// Formats a Date as "YYYY-MM-DD HH:mm" in Warsaw time. sv-SE yields the
// space-separated, 24h ISO-like form we want.
function warsawStamp(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(',', '');
}

export interface DailyStatusDeps {
  db: DB;
  log: pino.Logger;
  notifyAdmin?: (msg: string) => Promise<void>;
  now?: () => Date;
}

// Daily admin health digest. No-op when notifyAdmin is undefined
// (ADMIN_TELEGRAM_ID not set), matching the other admin alerts.
export async function dailyStatus(deps: DailyStatusDeps): Promise<void> {
  const { db, log, notifyAdmin } = deps;
  if (!notifyAdmin) {
    log.debug('daily-status: no ADMIN_TELEGRAM_ID, skipping');
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  const metrics = collectStatus(db, now);
  const text = buildStatusMessage(metrics, warsawStamp(now));
  try {
    await notifyAdmin(text);
    log.info({ lastScrapeHoursAgo: metrics.lastScrapeHoursAgo }, 'daily-status sent');
  } catch (e) {
    log.error({ err: e }, 'daily-status send failed');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/jobs/daily-status.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "feat(jobs): dailyStatus job (collect + send, no-op without admin)"
```

---

### Task 4: Wiring — daily cron in `src/index.ts`

**Files:**
- Modify: `src/index.ts` (import after line 28; cron in the `cronJobs` array)

- [ ] **Step 1: Add the import**

After `src/index.ts:28` (`import { cleanupOldSnapshots } ...` — added by the prior feature; if absent, add after the `refreshTapRatings` import), add:

```ts
import { dailyStatus } from './jobs/daily-status';
```

- [ ] **Step 2: Add the daily cron**

In `src/index.ts`, inside the `const cronJobs = [ ... ]` array, add a new element after the `cleanup-old-snapshots` schedule block (the last element before the closing `];`):

```ts
    // daily-status: admin health digest at 09:00 Warsaw, after the overnight
    // jobs (00:00 ontap, 03:00 untappd, 05:00 cleanup) have settled. Async →
    // .catch. Self-noops when ADMIN_TELEGRAM_ID is unset.
    cron.schedule('0 9 * * *', () => {
      dailyStatus({ db, log, notifyAdmin })
        .catch((e) => log.error({ err: e }, 'daily-status cron'));
    }),
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

(`notifyAdmin` is already defined in `main()` as `const notifyAdmin = env.ADMIN_TELEGRAM_ID ? ... : undefined` — `dailyStatus` accepts the optional and self-noops, so no guard is needed.)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire dailyStatus (daily 09:00 cron)"
```

---

### Task 5: Spec update — `spec.md`

**Files:**
- Modify: `spec.md` — §4 "Фонові джоби" table

- [ ] **Step 1: Add the job row**

In `spec.md`, in the "Фонові джоби (node-cron, у процесі)" table, add a row after
the `cleanupOldSnapshots` row (added by the prior feature):

```
| `dailyStatus` | `0 9 * * *` | щоденний health-дайджест адміну (лише якщо є `ADMIN_TELEGRAM_ID`) |
```

- [ ] **Step 2: Verify**

Run: `grep -n "dailyStatus" spec.md`
Expected: one match in the §4 jobs table.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document daily status digest job"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npx jest`
Expected: all tests pass (including the new `stats` + `daily-status` tests).

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Finish the branch**

Use the superpowers:finishing-a-development-branch skill to merge / open a PR.

---

## Notes for the implementer

- `DB` is the better-sqlite3 handle type from `src/storage/db.ts`; `db.name` is the
  database file path (`':memory:'` for in-memory test DBs), used for `fs.statSync`.
- `.get(...params)` returns the first row or `undefined`; every count query here
  always returns exactly one row (aggregate), so the `as { c: number }` cast is safe.
- `upsertBeer` shape: `{ untappd_id, name, brewery, style, abv, rating_global,
  normalized_name, normalized_brewery }` (see `src/storage/beers.ts`); `untappd_id: null`
  makes an orphan.
- The digest is **plain text** — do not add `parse_mode`/HTML. `notifyAdmin` sends a
  plain `sendMessage`.
- Do not add any table or column — the metrics are intentionally derived from the
  existing schema only.
