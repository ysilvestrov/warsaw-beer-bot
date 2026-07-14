# Extension /match usage in the daily status digest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count `POST /match` extension traffic (split anonymous vs authenticated + beer volume) into a per-day table and surface the previous Warsaw day in the daily admin status digest.

**Architecture:** A new bounded `api_usage` aggregate table (one row per Warsaw date) is incremented best-effort on each accepted `/match` request. `collectStatus` reads the previous Warsaw day's row into three new `StatusMetrics` fields; `buildStatusMessage` renders one new digest line.

**Tech Stack:** Node.js, TypeScript, Vitest, better-sqlite3, Hono (API), pino.

**Spec:** `docs/superpowers/specs/2026-07/2026-07-14-extension-usage-status-design.md`

---

## File Structure

- `src/domain/warsaw-time.ts` — add `previousDate(date)` pure helper.
- `src/storage/schema.ts` — migration v17: `api_usage` table.
- `src/storage/api_usage.ts` — **new**: `recordMatchUsage`, `getUsageForDate`, `DailyUsage`.
- `src/api/routes/match.ts` — best-effort increment on each accepted request.
- `src/storage/stats.ts` — 3 new `StatusMetrics` fields from the previous Warsaw day.
- `src/jobs/daily-status.ts` — one new digest line.
- Tests: `warsaw-time.test.ts`, `api_usage.test.ts` (new), `api/index.test.ts`, `stats.test.ts`, `daily-status.test.ts`.
- `spec.md` — schema table + version + digest line.

**Implementer notes (zero codebase context assumed):**
- Run one test file: `npx vitest run <path>`; whole suite: `npm test`; typecheck: `npm run typecheck`.
- `tsconfig.json` does NOT set `noUncheckedIndexedAccess`.
- better-sqlite3 named params: `stmt.run({ name: value })` binds `@name` placeholders.
- Vitest globals are enabled — `test`/`it`/`expect`/`describe`/`vi` are available without imports.
- Commit after each task. You are in an isolated worktree; before committing verify `git rev-parse --show-toplevel` is the worktree path and `git branch --show-current` is the feature branch (NOT `main`).

---

## Task 1: `previousDate` helper

**Files:**
- Modify: `src/domain/warsaw-time.ts`
- Test: `src/domain/warsaw-time.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/warsaw-time.test.ts` (import the new symbol by adding `previousDate` to the existing import from `./warsaw-time`):

```ts
test('previousDate: normal day', () => {
  expect(previousDate('2026-06-05')).toBe('2026-06-04');
});
test('previousDate: month boundary', () => {
  expect(previousDate('2026-07-01')).toBe('2026-06-30');
});
test('previousDate: year boundary', () => {
  expect(previousDate('2026-01-01')).toBe('2025-12-31');
});
test('previousDate: non-leap February', () => {
  expect(previousDate('2026-03-01')).toBe('2026-02-28');
});
test('previousDate: leap February', () => {
  expect(previousDate('2028-03-01')).toBe('2028-02-29');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/warsaw-time.test.ts`
Expected: FAIL — `previousDate` is not exported.

- [ ] **Step 3: Implement**

Add to `src/domain/warsaw-time.ts` (below `warsawDateAndHour`):

```ts
// 'YYYY-MM-DD' → the previous calendar date, same format. Pure UTC math on the
// date-only value (no zone attached), so DST never applies.
export function previousDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/domain/warsaw-time.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/warsaw-time.ts src/domain/warsaw-time.test.ts
git commit -m "feat(status): add previousDate Warsaw-date helper"
```

---

## Task 2: `api_usage` table + storage module

**Files:**
- Modify: `src/storage/schema.ts` (MIGRATIONS array — latest is v16)
- Create: `src/storage/api_usage.ts`
- Test: `src/storage/api_usage.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/storage/api_usage.test.ts`:

```ts
import { expect, test } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { recordMatchUsage, getUsageForDate } from './api_usage';

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

test('getUsageForDate: zeros when no row exists', () => {
  expect(getUsageForDate(db(), '2026-07-14')).toEqual({
    anonRequests: 0, authedRequests: 0, beers: 0,
  });
});

test('recordMatchUsage: inserts then increments the same-day row', () => {
  const d = db();
  recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 3 });
  recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 2 });
  recordMatchUsage(d, { date: '2026-07-14', authed: true, beers: 5 });
  expect(getUsageForDate(d, '2026-07-14')).toEqual({
    anonRequests: 2, authedRequests: 1, beers: 10,
  });
});

test('recordMatchUsage: separate dates are independent rows', () => {
  const d = db();
  recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 1 });
  recordMatchUsage(d, { date: '2026-07-15', authed: true, beers: 4 });
  expect(getUsageForDate(d, '2026-07-14')).toEqual({ anonRequests: 1, authedRequests: 0, beers: 1 });
  expect(getUsageForDate(d, '2026-07-15')).toEqual({ anonRequests: 0, authedRequests: 1, beers: 4 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/storage/api_usage.test.ts`
Expected: FAIL — `Cannot find module './api_usage'` (and, once created, the table won't exist until Step 3's migration).

- [ ] **Step 3: Add the migration**

In `src/storage/api_usage.test.ts`'s dependency — `src/storage/schema.ts` — add a new entry to the `MIGRATIONS` array, immediately after the `version: 16` object and before the closing `];`:

```ts
  {
    version: 17,
    sql: `
      CREATE TABLE api_usage (
        date            TEXT PRIMARY KEY,
        anon_requests   INTEGER NOT NULL DEFAULT 0,
        authed_requests INTEGER NOT NULL DEFAULT 0,
        beers           INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
```

- [ ] **Step 4: Implement the storage module**

Create `src/storage/api_usage.ts`:

```ts
import type { DB } from './db';

export interface DailyUsage {
  anonRequests: number;
  authedRequests: number;
  beers: number;
}

// Best-effort per-request increment for one accepted /match call. Caller passes
// the Warsaw date, whether the caller was authenticated, and the requested beer
// count. One aggregate row per date (UPSERT), so growth is bounded.
export function recordMatchUsage(
  db: DB, args: { date: string; authed: boolean; beers: number },
): void {
  db.prepare(`
    INSERT INTO api_usage (date, anon_requests, authed_requests, beers)
    VALUES (@date, @anon, @authed, @beers)
    ON CONFLICT(date) DO UPDATE SET
      anon_requests   = anon_requests   + excluded.anon_requests,
      authed_requests = authed_requests + excluded.authed_requests,
      beers           = beers           + excluded.beers
  `).run({
    date: args.date,
    anon: args.authed ? 0 : 1,
    authed: args.authed ? 1 : 0,
    beers: args.beers,
  });
}

export function getUsageForDate(db: DB, date: string): DailyUsage {
  const row = db.prepare(
    'SELECT anon_requests, authed_requests, beers FROM api_usage WHERE date = ?',
  ).get(date) as { anon_requests: number; authed_requests: number; beers: number } | undefined;
  return {
    anonRequests: row?.anon_requests ?? 0,
    authedRequests: row?.authed_requests ?? 0,
    beers: row?.beers ?? 0,
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/storage/api_usage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/storage/schema.ts src/storage/api_usage.ts src/storage/api_usage.test.ts
git commit -m "feat(status): api_usage table + recordMatchUsage/getUsageForDate (migration v17)"
```

---

## Task 3: Count `/match` requests best-effort

**Files:**
- Modify: `src/api/routes/match.ts`
- Test: `src/api/index.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/api/index.test.ts`, add imports near the top (after the existing imports):

```ts
import { getUsageForDate } from '../storage/api_usage';
import { warsawDateAndHour } from '../domain/warsaw-time';
```

Add these two tests inside the `describe('createApiApp', ...)` block (e.g. after the existing `/match` tests):

```ts
  it('POST /match records anonymous usage for today', async () => {
    const d = deps();
    const app = createApiApp(d);
    await app.request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers: [{ brewery: 'X', name: 'Y' }, { brewery: 'A', name: 'B' }] }),
    });
    const today = warsawDateAndHour(new Date()).date;
    expect(getUsageForDate(d.db, today)).toEqual({ anonRequests: 1, authedRequests: 0, beers: 2 });
  });

  it('POST /match records authenticated usage when a valid token is sent', async () => {
    const d = deps();
    const app = createApiApp(d);
    await app.request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({ beers: [{ brewery: 'X', name: 'Y' }] }),
    });
    const today = warsawDateAndHour(new Date()).date;
    expect(getUsageForDate(d.db, today)).toEqual({ anonRequests: 0, authedRequests: 1, beers: 1 });
  });
```

(The `deps()` helper already seeds token `'tok'` for telegram id 555, so `Bearer tok` authenticates.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/api/index.test.ts`
Expected: FAIL — both new tests see zeros (no counting wired yet).

- [ ] **Step 3: Implement the increment**

In `src/api/routes/match.ts`, add these imports with the others:

```ts
import { recordMatchUsage } from '../../storage/api_usage';
import { warsawDateAndHour } from '../../domain/warsaw-time';
```

Inside the `app.post('/match', ...)` handler, the body currently starts:

```ts
    const telegramId = c.get('telegramId') ?? null;
    const { beers } = c.req.valid('json');
```

Immediately after those two lines, insert the best-effort counter:

```ts
    // Operational usage metric for the daily digest — never break the response.
    try {
      recordMatchUsage(deps.db, {
        date: warsawDateAndHour(new Date()).date,
        authed: telegramId !== null,
        beers: beers.length,
      });
    } catch (e) {
      deps.log.warn({ err: e }, 'api_usage record failed');
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/api/index.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/match.ts src/api/index.test.ts
git commit -m "feat(status): count /match usage best-effort (anon vs authed + beers)"
```

---

## Task 4: Surface the previous Warsaw day in the digest

**Files:**
- Modify: `src/storage/stats.ts` (StatusMetrics + collectStatus)
- Modify: `src/jobs/daily-status.ts` (buildStatusMessage line)
- Test: `src/storage/stats.test.ts`, `src/jobs/daily-status.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/storage/stats.test.ts`, add imports if not already present:

```ts
import { recordMatchUsage } from './api_usage';
import { previousDate, warsawDateAndHour } from '../domain/warsaw-time';
```

Add this test (it uses `openDb`/`migrate`/`collectStatus`, already imported in that file):

```ts
test('collectStatus: extension /match metrics come from the previous Warsaw day', () => {
  const db = openDb(':memory:');
  migrate(db);
  const now = new Date('2026-06-05T09:30:00Z');
  const yesterday = previousDate(warsawDateAndHour(now).date);
  recordMatchUsage(db, { date: yesterday, authed: false, beers: 3 });
  recordMatchUsage(db, { date: yesterday, authed: true, beers: 2 });
  // Same-day (today) row must NOT be counted.
  recordMatchUsage(db, { date: warsawDateAndHour(now).date, authed: false, beers: 99 });
  const m = collectStatus(db, now);
  expect(m.extMatchRequests).toBe(2);
  expect(m.extMatchAnon).toBe(1);
  expect(m.extMatchBeers).toBe(5);
});
```

In `src/jobs/daily-status.test.ts`, extend the `base` metrics object (currently ends with `enrichMatched24h: 5, enrichFailures24h: 3, untappdSearchHealthy: true,`) by adding three fields:

```ts
  extMatchRequests: 1234, extMatchAnon: 312, extMatchBeers: 47210,
```

And in the `buildStatusMessage: full message exact string` test, insert the new expected line immediately after the `"• Користувачі: 31 профіль (24 прив'язано)",` line:

```ts
      '• Розширення /match (вчора): 1 234 запитів · 312 анонім. · 47 210 пив',
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/storage/stats.test.ts src/jobs/daily-status.test.ts`
Expected: FAIL — `extMatch*` missing on `StatusMetrics` (type error / undefined) and the exact-string test lacks the new line.

- [ ] **Step 3: Extend StatusMetrics + collectStatus**

In `src/storage/stats.ts`, add these imports with the existing ones:

```ts
import { getUsageForDate } from './api_usage';
import { warsawDateAndHour, previousDate } from '../domain/warsaw-time';
```

Add three fields to the `StatusMetrics` interface (after `untappdSearchHealthy: boolean;`):

```ts
  extMatchRequests: number;   // total /match requests, previous Warsaw day
  extMatchAnon: number;       // anonymous subset
  extMatchBeers: number;      // sum of beers, previous Warsaw day
```

In `collectStatus`, before the `return {` statement, add:

```ts
  const usage = getUsageForDate(db, previousDate(warsawDateAndHour(now).date));
```

And add three properties to the returned object (after `untappdSearchHealthy: ...,`):

```ts
    extMatchRequests: usage.anonRequests + usage.authedRequests,
    extMatchAnon: usage.anonRequests,
    extMatchBeers: usage.beers,
```

- [ ] **Step 4: Add the digest line**

In `src/jobs/daily-status.ts`, in `buildStatusMessage`, insert one line into the returned array immediately after the `• Користувачі:` line:

```ts
    `• Розширення /match (вчора): ${group(m.extMatchRequests)} запитів · ${group(m.extMatchAnon)} анонім. · ${group(m.extMatchBeers)} пив`,
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/storage/stats.test.ts src/jobs/daily-status.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/storage/stats.ts src/jobs/daily-status.ts src/storage/stats.test.ts src/jobs/daily-status.test.ts
git commit -m "feat(status): daily digest line for extension /match usage (previous Warsaw day)"
```

---

## Task 5: Spec docs + full verification

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Document the table in spec.md**

Find the §3 schema section. Add a short subsection for the new table near the other table definitions (mirroring the style of the existing `job_state`/`enrich_failures` entries), e.g.:

```markdown
### 3.x `api_usage` — денний облік запитів розширення (v17)

| колонка | тип | нотатки |
|---|---|---|
| `date` | TEXT PK | варшавська дата `YYYY-MM-DD` |
| `anon_requests` | INTEGER | `/match` без токена (анонім) за добу |
| `authed_requests` | INTEGER | `/match` з валідним токеном за добу |
| `beers` | INTEGER | сума `beers[]` у запитах за добу |

Інкрементується best-effort у `POST /match` (помилка запису не валить відповідь).
Один рядок на добу (обмежене зростання, без cleanup).
```

Then find the schema-version list (the table that ends with `| 16 | ... |`) and append a row:

```markdown
| 17 | `api_usage` (денний облік запитів розширення) |
```

- [ ] **Step 2: Document the digest line**

Find the daily-status / digest description section and add a bullet noting the new line:

```markdown
- Рядок «Розширення /match (вчора)»: усього запитів, з них анонімних, і сума пив
  за **останню повну варшавську добу** (з таблиці `api_usage`, §3). Нулі показуються,
  якщо трафіку не було.
```

(If the exact wording of a nearby section differs, match its style; the requirement is that both the table and the digest line are documented.)

- [ ] **Step 3: Full verification**

Run: `npm test`
Expected: PASS (whole suite).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(status): spec for api_usage table + extension /match digest line"
```

---

## Post-implementation (outside this plan)

- `extension/**` is untouched ⇒ `docs/extension-install-uk.md` is NOT updated (server-side metric only).
- Open a PR; wait for the AI review; read + critically assess before merge.
- Deploy via `deploy.sh`. The migration is additive (new table). The first meaningful
  digest line appears the morning after the first full counted day (before that,
  "yesterday" has no row → zeros).
