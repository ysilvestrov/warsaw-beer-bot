# Snapshot Data Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a background job that deletes `tap_snapshots` older than a configurable window (default 14 days) while always preserving each pub's latest snapshot, bounding DB growth.

**Architecture:** A pure storage function runs one `DELETE` (with a "keep MAX(id) per pub" guard); `taps` clean via the existing `ON DELETE CASCADE`. A thin job wraps it with a cutoff computed from `SNAPSHOT_RETENTION_DAYS`. Wired into `src/index.ts` as a startup job + a daily `0 5 * * *` cron. No `VACUUM` — file plateaus, doesn't shrink.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, node-cron, zod (env), pino (logging), Jest.

**Spec:** `docs/superpowers/specs/2026-06-04-snapshot-data-retention-design.md`

---

### Task 1: Storage — `deleteOldSnapshots`

**Files:**
- Modify: `src/storage/snapshots.ts`
- Test: `src/storage/snapshots.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Append to (or create) `src/storage/snapshots.test.ts`:

```ts
import { openDb } from './db';
import { migrate } from '../storage/schema';
import { upsertPub } from './pubs';
import {
  createSnapshot, insertTaps, tapsForSnapshot, deleteOldSnapshots,
} from './snapshots';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function pub(db: ReturnType<typeof fresh>, slug: string): number {
  return upsertPub(db, { slug, name: slug, address: null, lat: null, lon: null });
}

function snap(db: ReturnType<typeof fresh>, pubId: number, at: string): number {
  const id = createSnapshot(db, pubId, at);
  insertTaps(db, id, [{
    tap_number: 1, beer_ref: `ref-${id}`, brewery_ref: null,
    abv: null, ibu: null, style: null, u_rating: null,
  }]);
  return id;
}

describe('deleteOldSnapshots', () => {
  const CUTOFF = '2026-06-01T00:00:00.000Z';

  test('deletes old non-latest snapshots and cascades their taps', () => {
    const db = fresh();
    const p = pub(db, 'a');
    const old = snap(db, p, '2026-05-20T12:00:00Z');   // old, not latest
    const recent = snap(db, p, '2026-06-03T12:00:00Z'); // latest, recent

    const deleted = deleteOldSnapshots(db, CUTOFF);

    expect(deleted).toBe(1);
    expect(tapsForSnapshot(db, old)).toHaveLength(0);
    expect(tapsForSnapshot(db, recent)).toHaveLength(1);
  });

  test('preserves a pub latest snapshot even when older than cutoff', () => {
    const db = fresh();
    const p = pub(db, 'stale');
    const onlyOld = snap(db, p, '2026-05-01T12:00:00Z'); // old AND latest-for-pub

    const deleted = deleteOldSnapshots(db, CUTOFF);

    expect(deleted).toBe(0);
    expect(tapsForSnapshot(db, onlyOld)).toHaveLength(1);
  });

  test('keeps the latest per pub independently across pubs', () => {
    const db = fresh();
    const a = pub(db, 'a');
    const b = pub(db, 'b');
    const aOld = snap(db, a, '2026-05-10T12:00:00Z');
    const aNew = snap(db, a, '2026-06-03T12:00:00Z');
    const bOld1 = snap(db, b, '2026-05-11T12:00:00Z');
    const bOld2 = snap(db, b, '2026-05-12T12:00:00Z'); // latest for b, still old

    const deleted = deleteOldSnapshots(db, CUTOFF);

    expect(deleted).toBe(2); // aOld + bOld1
    expect(tapsForSnapshot(db, aOld)).toHaveLength(0);
    expect(tapsForSnapshot(db, aNew)).toHaveLength(1);
    expect(tapsForSnapshot(db, bOld1)).toHaveLength(0);
    expect(tapsForSnapshot(db, bOld2)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/snapshots.test.ts`
Expected: FAIL — `deleteOldSnapshots is not a function` / TS2305 (not exported).

- [ ] **Step 3: Write minimal implementation**

Append to `src/storage/snapshots.ts`:

```ts
// Deletes snapshots older than cutoffIso, EXCEPT each pub's most recent
// (MAX(id) per pub — id and snapshot_at are co-monotonic, set at insert).
// taps are removed by the taps.snapshot_id ON DELETE CASCADE (foreign_keys=ON).
// Returns the number of snapshot rows deleted.
export function deleteOldSnapshots(db: DB, cutoffIso: string): number {
  const res = db.prepare(
    `DELETE FROM tap_snapshots
     WHERE snapshot_at < ?
       AND id NOT IN (SELECT MAX(id) FROM tap_snapshots GROUP BY pub_id)`,
  ).run(cutoffIso);
  return res.changes;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/storage/snapshots.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/snapshots.ts src/storage/snapshots.test.ts
git commit -m "feat(storage): deleteOldSnapshots (keep latest per pub)"
```

---

### Task 2: Job — `cleanupOldSnapshots`

**Files:**
- Create: `src/jobs/cleanup-old-snapshots.ts`
- Test: `src/jobs/cleanup-old-snapshots.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/jobs/cleanup-old-snapshots.test.ts`:

```ts
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertPub } from '../storage/pubs';
import { createSnapshot, insertTaps, tapsForSnapshot } from '../storage/snapshots';
import { cleanupOldSnapshots } from './cleanup-old-snapshots';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function snap(db: ReturnType<typeof fresh>, pubId: number, at: string): number {
  const id = createSnapshot(db, pubId, at);
  insertTaps(db, id, [{
    tap_number: 1, beer_ref: `ref-${id}`, brewery_ref: null,
    abv: null, ibu: null, style: null, u_rating: null,
  }]);
  return id;
}

describe('cleanupOldSnapshots', () => {
  test('deletes snapshots older than retentionDays, keeps recent + latest', () => {
    const db = fresh();
    const p = upsertPub(db, { slug: 'a', name: 'a', address: null, lat: null, lon: null });
    const old = snap(db, p, '2026-05-01T12:00:00Z');   // 34 days before now
    const recent = snap(db, p, '2026-06-03T12:00:00Z'); // 1 day before now, latest
    const now = () => new Date('2026-06-04T00:00:00Z');

    const deleted = cleanupOldSnapshots(db, silentLog, 14, now);

    expect(deleted).toBe(1);
    expect(tapsForSnapshot(db, old)).toHaveLength(0);
    expect(tapsForSnapshot(db, recent)).toHaveLength(1);
  });

  test('returns 0 on an already-clean DB', () => {
    const db = fresh();
    const p = upsertPub(db, { slug: 'a', name: 'a', address: null, lat: null, lon: null });
    snap(db, p, '2026-06-03T12:00:00Z');
    const deleted = cleanupOldSnapshots(db, silentLog, 14, () => new Date('2026-06-04T00:00:00Z'));
    expect(deleted).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/jobs/cleanup-old-snapshots.test.ts`
Expected: FAIL — cannot find module `./cleanup-old-snapshots`.

- [ ] **Step 3: Write minimal implementation**

Create `src/jobs/cleanup-old-snapshots.ts`:

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import { deleteOldSnapshots } from '../storage/snapshots';

// Deletes tap_snapshots (and cascaded taps) older than retentionDays, while
// always keeping each pub's latest snapshot. `now` is injectable for tests.
// Synchronous: the caller's cron wrapper guards it with try/catch.
export function cleanupOldSnapshots(
  db: DB,
  log: pino.Logger,
  retentionDays: number,
  now: () => Date = () => new Date(),
): number {
  const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  const deleted = deleteOldSnapshots(db, cutoffIso);
  log.info({ deleted, retentionDays, cutoff: cutoffIso }, 'cleanup-old-snapshots');
  return deleted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/jobs/cleanup-old-snapshots.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/cleanup-old-snapshots.ts src/jobs/cleanup-old-snapshots.test.ts
git commit -m "feat(jobs): cleanupOldSnapshots job"
```

---

### Task 3: Config — `SNAPSHOT_RETENTION_DAYS`

**Files:**
- Modify: `src/config/env.ts:9` (add field in the zod schema)
- Modify: `.env.example`

- [ ] **Step 1: Add the env field**

In `src/config/env.ts`, inside the `Schema` object, add after the
`DEFAULT_ROUTE_N` line (line 9):

```ts
  SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
```

- [ ] **Step 2: Verify it type-checks and parses**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Document in `.env.example`**

Add a line to `.env.example`:

```
# Days of tap-snapshot history to retain (older snapshots are pruned daily;
# each pub always keeps its latest snapshot regardless). Default 14.
SNAPSHOT_RETENTION_DAYS=14
```

- [ ] **Step 4: Commit**

```bash
git add src/config/env.ts .env.example
git commit -m "feat(config): SNAPSHOT_RETENTION_DAYS env (default 14)"
```

---

### Task 4: Wiring — startup + daily cron in `src/index.ts`

**Files:**
- Modify: `src/index.ts` (import; startup call after line 37; cron in the `cronJobs` array ~line 88-116)

- [ ] **Step 1: Add the import**

After `src/index.ts:28` (`import { refreshTapRatings } ...`), add:

```ts
import { cleanupOldSnapshots } from './jobs/cleanup-old-snapshots';
```

- [ ] **Step 2: Add the startup call**

In `src/index.ts`, immediately after line 37 (`cleanupPollutedOntap(db, log);`), add:

```ts
  cleanupOldSnapshots(db, log, env.SNAPSHOT_RETENTION_DAYS);
```

- [ ] **Step 3: Add the daily cron**

In `src/index.ts`, inside the `const cronJobs = [ ... ]` array (after the
`refreshTapRatings` schedule block that ends ~line 115), add a new element:

```ts
    // cleanup-old-snapshots: daily at 05:00 Warsaw, a quiet slot away from the
    // on-the-hour scraper runs (00:00/12:00 ontap, 03:00 untappd). Bounds DB
    // growth; each pub always keeps its latest snapshot. Synchronous → try/catch.
    cron.schedule('0 5 * * *', () => {
      try {
        cleanupOldSnapshots(db, log, env.SNAPSHOT_RETENTION_DAYS);
      } catch (e) {
        log.error({ err: e }, 'cleanup-old-snapshots cron');
      }
    }),
```

- [ ] **Step 4: Verify it type-checks and the build succeeds**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire cleanupOldSnapshots (startup + daily 05:00 cron)"
```

---

### Task 5: Spec update — `spec.md`

**Files:**
- Modify: `spec.md` — §3.3/§3.4 (retention note), §4 "Фонові джоби" table + startup-jobs list

- [ ] **Step 1: Add the background-job row**

In `spec.md`, in the "Фонові джоби (node-cron, у процесі)" table (the row
block around line 428-431), add a row after the `refreshTapRatings` row:

```
| `cleanupOldSnapshots` | `0 5 * * *` | видалення `tap_snapshots` старших за `SNAPSHOT_RETENTION_DAYS` (default 14); latest-per-pub завжди зберігається |
```

- [ ] **Step 2: Add to the startup-jobs list**

In `spec.md`, in the "**Startup-джоби**" paragraph (around line 433-435),
extend the list to mention the cleanup job. Replace:

```
**Startup-джоби** (`src/index.ts`, до launch): `dedupeBreweryAliases`
(злиття дублів каталогу) і `cleanupPollutedOntap` (чистка «брудних» назв) —
обидві ідемпотентні (no-op на чистій БД).
```

with:

```
**Startup-джоби** (`src/index.ts`, до launch): `dedupeBreweryAliases`
(злиття дублів каталогу), `cleanupPollutedOntap` (чистка «брудних» назв) і
`cleanupOldSnapshots` (прунінг старих snapshot'ів — той самий код, що й
щоденний крон) — усі ідемпотентні (no-op на чистій БД).
```

- [ ] **Step 3: Add a retention note under §3.3 `tap_snapshots`**

In `spec.md`, after the line `«Поточні крани» = крани з останнього snapshot
кожного паба.` (line 209), add:

```

**Retention:** `cleanupOldSnapshots` (startup + щодня 05:00) видаляє snapshot'и
старші за `SNAPSHOT_RETENTION_DAYS` (default 14), **окрім** останнього snapshot
кожного паба (`MAX(id)` по `pub_id`). `taps` чистяться каскадом
(§3.4 `ON DELETE CASCADE`). Лише `DELETE`, без `VACUUM` — файл БД виходить на
плато, а не зростає нескінченно (Litestream-friendly).
```

- [ ] **Step 4: Verify the doc reads consistently**

Run: `grep -n "cleanupOldSnapshots\|SNAPSHOT_RETENTION_DAYS\|Retention" spec.md`
Expected: matches in the §3.3 note, the §4 jobs table, and the startup list.

- [ ] **Step 5: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document snapshot retention job + policy"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npx jest`
Expected: all tests pass (including the new snapshots + job tests).

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Finish the branch**

Use the superpowers:finishing-a-development-branch skill to merge / open a PR.

---

## Notes for the implementer

- `DB` is the better-sqlite3 handle type from `src/storage/db.ts`; `.run()` returns
  `{ changes, lastInsertRowid }` — `changes` is the deleted-row count.
- `foreign_keys = ON` is set in `src/storage/db.ts:8`, so the `taps` CASCADE is
  active in both prod and `:memory:` test DBs (`migrate` applies the same schema).
- `upsertPub` signature: `{ slug, name, address, lat, lon }` (see
  `src/storage/pubs.ts`); `insertTaps` takes the `TapInput[]` shape used in the tests.
- Do not add `VACUUM` anywhere — plateau-not-shrink is an intentional decision
  (see spec "Decisions"). Reclaiming disk is explicitly out of scope.
