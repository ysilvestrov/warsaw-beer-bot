# Daily Status Reliable Scheduling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daily admin status digest fire reliably at ~09:00 Europe/Warsaw without depending on node-cron's flaky timezone scheduling, with morning catch-up after a restart/deploy.

**Architecture:** Replace the single `{ timezone: 'Europe/Warsaw' }` cron with a plain UTC cron `*/15 * * * *` plus a startup check. A pure function `shouldSendDailyStatus` decides — based on Warsaw local time and a persisted "last sent date" — whether to send. Idempotency is keyed on the Warsaw calendar date stored in a new generic `job_state` table.

**Tech Stack:** TypeScript, better-sqlite3, node-cron, Telegraf, Vitest.

**Design doc:** `docs/superpowers/specs/2026-06-21-daily-status-reliable-scheduling-design.md`

---

### Task 1: `job_state` table + storage module

**Files:**
- Modify: `src/storage/schema.ts` (append migration after `version: 14`)
- Create: `src/storage/job_state.ts`
- Test: `src/storage/job_state.test.ts`

- [ ] **Step 1: Add the migration**

In `src/storage/schema.ts`, the `MIGRATIONS` array ends with the `version: 14` entry (the `}` before the closing `];` at line ~215). Append a new entry as the last element of the array:

```typescript
  {
    version: 15,
    sql: `
      CREATE TABLE job_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
```

- [ ] **Step 2: Write the failing test**

Create `src/storage/job_state.test.ts`:

```typescript
import { openDb } from './db';
import { migrate } from './schema';
import { getJobState, setJobState } from './job_state';

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('getJobState: returns null for an unknown key', () => {
  const db = emptyDb();
  expect(getJobState(db, 'nope')).toBeNull();
});

test('setJobState then getJobState: round-trips the value', () => {
  const db = emptyDb();
  setJobState(db, 'daily_status_last_sent', '2026-06-21');
  expect(getJobState(db, 'daily_status_last_sent')).toBe('2026-06-21');
});

test('setJobState: upserts (updates in place, no duplicate row)', () => {
  const db = emptyDb();
  setJobState(db, 'k', '2026-06-21');
  setJobState(db, 'k', '2026-06-22');
  expect(getJobState(db, 'k')).toBe('2026-06-22');
  const count = (db.prepare('SELECT COUNT(*) AS n FROM job_state').get() as { n: number }).n;
  expect(count).toBe(1);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/storage/job_state.test.ts`
Expected: FAIL — cannot find module `./job_state`.

- [ ] **Step 4: Write the storage module**

Create `src/storage/job_state.ts`:

```typescript
import type { DB } from './db';

// Generic single-row-per-key store for small bits of cross-restart job state
// (e.g. the Warsaw date the daily status digest last went out). Mirrors the
// upsert style of checkin_sync_state.ts.
export function getJobState(db: DB, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM job_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setJobState(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO job_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/storage/job_state.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/storage/schema.ts src/storage/job_state.ts src/storage/job_state.test.ts
git commit -m "feat(storage): add job_state key-value table"
```

---

### Task 2: `shouldSendDailyStatus` pure decision function

**Files:**
- Modify: `src/jobs/daily-status.ts` (add helper + exported function near the top, after the existing `warsawStamp`)
- Test: `src/jobs/daily-status.test.ts` (add a describe/test block)

- [ ] **Step 1: Write the failing tests**

Add to `src/jobs/daily-status.test.ts` (extend the import on line 5 and append the tests). Change the import line to:

```typescript
import { buildStatusMessage, dailyStatus, shouldSendDailyStatus } from './daily-status';
```

Then append:

```typescript
// June = CEST (UTC+2): 07:00Z = 09:00 Warsaw. January = CET (UTC+1): 08:00Z = 09:00 Warsaw.
test('shouldSendDailyStatus: before window (08:59 Warsaw) → no send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T06:59:00Z'), lastSentDate: null });
  expect(r).toEqual({ send: false, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: window open (09:00 Warsaw), not yet sent → send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T07:00:00Z'), lastSentDate: null });
  expect(r).toEqual({ send: true, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: late in window (11:59 Warsaw) → send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T09:59:00Z'), lastSentDate: null });
  expect(r).toEqual({ send: true, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: window closed (12:00 Warsaw) → no send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T10:00:00Z'), lastSentDate: null });
  expect(r).toEqual({ send: false, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: in window but already sent today → no send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T07:00:00Z'), lastSentDate: '2026-06-21' });
  expect(r).toEqual({ send: false, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: in window, last sent yesterday → send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T07:00:00Z'), lastSentDate: '2026-06-20' });
  expect(r).toEqual({ send: true, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: winter CET, 09:00 Warsaw = 08:00Z → send with correct date', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-01-15T08:00:00Z'), lastSentDate: null });
  expect(r).toEqual({ send: true, dateKey: '2026-01-15' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/jobs/daily-status.test.ts`
Expected: FAIL — `shouldSendDailyStatus` is not exported.

- [ ] **Step 3: Implement the function**

In `src/jobs/daily-status.ts`, immediately after the existing `warsawStamp` function (ends ~line 37), add:

```typescript
// Warsaw-local calendar date ("YYYY-MM-DD") and hour (0–23) for d. Uses the
// same Europe/Warsaw zone as warsawStamp so DST is handled by Intl, not by us.
function warsawDateAndHour(d: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)!.value;
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0; // some ICU builds render midnight as "24"
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

export interface ShouldSendArgs {
  now: Date;
  lastSentDate: string | null;
  windowStartHour?: number;
  windowEndHour?: number;
}

// Pure decision: send the digest iff the current Warsaw hour is within
// [windowStartHour, windowEndHour) and we have not already sent for this
// Warsaw date. dateKey is the date to persist on a successful send.
export function shouldSendDailyStatus(args: ShouldSendArgs): { send: boolean; dateKey: string } {
  const { now, lastSentDate, windowStartHour = 9, windowEndHour = 12 } = args;
  const { date, hour } = warsawDateAndHour(now);
  const inWindow = hour >= windowStartHour && hour < windowEndHour;
  return { send: inWindow && lastSentDate !== date, dateKey: date };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/daily-status.test.ts`
Expected: PASS (existing tests + 7 new `shouldSendDailyStatus` tests).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "feat(daily-status): add shouldSendDailyStatus window/idempotency decision"
```

---

### Task 3: Rework `dailyStatus` into a window-aware, idempotent orchestrator

**Files:**
- Modify: `src/jobs/daily-status.ts` (the `dailyStatus` function, ~lines 48-63)
- Test: `src/jobs/daily-status.test.ts` (update existing `dailyStatus` tests + add new ones)

- [ ] **Step 1: Update the failing tests**

In `src/jobs/daily-status.test.ts`:

Add these imports near the top (the `openDb`/`migrate` imports already exist):

```typescript
import { getJobState } from '../storage/job_state';
```

Replace the existing test `dailyStatus: sends the built message once when notifyAdmin is set` (~lines 65-73) with the block below, and append the new tests:

```typescript
test('dailyStatus: sends once in window and records the Warsaw date', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  await dailyStatus({
    db, log: silentLog,
    notifyAdmin: async (msg: string) => { sent.push(msg); },
    now: () => new Date('2026-06-21T07:00:00Z'), // 09:00 Warsaw
  });
  expect(sent.length).toBe(1);
  expect(getJobState(db, 'daily_status_last_sent')).toBe('2026-06-21');
});

test('dailyStatus: no-op outside the window', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  await dailyStatus({
    db, log: silentLog,
    notifyAdmin: async (msg: string) => { sent.push(msg); },
    now: () => new Date('2026-06-21T11:00:00Z'), // 13:00 Warsaw
  });
  expect(sent.length).toBe(0);
  expect(getJobState(db, 'daily_status_last_sent')).toBeNull();
});

test('dailyStatus: no-op when already sent today (idempotent across ticks)', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const deps = {
    db, log: silentLog,
    notifyAdmin: async (msg: string) => { sent.push(msg); },
    now: () => new Date('2026-06-21T07:00:00Z'),
  };
  await dailyStatus(deps);
  await dailyStatus(deps); // second tick same morning
  expect(sent.length).toBe(1);
});

test('dailyStatus: does NOT record the date when send fails (retried next tick)', async () => {
  const db = emptyDb();
  let calls = 0;
  const deps = {
    db, log: silentLog,
    notifyAdmin: async () => { calls += 1; throw new Error('telegram down'); },
    now: () => new Date('2026-06-21T07:00:00Z'),
  };
  await dailyStatus(deps);
  expect(getJobState(db, 'daily_status_last_sent')).toBeNull();
  await dailyStatus(deps); // retry: should attempt again, not be blocked
  expect(calls).toBe(2);
});
```

Note: the existing test `dailyStatus: no-op when notifyAdmin is undefined` (~line 58) stays as-is and still passes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/jobs/daily-status.test.ts`
Expected: FAIL — current `dailyStatus` always sends and never writes `job_state`, so the date-recording, window no-op, and failure-no-record assertions fail.

- [ ] **Step 3: Rework the orchestrator**

In `src/jobs/daily-status.ts`:

Add the import at the top (after the existing imports):

```typescript
import { getJobState, setJobState } from '../storage/job_state';
```

Replace the entire `dailyStatus` function body (currently ~lines 48-63) with:

```typescript
const DAILY_STATUS_KEY = 'daily_status_last_sent';

// Daily admin health digest. Runs on a frequent UTC tick (and once at startup);
// the Warsaw-window + last-sent-date check makes it self-throttle to one send per
// Warsaw day and catch up after a restart inside the morning window. No-op when
// notifyAdmin is undefined (ADMIN_TELEGRAM_ID not set).
export async function dailyStatus(deps: DailyStatusDeps): Promise<void> {
  const { db, log, notifyAdmin } = deps;
  if (!notifyAdmin) {
    log.debug('daily-status: no ADMIN_TELEGRAM_ID, skipping');
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  const lastSentDate = getJobState(db, DAILY_STATUS_KEY);
  const { send, dateKey } = shouldSendDailyStatus({ now, lastSentDate });
  if (!send) {
    log.debug({ dateKey, lastSentDate }, 'daily-status: outside window or already sent');
    return;
  }
  const metrics = collectStatus(db, now);
  const text = buildStatusMessage(metrics, warsawStamp(now));
  try {
    await notifyAdmin(text);
    setJobState(db, DAILY_STATUS_KEY, dateKey);
    log.info({ lastScrapeHoursAgo: metrics.lastScrapeHoursAgo, dateKey }, 'daily-status sent');
  } catch (e) {
    log.error({ err: e }, 'daily-status send failed');
  }
}
```

(Delete the old comment block at lines 46-47 that this replaces.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/jobs/daily-status.test.ts`
Expected: PASS (all buildStatusMessage, shouldSendDailyStatus, and dailyStatus tests).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "feat(daily-status): window-aware idempotent digest with persisted last-sent date"
```

---

### Task 4: Wire into index.ts — UTC tick + startup catch-up

**Files:**
- Modify: `src/index.ts` (the daily-status cron block ~lines 151-158; startup section ~line 171)

- [ ] **Step 1: Replace the timezone cron with a UTC tick**

In `src/index.ts`, replace the daily-status cron block (the comment at ~lines 151-154 plus the `cron.schedule('0 9 * * *', …, { timezone: 'Europe/Warsaw' })` call at ~155-158) with:

```typescript
    // daily-status: admin health digest, ~09:00 Warsaw. We run a plain UTC tick
    // every 15 min instead of a node-cron timezone schedule — node-cron's
    // timezone tick proved flaky (silently skipped 2026-06-21) while UTC ticks
    // are reliable. dailyStatus itself checks the Warsaw [09:00,12:00) window and
    // an idempotency date in job_state, so it sends exactly once per Warsaw day
    // and catches up if the bot was down at 09:00. Self-noops when
    // ADMIN_TELEGRAM_ID is unset.
    cron.schedule('*/15 * * * *', () => {
      dailyStatus({ db, log, notifyAdmin })
        .catch((e) => log.error({ err: e }, 'daily-status cron'));
    }),
```

- [ ] **Step 2: Add the startup catch-up call**

In `src/index.ts`, right after `bot.launch();` / `log.info('bot launched');` (~lines 170-171), add:

```typescript
  // Startup catch-up: if the bot was down/redeploying at 09:00 Warsaw but is up
  // within the morning window, emit today's digest now instead of waiting for the
  // next 15-min tick. Idempotent via job_state, so a normal start is a no-op once
  // the day's digest already went out.
  dailyStatus({ db, log, notifyAdmin })
    .catch((e) => log.error({ err: e }, 'daily-status startup'));
```

- [ ] **Step 3: Typecheck and run the full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — no type errors, all tests green.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): drive daily-status via UTC tick + startup catch-up"
```

---

### Task 5: Update spec.md

**Files:**
- Modify: `spec.md` (background-jobs table ~line 734; startup-jobs paragraph ~lines 736-739)

- [ ] **Step 1: Update the background-jobs table row**

In `spec.md`, replace the `dailyStatus` row (~line 734):

```markdown
| `dailyStatus` | `0 9 * * *` | щоденний health-дайджест адміну (лише якщо є `ADMIN_TELEGRAM_ID`) |
```

with:

```markdown
| `dailyStatus` | `*/15 * * * *` | health-дайджест адміну. UTC-тік; джоба сама шле раз на варшавську добу у вікні `[09:00, 12:00)` Europe/Warsaw, ідемпотентно за `job_state.daily_status_last_sent` (лише якщо є `ADMIN_TELEGRAM_ID`). Раніше `0 9 * * * {tz}` — timezone-тік node-cron виявився ненадійним |
```

- [ ] **Step 2: Add dailyStatus to the startup-jobs paragraph**

In `spec.md`, the startup-jobs paragraph (~lines 736-739) lists `dedupeBreweryAliases`, `cleanupPollutedOntap`, `cleanupOldSnapshots`. Add `dailyStatus` to that list with a note, e.g. append before the closing sentence:

```markdown
Додатково після `bot.launch()` один раз викликається `dailyStatus` (catch-up: якщо бот
був недоступний о 09:00, але піднявся в межах ранкового вікна — дайджест виходить одразу;
ідемпотентний за `job_state`).
```

- [ ] **Step 3: Note the job_state table**

In `spec.md`, near the schema/migrations description, add a one-line mention that `job_state(key, value)` (migration v15) holds small cross-restart job state (currently `daily_status_last_sent`). If there is no schema-table list to extend, add the sentence to the startup-jobs paragraph from Step 2.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(spec): daily-status UTC tick + Warsaw window + job_state"
```

---

## Self-Review

**Spec coverage:**
- Remove `{ timezone }`, use `*/15 * * * *` UTC → Task 4. ✓
- Pure `shouldSendDailyStatus` with `[09:00,12:00)` window → Task 2. ✓
- Startup catch-up after `bot.launch()` → Task 4. ✓
- Persisted `job_state.daily_status_last_sent` (Warsaw date) → Task 1 + Task 3. ✓
- Date recorded only after successful send; retry on failure → Task 3 (test + impl). ✓
- No-op when `notifyAdmin` undefined preserved → Task 3. ✓
- Unit tests: window edges, date rollover, CET/CEST, idempotency, failure-no-record → Tasks 2 & 3. ✓
- spec.md updated same PR → Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code/test step has full content. ✓

**Type consistency:** `getJobState`/`setJobState` (Task 1) used identically in Task 3; `shouldSendDailyStatus` signature/return `{ send, dateKey }` consistent across Tasks 2 & 3; `DailyStatusDeps` unchanged (already has `db`, `log`, `notifyAdmin?`, `now?`). ✓

**Note on extension docs:** No `extension/**` changes → `docs/extension-install-uk.md` not affected.
