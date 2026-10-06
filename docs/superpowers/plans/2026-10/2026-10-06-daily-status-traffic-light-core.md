# Daily Status Traffic Light — Core (stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat morning digest with a traffic light (overall + per-subsystem colour, reasons only under 🟡/🔴), backed by a daily `status_snapshots` history, using only the data the bot already has.

**Architecture:** A jobs-layer collector (`collectStatusInputs`) reads every source into one `StatusInputs` value, where a source that could not be read is an explicit `{ ok: false, reason }`. Pure domain functions (`src/domain/status/`) evaluate colours, compute trends and render text. `dailyStatus` writes the day's snapshot before sending, and sends a once-a-day minimal 🔴 message if assembling the report throws.

**Tech Stack:** Node.js, TypeScript (nodenext), better-sqlite3 via `openDb`, Vitest (globals), pino.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-06-daily-status-traffic-light-design.md` — read it before Task 1. This plan is **stage 1 (core)** only; `ops_events`, `/match`/MCP error counters, the bot command counter, closed issues and the deploy journal are stage 2 and get their own plan after the core review.

## Global Constraints

- Colours: exactly three — 🟢 `green`, 🟡 `yellow`, 🔴 `red`. "No data" is 🟡 with a reason starting `нема даних: `. There is no fourth colour.
- **Сироти is capped at 🟡** — no input may make it 🔴.
- Overall colour = the worst subsystem colour.
- Fest subsystem appears only when `currentOrNextFests(db, now)` is non-empty.
- History-based rules are **inactive** (no reason, no colour change) when their snapshots are missing; the report then carries the footer `історія: N/7 днів — порівняльні правила ще не діють`.
- Stage 1 always carries the footer `події: ще не підключені — нічні інциденти, що вже минули, звіт поки не бачить`.
- Thresholds live only in `src/domain/status/rules.ts` (`STATUS_RULES`), never as literals in evaluators.
- Snapshot retention 90 days; snapshot written **before** the Telegram send.
- Report text is plain text (`notifyAdmin` sends without `parse_mode`), cut to 4096 characters with `\n… (обрізано)`.
- Test rules from `CLAUDE.md`: exact `toBe`/`toEqual`, no conditionals in tests, boundary cases for every threshold, no expected values computed by re-implementing production logic. The schema head is asserted in **exactly one** test (`src/storage/schema.test.ts`, "records every migration 1..N").
- Gate for every task: `npm test && npm run typecheck` — the **full** suite, never a scoped run.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The code beats this plan: if a file differs from what a task quotes, follow the file and report the difference.

**Known interaction:** #785 (monitor race: the 09:00 read sees a negative snapshot age and reports "unavailable") will make Інфраструктура 🟡 `нема даних: дані монітора недоступні` every morning until it is fixed. It is a separate light-path fix; it should land before or together with this core deploy. This plan does not fix it.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/status/types.ts` (new) | `Colour`, `SubsystemId`, `Evaluation`, `Avail<T>`, `SnapshotMetrics`, `SnapshotRecord`, `FestInputs`, `StatusInputs` |
| `src/storage/schema.ts` (modify) | migration v45: `status_snapshots` |
| `src/storage/status_snapshots.ts` (new) | save / list / prune snapshots |
| `src/jobs/test-diagnostics.ts` (modify) | structured `readTestDiagnostics` beside the existing line reader |
| `src/domain/status/helpers.ts` (new) | date shift, snapshot lookup, median, Warsaw clock, number formatting |
| `src/domain/status/rules.ts` (new) | `STATUS_RULES` thresholds |
| `src/domain/status/evaluate.ts` (new) | six evaluators + `evaluateAll` |
| `src/domain/status/test-inputs.ts` (new) | shared all-green fixture for evaluator/trend tests |
| `src/domain/status/trends.ts` (new) | stock and flow trend lines |
| `src/domain/status/render.ts` (new) | `renderStatusReport` |
| `src/jobs/status-inputs.ts` (new) | `collectStatusInputs` — the only place that reads DB/job_state/files for the report |
| `src/jobs/daily-status.ts` (modify) | wire collector → evaluate → snapshot → render → send; fallback |
| `spec.md` (modify) | the report contract, migration row, `Тести` paragraph |

---

### Task 1: Types, migration v45 and snapshot storage

**Files:**
- Create: `src/domain/status/types.ts`
- Modify: `src/storage/schema.ts` (append to `MIGRATIONS`, after `{ version: 44, sql: V44_FEST_MCP_EYE_SQL }`)
- Modify: `src/storage/schema.test.ts` (the single head test: `1..44` → `1..45`, `length: 44` → `length: 45`)
- Create: `src/storage/status_snapshots.ts`
- Test: `src/storage/status_snapshots.test.ts`

**Interfaces:**
- Consumes: `StatusMetrics` from `src/storage/stats.ts`; `BugReportSummary` from `src/domain/bug-report-types.ts`.
- Produces (used by every later task):

```ts
export type Colour = 'green' | 'yellow' | 'red';
export type SubsystemId = 'taps' | 'untappd' | 'orphans' | 'channels' | 'fest' | 'infra';
export interface Evaluation { subsystem: SubsystemId; colour: Colour; reasons: string[] }
export type Avail<T> = { ok: true; value: T } | { ok: false; reason: string };
export interface SnapshotMetrics extends StatusMetrics { diskBytesAvailable: number | null; inodesFree: number | null }
export interface SnapshotRecord { date: string; metrics: SnapshotMetrics }
export interface FestInputs { menuLastAt: string | null; menuCycleMs: number; keepaliveLastAt: string | null; keepaliveCycleMs: number }
export interface StatusInputs { /* see Step 1 */ }

export const STATUS_SNAPSHOT_VERSION = 1;
export function saveStatusSnapshot(db: DB, s: { date: string; metrics: SnapshotMetrics; colours: Evaluation[]; createdAt: string }): void;
export function listStatusSnapshots(db: DB, fromDate: string, beforeDate: string): SnapshotRecord[];
export function pruneStatusSnapshots(db: DB, keepFromDate: string): number;
```

- [ ] **Step 1: Create the types module**

`src/domain/status/types.ts`:

```ts
import type { StatusMetrics } from '../../storage/stats';
import type { BugReportSummary } from '../bug-report-types';

// Daily status traffic light (spec 2026-10-06-daily-status-traffic-light-design.md).
export type Colour = 'green' | 'yellow' | 'red';
export type SubsystemId = 'taps' | 'untappd' | 'orphans' | 'channels' | 'fest' | 'infra';

export interface Evaluation {
  subsystem: SubsystemId;
  colour: Colour;
  reasons: string[]; // empty exactly when colour is green
}

// A source the report could not read is a value, not an exception: the evaluator turns it into
// 🟡 "нема даних: <reason>", so a 🟢 can only be produced from inputs that were actually read.
export type Avail<T> = { ok: true; value: T } | { ok: false; reason: string };

// What one day's snapshot stores. Disk fields are null when the monitor could not be read.
export interface SnapshotMetrics extends StatusMetrics {
  diskBytesAvailable: number | null;
  inodesFree: number | null;
}

export interface SnapshotRecord {
  date: string; // Warsaw YYYY-MM-DD
  metrics: SnapshotMetrics;
}

// Cycle lengths come from the fest jobs' own constants (filled in by the collector), so the
// evaluator never duplicates a schedule.
export interface FestInputs {
  menuLastAt: string | null;
  menuCycleMs: number;
  keepaliveLastAt: string | null;
  keepaliveCycleMs: number;
}

export interface StatusInputs {
  now: Date;
  dateKey: string;                 // Warsaw date of this report
  metrics: SnapshotMetrics;        // today
  history: SnapshotRecord[];       // earlier dates only (dateKey-13 .. dateKey-1), any subset
  canary: Avail<{ ok: boolean; at: string } | null>; // value null = the canary never ran
  algoliaOpenUntil: string | null;
  profileOpenUntil: string | null;
  triage: { ranToday: boolean; line: string | null; saturated: string | null };
  unlock: { ranToday: boolean; withheld: { beerId: number; issueNumber: number }[] };
  bugReports: { summary: BugReportSummary; paused: { since: string; status: number } | null } | null; // null = no repo configured
  disk: Avail<{ bytesAvailable: number; inodesFree: number; pendingRuns: number | null }>;
  fest: FestInputs | null;         // null = no current or upcoming fest
}
```

- [ ] **Step 2: Write the failing storage tests**

`src/storage/status_snapshots.test.ts`:

```ts
import { openDb } from './db';
import { migrate } from './schema';
import { listStatusSnapshots, pruneStatusSnapshots, saveStatusSnapshot, STATUS_SNAPSHOT_VERSION } from './status_snapshots';
import type { Evaluation, SnapshotMetrics } from '../domain/status/types';

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// Only the fields the assertions read differ between days; the rest is a fixed valid shape.
const metrics = (orphansPending: number): SnapshotMetrics => ({
  lastScrapeHoursAgo: 6.9, pubsScraped24h: 115, beersTotal: 30_000, beersMatched: 25_000,
  orphansPending, orphansRelayQueue: 900, ratingsMissing: 100, ratingsChecked30d: 20_000,
  snapshots: 2_000, taps: 50_000, dbSizeMb: 300, usersTotal: 10, usersLinked: 6,
  onTapDistinct: 900, onTapPubs: 110, newOnTap24h: 30, enrichMatched24h: 10, enrichFailures24h: 20,
  untappdSearchHealthy: true, extMatchRequests: 3, extMatchAnon: 1, extMatchBeers: 200,
  mcpMatchRequests: 0, mcpMatchBeers: 0, sealUnidentifiable: 50, sealUnidentifiableReobserved: 10,
  sealNotABeer: 30, sealNotABeer7d: 1, sealRetiredFalsified: 2, lockedRows: 40, unlocked7d: 1,
  verdictsOutlived7d: 0, unrescuedRows: 3, unlockedUnadjudicated7d: 0,
  diskBytesAvailable: 34_750_201_856, inodesFree: 2_078_442,
});
const colours: Evaluation[] = [{ subsystem: 'taps', colour: 'yellow', reasons: ['останній скрейп 15 год тому'] }];

test('migration v45 records its version', () => {
  const db = emptyDb();
  expect(db.prepare('SELECT version FROM schema_version WHERE version = 45').get()).toEqual({ version: 45 });
});

test('a saved snapshot round-trips its metrics and stores colours and version', () => {
  const db = emptyDb();
  saveStatusSnapshot(db, { date: '2026-10-05', metrics: metrics(412), colours, createdAt: '2026-10-05T07:00:01.000Z' });
  expect(listStatusSnapshots(db, '2026-10-05', '2026-10-06')).toEqual([{ date: '2026-10-05', metrics: metrics(412) }]);
  expect(db.prepare('SELECT version, colours_json, created_at FROM status_snapshots').get()).toEqual({
    version: STATUS_SNAPSHOT_VERSION, colours_json: JSON.stringify(colours), created_at: '2026-10-05T07:00:01.000Z',
  });
});

test('saving the same date twice keeps one row with the later content', () => {
  const db = emptyDb();
  saveStatusSnapshot(db, { date: '2026-10-05', metrics: metrics(412), colours, createdAt: '2026-10-05T07:00:01.000Z' });
  saveStatusSnapshot(db, { date: '2026-10-05', metrics: metrics(431), colours: [], createdAt: '2026-10-05T07:15:01.000Z' });
  expect(listStatusSnapshots(db, '2026-10-01', '2026-10-09')).toEqual([{ date: '2026-10-05', metrics: metrics(431) }]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM status_snapshots').get()).toEqual({ n: 1 });
});

test('list is inclusive of fromDate, exclusive of beforeDate, oldest first', () => {
  const db = emptyDb();
  for (const [date, n] of [['2026-10-02', 2], ['2026-10-03', 3], ['2026-10-04', 4], ['2026-10-05', 5]] as const) {
    saveStatusSnapshot(db, { date, metrics: metrics(n), colours: [], createdAt: `${date}T07:00:00.000Z` });
  }
  expect(listStatusSnapshots(db, '2026-10-03', '2026-10-05').map((s) => s.date)).toEqual(['2026-10-03', '2026-10-04']);
});

test('list skips rows written by another snapshot version and rows with unreadable JSON', () => {
  const db = emptyDb();
  saveStatusSnapshot(db, { date: '2026-10-03', metrics: metrics(3), colours: [], createdAt: '2026-10-03T07:00:00.000Z' });
  db.prepare(`INSERT INTO status_snapshots VALUES ('2026-10-04', 99, '{}', '[]', '2026-10-04T07:00:00.000Z')`).run();
  db.prepare(`INSERT INTO status_snapshots VALUES ('2026-10-05', ?, '{', '[]', '2026-10-05T07:00:00.000Z')`).run(STATUS_SNAPSHOT_VERSION);
  expect(listStatusSnapshots(db, '2026-10-01', '2026-10-09').map((s) => s.date)).toEqual(['2026-10-03']);
});

test('prune deletes strictly older rows and reports how many', () => {
  const db = emptyDb();
  for (const date of ['2026-07-07', '2026-07-08', '2026-07-09']) {
    saveStatusSnapshot(db, { date, metrics: metrics(1), colours: [], createdAt: `${date}T07:00:00.000Z` });
  }
  expect(pruneStatusSnapshots(db, '2026-07-08')).toBe(1);
  expect(listStatusSnapshots(db, '2026-01-01', '2027-01-01').map((s) => s.date)).toEqual(['2026-07-08', '2026-07-09']);
});
```

- [ ] **Step 3: Run the tests — expect failure**

Run: `npx vitest run src/storage/status_snapshots.test.ts`
Expected: FAIL — `Cannot find module './status_snapshots'`.

- [ ] **Step 4: Add migration v45**

In `src/storage/schema.ts`, append after `{ version: 44, sql: V44_FEST_MCP_EYE_SQL },`:

```ts
  {
    version: 45,
    // Daily status traffic light (spec 2026-10-06): one row per Warsaw date — the metrics the
    // report was built from and the colours it said — so "worse than usual" and trends have a
    // past. Idempotent like v42.
    sql: `
      CREATE TABLE IF NOT EXISTS status_snapshots (
        date         TEXT PRIMARY KEY,
        version      INTEGER NOT NULL,
        metrics_json TEXT NOT NULL,
        colours_json TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
    `,
  },
```

In `src/storage/schema.test.ts`, the head test becomes:

```ts
  it('records every migration 1..45 on a fresh db, with no gaps', () => {
    const db = openDb(':memory:');
    migrate(db);
    const versions = (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[])
      .map((r) => r.version);
    expect(versions).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    db.close();
  });
```

- [ ] **Step 5: Implement the storage module**

`src/storage/status_snapshots.ts`:

```ts
import type { DB } from './db';
import type { Evaluation, SnapshotMetrics, SnapshotRecord } from '../domain/status/types';

// Bumped when SnapshotMetrics changes shape incompatibly; rows of another version are skipped on
// read rather than misread as today's shape.
export const STATUS_SNAPSHOT_VERSION = 1;

export function saveStatusSnapshot(
  db: DB,
  s: { date: string; metrics: SnapshotMetrics; colours: Evaluation[]; createdAt: string },
): void {
  db.prepare(
    `INSERT INTO status_snapshots (date, version, metrics_json, colours_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       version = excluded.version, metrics_json = excluded.metrics_json,
       colours_json = excluded.colours_json, created_at = excluded.created_at`,
  ).run(s.date, STATUS_SNAPSHOT_VERSION, JSON.stringify(s.metrics), JSON.stringify(s.colours), s.createdAt);
}

// Snapshots with fromDate <= date < beforeDate, oldest first. A row that cannot be parsed is
// skipped: one corrupt day must cost one day of history, not the whole report.
export function listStatusSnapshots(db: DB, fromDate: string, beforeDate: string): SnapshotRecord[] {
  const rows = db.prepare(
    `SELECT date, metrics_json FROM status_snapshots
      WHERE date >= ? AND date < ? AND version = ? ORDER BY date`,
  ).all(fromDate, beforeDate, STATUS_SNAPSHOT_VERSION) as { date: string; metrics_json: string }[];
  return rows.flatMap((r) => {
    try {
      return [{ date: r.date, metrics: JSON.parse(r.metrics_json) as SnapshotMetrics }];
    } catch {
      return [];
    }
  });
}

export function pruneStatusSnapshots(db: DB, keepFromDate: string): number {
  return db.prepare('DELETE FROM status_snapshots WHERE date < ?').run(keepFromDate).changes;
}
```

- [ ] **Step 6: Run the gate**

Run: `npm test && npm run typecheck`
Expected: PASS, including `records every migration 1..45`.

- [ ] **Step 7: Commit**

```bash
git add src/domain/status/types.ts src/storage/schema.ts src/storage/schema.test.ts src/storage/status_snapshots.ts src/storage/status_snapshots.test.ts
git commit -m "feat(status): status_snapshots table and the traffic-light input types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Structured test-monitor reader

**Files:**
- Modify: `src/jobs/test-diagnostics.ts`
- Test: `src/jobs/test-diagnostics.test.ts` (add tests; existing tests must stay green unchanged — they are the regression guard for the line format)

**Interfaces:**
- Produces:

```ts
export type TestDiagnostics =
  | { kind: 'ok'; bytesAvailable: number; inodesFree: number; pendingRuns: number | null }
  | { kind: 'stale' }
  | { kind: 'unavailable' };
export function readTestDiagnostics(now: Date, path?: string, trustedUid?: number): TestDiagnostics;
export function formatTestDiagnostics(d: TestDiagnostics): string;
// unchanged signature, now = formatTestDiagnostics(readTestDiagnostics(...)):
export function readTestDiagnosticsLine(now: Date, path?: string, trustedUid?: number): string;
```

- [ ] **Step 1: Write the failing tests**

Append to `src/jobs/test-diagnostics.test.ts` (it already has `directory`, `path`, `now`, `snapshot`, `write` and per-test temp dirs). Add the import `readTestDiagnostics as readStructuredWithOwner` to the existing import line from `./test-diagnostics`, then:

```ts
const readTestDiagnostics = (at: Date, file: string) => readStructuredWithOwner(at, file, process.getuid!());

test('structured read returns the measured counters', () => {
  write(snapshot);
  expect(readTestDiagnostics(now, path)).toEqual({
    kind: 'ok', bytesAvailable: 32_212_254_720, inodesFree: 2_000_000, pendingRuns: 1,
  });
});

test('structured read keeps an unavailable inventory as null, not zero', () => {
  write({ ...snapshot, runs_inventory_available: false, pending_runs: null });
  expect(readTestDiagnostics(now, path)).toEqual({
    kind: 'ok', bytesAvailable: 32_212_254_720, inodesFree: 2_000_000, pendingRuns: null,
  });
});

test('structured read marks a snapshot over fifteen minutes old as stale', () => {
  write({ ...snapshot, timestamp: 299 });
  expect(readTestDiagnostics(now, path)).toEqual({ kind: 'stale' });
});

test('structured read reports a missing snapshot as unavailable', () => {
  expect(readTestDiagnostics(now, join(directory, 'missing.json'))).toEqual({ kind: 'unavailable' });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/jobs/test-diagnostics.test.ts`
Expected: FAIL — `readStructuredWithOwner is not a function`.

- [ ] **Step 3: Implement**

In `src/jobs/test-diagnostics.ts`:

1. Add the type after `summarySchema`:

```ts
export type TestDiagnostics =
  | { kind: 'ok'; bytesAvailable: number; inodesFree: number; pendingRuns: number | null }
  | { kind: 'stale' }
  | { kind: 'unavailable' };
const UNAVAILABLE_D: TestDiagnostics = { kind: 'unavailable' };
```

2. Rename the existing function `readTestDiagnosticsLine` to `readTestDiagnostics` with return type `TestDiagnostics`, and inside it replace **every** `return UNAVAILABLE;` with `return UNAVAILABLE_D;` (including the one in `finally`), replace `if (age > 900) return 'Тести: дані монітора застарілі';` with `if (age > 900) return { kind: 'stale' };`, and replace the final three lines (`const inventory = …`, `const inodes = …`, `return \`Тести: …\``) with:

```ts
    return {
      kind: 'ok', bytesAvailable: summary.bytes_available,
      inodesFree: summary.inodes_free, pendingRuns: summary.pending_runs,
    };
```

3. Add below it:

```ts
export function formatTestDiagnostics(d: TestDiagnostics): string {
  if (d.kind === 'unavailable') return UNAVAILABLE;
  if (d.kind === 'stale') return 'Тести: дані монітора застарілі';
  const inventory = d.pendingRuns === null ? 'дані каталогів недоступні'
    : `${d.pendingRuns} ${pendingWords(d.pendingRuns)} перевірки`;
  const inodes = String(d.inodesFree).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `Тести: ${inventory} · диск: ${(d.bytesAvailable / 1024 ** 3).toFixed(2)} GiB вільно · inode: ${inodes} вільно`;
}

export function readTestDiagnosticsLine(now: Date, path = SUMMARY_PATH, trustedUid?: number): string {
  return formatTestDiagnostics(readTestDiagnostics(now, path, trustedUid));
}
```

Keep the comment that sat above the old function above `readTestDiagnostics`.

- [ ] **Step 4: Run the gate**

Run: `npm test && npm run typecheck`
Expected: PASS — the new tests and every pre-existing `readTestDiagnosticsLine` test.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/test-diagnostics.ts src/jobs/test-diagnostics.test.ts
git commit -m "refactor(status): structured test-monitor read beside the line formatter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Rules, helpers and the state-based evaluators (Крани, Untappd, Фест, Інфраструктура)

**Files:**
- Create: `src/domain/status/rules.ts`, `src/domain/status/helpers.ts`, `src/domain/status/evaluate.ts`, `src/domain/status/test-inputs.ts`
- Test: `src/domain/status/helpers.test.ts`, `src/domain/status/evaluate.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:

```ts
// rules.ts
export const GIB_BYTES: number;
export const STATUS_RULES: { historyDays: 7; scrapeYellowHours: 14; scrapeRedHours: 26; pubsYellowShare: 0.9;
  ratingsMissingRel: 0.1; ratingsMissingAbs: 20; festYellowCycles: 2; festRedCycles: 4;
  diskYellowBytes: number; diskRedBytes: number; inodesRedFree: 100000; diskFallYellowBytesPerDay: number;
  stockRel: 0.1; stockAbs: 20; diskTrendAbsBytes: number; flowRel: 0.5; flowAbs: 10; snapshotRetentionDays: 90 };
// helpers.ts
export function shiftDate(date: string, days: number): string;
export function snapshotOn(history: SnapshotRecord[], date: string): SnapshotRecord | null;
export function previousDays(history: SnapshotRecord[], date: string, n: number): SnapshotRecord[] | null;
export function median(values: number[]): number;
export function warsawClock(iso: string): string;
export function groupThousands(n: number): string;
export function gib(bytes: number): string;
// evaluate.ts
export function worst(colours: Colour[]): Colour;
export function evaluateTaps(i: StatusInputs): Evaluation;
export function evaluateUntappd(i: StatusInputs): Evaluation;
export function evaluateFest(fest: FestInputs, now: Date): Evaluation;
export function evaluateInfra(i: StatusInputs): Evaluation;
// test-inputs.ts (test fixture, imported only by tests)
export const NOW: Date; export const DATE: string; export const GREEN_METRICS: SnapshotMetrics;
export function greenInputs(overrides?: Partial<StatusInputs>): StatusInputs;
export function pastDays(n: number, patch?: Partial<SnapshotMetrics>): SnapshotRecord[];
```

- [ ] **Step 1: Create rules and the fixture (no logic to test)**

`src/domain/status/rules.ts`:

```ts
export const GIB_BYTES = 1024 ** 3;

// Every threshold of the traffic light. Initial values; the 14-day checkpoint in the spec
// re-measures them against what actually fired.
export const STATUS_RULES = {
  historyDays: 7,
  // Крани — ontap runs every 12 h.
  scrapeYellowHours: 14,          // the old digest's ⚠️ threshold, carried over
  scrapeRedHours: 26,             // two missed 12 h cycles plus slack
  pubsYellowShare: 0.9,           // pubs scraped in 24 h vs the 7-day median
  // Untappd
  ratingsMissingRel: 0.1,
  ratingsMissingAbs: 20,
  // Фест — multiples of the job's own cycle
  festYellowCycles: 2,
  festRedCycles: 4,
  // Інфраструктура — the resource monitor's own values (scripts/ops/resource_monitor.py)
  diskYellowBytes: 10 * GIB_BYTES,
  diskRedBytes: 5 * GIB_BYTES,
  inodesRedFree: 100_000,
  diskFallYellowBytesPerDay: GIB_BYTES,
  // Тренди — a line needs BOTH the relative and the absolute move (small bases are noise)
  stockRel: 0.1,
  stockAbs: 20,
  diskTrendAbsBytes: GIB_BYTES,
  flowRel: 0.5,
  flowAbs: 10,
  snapshotRetentionDays: 90,
} as const;
```

`src/domain/status/test-inputs.ts`:

```ts
import type { SnapshotMetrics, SnapshotRecord, StatusInputs } from './types';
import { GIB_BYTES } from './rules';
import { shiftDate } from './helpers';

// Shared fixture for the status tests: every value is inside every threshold, so a test that
// overrides one field sees exactly that field's rule fire.
export const NOW = new Date('2026-10-06T07:00:00.000Z');
export const DATE = '2026-10-06';

export const GREEN_METRICS: SnapshotMetrics = {
  lastScrapeHoursAgo: 6.9, pubsScraped24h: 115, beersTotal: 30_000, beersMatched: 25_000,
  orphansPending: 400, orphansRelayQueue: 900, ratingsMissing: 100, ratingsChecked30d: 20_000,
  snapshots: 2_000, taps: 50_000, dbSizeMb: 300, usersTotal: 10, usersLinked: 6,
  onTapDistinct: 900, onTapPubs: 110, newOnTap24h: 30, enrichMatched24h: 10, enrichFailures24h: 20,
  untappdSearchHealthy: true, extMatchRequests: 3, extMatchAnon: 1, extMatchBeers: 200,
  mcpMatchRequests: 0, mcpMatchBeers: 0, sealUnidentifiable: 50, sealUnidentifiableReobserved: 10,
  sealNotABeer: 30, sealNotABeer7d: 1, sealRetiredFalsified: 2, lockedRows: 40, unlocked7d: 1,
  verdictsOutlived7d: 0, unrescuedRows: 3, unlockedUnadjudicated7d: 0,
  diskBytesAvailable: 32 * GIB_BYTES, inodesFree: 2_000_000,
};

export function greenInputs(overrides: Partial<StatusInputs> = {}): StatusInputs {
  return {
    now: NOW,
    dateKey: DATE,
    metrics: GREEN_METRICS,
    history: [],
    canary: { ok: true, value: { ok: true, at: '2026-10-06T06:30:00.000Z' } },
    algoliaOpenUntil: null,
    profileOpenUntil: null,
    triage: { ranToday: true, line: 'Тріаж: 7 рядків', saturated: null },
    unlock: { ranToday: true, withheld: [] },
    bugReports: null,
    disk: { ok: true, value: { bytesAvailable: 32 * GIB_BYTES, inodesFree: 2_000_000, pendingRuns: 0 } },
    fest: null,
    ...overrides,
  };
}

// Snapshots for DATE-1 .. DATE-n, each GREEN_METRICS with `patch` applied.
export function pastDays(n: number, patch: Partial<SnapshotMetrics> = {}): SnapshotRecord[] {
  return Array.from({ length: n }, (_, k) => ({
    date: shiftDate(DATE, -(k + 1)),
    metrics: { ...GREEN_METRICS, ...patch },
  }));
}
```

- [ ] **Step 2: Write the failing helper tests**

`src/domain/status/helpers.test.ts`:

```ts
import { gib, groupThousands, median, previousDays, shiftDate, snapshotOn, warsawClock } from './helpers';
import { GREEN_METRICS } from './test-inputs';

const rec = (date: string) => ({ date, metrics: GREEN_METRICS });

test('shiftDate crosses month and year boundaries in both directions', () => {
  expect([shiftDate('2026-10-01', -1), shiftDate('2026-12-31', 1), shiftDate('2026-03-29', 1)])
    .toEqual(['2026-09-30', '2027-01-01', '2026-03-30']);
});

test('snapshotOn finds the exact date or returns null', () => {
  const history = [rec('2026-10-04'), rec('2026-10-05')];
  expect([snapshotOn(history, '2026-10-05')?.date, snapshotOn(history, '2026-10-03')]).toEqual(['2026-10-05', null]);
});

test('previousDays returns the n days before the date, newest first', () => {
  const history = [rec('2026-10-03'), rec('2026-10-05'), rec('2026-10-04')];
  expect(previousDays(history, '2026-10-06', 3)?.map((s) => s.date)).toEqual(['2026-10-05', '2026-10-04', '2026-10-03']);
});

test('previousDays is null when any day in the window is missing', () => {
  const history = [rec('2026-10-03'), rec('2026-10-05')];
  expect(previousDays(history, '2026-10-06', 3)).toBeNull();
});

test('median of odd and even counts', () => {
  expect([median([5, 1, 3]), median([4, 1, 3, 2])]).toEqual([3, 2.5]);
});

test('warsawClock renders Warsaw wall time across the DST change', () => {
  expect([warsawClock('2026-10-06T03:30:10.000Z'), warsawClock('2026-11-02T03:30:10.000Z')]).toEqual(['05:30', '04:30']);
});

test('groupThousands and gib format numbers for the report', () => {
  expect([groupThousands(2078442), groupThousands(999), gib(34_750_201_856)]).toEqual(['2 078 442', '999', '32.36']);
});
```

- [ ] **Step 3: Write the failing evaluator tests**

`src/domain/status/evaluate.test.ts`:

```ts
import { evaluateFest, evaluateInfra, evaluateTaps, evaluateUntappd, worst } from './evaluate';
import { GREEN_METRICS, greenInputs, NOW, pastDays } from './test-inputs';
import { GIB_BYTES } from './rules';
import type { FestInputs } from './types';

const withMetrics = (patch: Partial<typeof GREEN_METRICS>) => greenInputs({ metrics: { ...GREEN_METRICS, ...patch } });

test('worst picks the most severe colour; no colours is green', () => {
  expect([worst([]), worst(['green', 'yellow']), worst(['yellow', 'red', 'green'])]).toEqual(['green', 'yellow', 'red']);
});

describe('Крани', () => {
  test('green fixture is green with no reasons', () => {
    expect(evaluateTaps(greenInputs())).toEqual({ subsystem: 'taps', colour: 'green', reasons: [] });
  });
  test.each([
    [14, 'green', []],
    [14.6, 'yellow', ['останній скрейп 15 год тому']],
    [26, 'yellow', ['останній скрейп 26 год тому']],
    [26.4, 'red', ['останній скрейп 26 год тому']],
  ] as const)('scrape %f h ago → %s', (hours, colour, reasons) => {
    expect(evaluateTaps(withMetrics({ lastScrapeHoursAgo: hours }))).toEqual({ subsystem: 'taps', colour, reasons });
  });
  test('no scrape at all is red', () => {
    expect(evaluateTaps(withMetrics({ lastScrapeHoursAgo: null }))).toEqual({
      subsystem: 'taps', colour: 'red', reasons: ['скрейпів кранів немає взагалі'],
    });
  });
  test('zero pubs in fresh snapshots is red', () => {
    expect(evaluateTaps(withMetrics({ onTapPubs: 0 }))).toEqual({
      subsystem: 'taps', colour: 'red', reasons: ['у свіжих знімках 0 пабів із кранами'],
    });
  });
  test('pubs below 90 % of the 7-day median is yellow; exactly 90 % is not', () => {
    const history = pastDays(7, { pubsScraped24h: 100 });
    expect([
      evaluateTaps(greenInputs({ history, metrics: { ...GREEN_METRICS, pubsScraped24h: 90 } })).colour,
      evaluateTaps(greenInputs({ history, metrics: { ...GREEN_METRICS, pubsScraped24h: 89 } })),
    ]).toEqual(['green', { subsystem: 'taps', colour: 'yellow', reasons: ['скрейп за 24 год охопив 89 пабів проти звичних 100'] }]);
  });
  test('the pubs rule is inactive with six days of history', () => {
    const inputs = greenInputs({ history: pastDays(6, { pubsScraped24h: 100 }), metrics: { ...GREEN_METRICS, pubsScraped24h: 10 } });
    expect(evaluateTaps(inputs).colour).toBe('green');
  });
});

describe('Untappd', () => {
  test('green fixture is green', () => {
    expect(evaluateUntappd(greenInputs())).toEqual({ subsystem: 'untappd', colour: 'green', reasons: [] });
  });
  test('canary empty on the latest run is red with its Warsaw time', () => {
    const inputs = greenInputs({ canary: { ok: true, value: { ok: false, at: '2026-10-06T03:30:10.000Z' } } });
    expect(evaluateUntappd(inputs)).toEqual({
      subsystem: 'untappd', colour: 'red', reasons: ['канарка пошуку порожня на останньому запуску (05:30)'],
    });
  });
  test('a canary that never ran is yellow, not green', () => {
    expect(evaluateUntappd(greenInputs({ canary: { ok: true, value: null } }))).toEqual({
      subsystem: 'untappd', colour: 'yellow', reasons: ['нема даних: канарка пошуку ще не запускалась'],
    });
  });
  test('unreadable canary state is yellow with the reason', () => {
    expect(evaluateUntappd(greenInputs({ canary: { ok: false, reason: 'стан канарки пошкоджено' } }))).toEqual({
      subsystem: 'untappd', colour: 'yellow', reasons: ['нема даних: стан канарки пошкоджено'],
    });
  });
  test('Algolia breaker open now is red; one that closed a second ago is not', () => {
    expect([
      evaluateUntappd(greenInputs({ algoliaOpenUntil: '2026-10-06T10:00:00.000Z' })),
      evaluateUntappd(greenInputs({ algoliaOpenUntil: '2026-10-06T06:59:59.000Z' })).colour,
    ]).toEqual([{ subsystem: 'untappd', colour: 'red', reasons: ['Algolia-breaker відкритий до 12:00'] }, 'green']);
  });
  test('profile breaker open now is yellow', () => {
    expect(evaluateUntappd(greenInputs({ profileOpenUntil: '2026-10-06T10:00:00.000Z' }))).toEqual({
      subsystem: 'untappd', colour: 'yellow', reasons: ['breaker профіль-скрейпу відкритий до 12:00'],
    });
  });
  test('ratings missing must beat the median by both 10 % and 20 rows', () => {
    const history = pastDays(7, { ratingsMissing: 100 });
    expect([
      evaluateUntappd(greenInputs({ history, metrics: { ...GREEN_METRICS, ratingsMissing: 120 } })).colour,
      evaluateUntappd(greenInputs({ history, metrics: { ...GREEN_METRICS, ratingsMissing: 121 } })),
    ]).toEqual(['green', { subsystem: 'untappd', colour: 'yellow', reasons: ['зматчених без рейтингу 121 проти звичних 100'] }]);
  });
});

describe('Фест', () => {
  const fest = (patch: Partial<FestInputs>): FestInputs => ({
    menuLastAt: '2026-10-06T06:00:00.000Z', menuCycleMs: 6 * 3_600_000,
    keepaliveLastAt: '2026-10-05T21:26:00.000Z', keepaliveCycleMs: 24 * 3_600_000, ...patch,
  });
  test('fresh menu and keep-alive are green', () => {
    expect(evaluateFest(fest({}), NOW)).toEqual({ subsystem: 'fest', colour: 'green', reasons: [] });
  });
  test.each([
    ['2026-10-05T19:00:00.000Z', 'green', []],                                       // exactly 2 cycles
    ['2026-10-05T18:59:00.000Z', 'yellow', ['меню фесту не оновлювалось 12 год']],
    ['2026-10-05T07:00:00.000Z', 'yellow', ['меню фесту не оновлювалось 24 год']],   // exactly 4 cycles
    ['2026-10-05T06:59:00.000Z', 'red', ['меню фесту не оновлювалось 24 год']],
  ] as const)('menu last read %s → %s', (menuLastAt, colour, reasons) => {
    expect(evaluateFest(fest({ menuLastAt }), NOW)).toEqual({ subsystem: 'fest', colour, reasons });
  });
  test('never-read menu and never-passed keep-alive are yellow', () => {
    expect(evaluateFest(fest({ menuLastAt: null, keepaliveLastAt: null }), NOW)).toEqual({
      subsystem: 'fest', colour: 'yellow',
      reasons: ['меню фесту: ще жодного успішного оновлення', 'MCP keep-alive фесту: ще жодного успішного оновлення'],
    });
  });
});

describe('Інфраструктура', () => {
  const disk = (bytesAvailable: number, inodesFree = 2_000_000, pendingRuns: number | null = 0) =>
    greenInputs({ disk: { ok: true, value: { bytesAvailable, inodesFree, pendingRuns } } });
  test('green fixture is green', () => {
    expect(evaluateInfra(greenInputs())).toEqual({ subsystem: 'infra', colour: 'green', reasons: [] });
  });
  test.each([
    [10 * GIB_BYTES + 1, 'green', []],
    [10 * GIB_BYTES, 'yellow', ['диск: 10.00 GiB вільно']],
    [5 * GIB_BYTES + 1, 'yellow', ['диск: 5.00 GiB вільно']],
    [5 * GIB_BYTES, 'red', ['диск: 5.00 GiB вільно']],
  ] as const)('disk %i bytes → %s', (bytes, colour, reasons) => {
    expect(evaluateInfra(disk(bytes))).toEqual({ subsystem: 'infra', colour, reasons });
  });
  test('inodes below 100 000 are red; exactly 100 000 is not', () => {
    expect([evaluateInfra(disk(32 * GIB_BYTES, 100_000)).colour, evaluateInfra(disk(32 * GIB_BYTES, 99_999))])
      .toEqual(['green', { subsystem: 'infra', colour: 'red', reasons: ['inode: 99 999 вільно'] }]);
  });
  test('pending test directories and an unavailable inventory are yellow', () => {
    expect([evaluateInfra(disk(32 * GIB_BYTES, 2_000_000, 2)), evaluateInfra(disk(32 * GIB_BYTES, 2_000_000, null))]).toEqual([
      { subsystem: 'infra', colour: 'yellow', reasons: ['тестових каталогів на перевірку: 2'] },
      { subsystem: 'infra', colour: 'yellow', reasons: ['нема даних: інвентар тестових каталогів'] },
    ]);
  });
  test('an unreadable monitor is yellow with its reason', () => {
    expect(evaluateInfra(greenInputs({ disk: { ok: false, reason: 'дані монітора недоступні' } }))).toEqual({
      subsystem: 'infra', colour: 'yellow', reasons: ['нема даних: дані монітора недоступні'],
    });
  });
  test('disk falling more than 1 GiB/day over a week is yellow; exactly 1 GiB/day is not', () => {
    const weekAgo = (bytes: number) => [{ date: '2026-09-29', metrics: { ...GREEN_METRICS, diskBytesAvailable: bytes } }];
    const today = 20 * GIB_BYTES;
    expect([
      evaluateInfra(greenInputs({ history: weekAgo(today + 7 * GIB_BYTES), disk: { ok: true, value: { bytesAvailable: today, inodesFree: 2_000_000, pendingRuns: 0 } } })).colour,
      evaluateInfra(greenInputs({ history: weekAgo(today + 7 * GIB_BYTES + 7), disk: { ok: true, value: { bytesAvailable: today, inodesFree: 2_000_000, pendingRuns: 0 } } })),
    ]).toEqual(['green', { subsystem: 'infra', colour: 'yellow', reasons: ['диск тане ~1.00 GiB/добу'] }]);
  });
});
```

- [ ] **Step 4: Run — expect failure**

Run: `npx vitest run src/domain/status`
Expected: FAIL — `Cannot find module './helpers'` / `'./evaluate'`.

- [ ] **Step 5: Implement helpers**

`src/domain/status/helpers.ts`:

```ts
import type { SnapshotRecord } from './types';
import { GIB_BYTES } from './rules';

// 'YYYY-MM-DD' moved by `days` calendar days. UTC math on a date-only value: DST never applies.
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function snapshotOn(history: SnapshotRecord[], date: string): SnapshotRecord | null {
  return history.find((s) => s.date === date) ?? null;
}

// Snapshots of the n days before `date`, newest first — or null when any of them is missing, so a
// comparison rule never runs on a partial week.
export function previousDays(history: SnapshotRecord[], date: string, n: number): SnapshotRecord[] | null {
  const days = Array.from({ length: n }, (_, k) => snapshotOn(history, shiftDate(date, -(k + 1))));
  return days.every((s): s is SnapshotRecord => s !== null) ? days : null;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function warsawClock(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

export function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function gib(bytes: number): string {
  return (bytes / GIB_BYTES).toFixed(2);
}
```

- [ ] **Step 6: Implement the four evaluators**

`src/domain/status/evaluate.ts`:

```ts
import type { Colour, Evaluation, FestInputs, StatusInputs, SubsystemId } from './types';
import { STATUS_RULES as R } from './rules';
import { gib, groupThousands, median, previousDays, shiftDate, snapshotOn, warsawClock } from './helpers';

type Finding = { colour: 'yellow' | 'red'; reason: string };
const red = (reason: string): Finding => ({ colour: 'red', reason });
const yellow = (reason: string): Finding => ({ colour: 'yellow', reason });

const RANK: Record<Colour, number> = { green: 0, yellow: 1, red: 2 };

export function worst(colours: Colour[]): Colour {
  return colours.reduce<Colour>((acc, c) => (RANK[c] > RANK[acc] ? c : acc), 'green');
}

function evaluation(subsystem: SubsystemId, findings: Finding[]): Evaluation {
  return { subsystem, colour: worst(findings.map((f) => f.colour)), reasons: findings.map((f) => f.reason) };
}

const openUntil = (until: string | null, now: Date): string | null =>
  until !== null && Date.parse(until) > now.getTime() ? until : null;

export function evaluateTaps(i: StatusInputs): Evaluation {
  const m = i.metrics;
  const f: Finding[] = [];
  if (m.lastScrapeHoursAgo === null) {
    f.push(red('скрейпів кранів немає взагалі'));
  } else {
    const ago = `останній скрейп ${Math.round(m.lastScrapeHoursAgo)} год тому`;
    if (m.lastScrapeHoursAgo > R.scrapeRedHours) f.push(red(ago));
    else if (m.lastScrapeHoursAgo > R.scrapeYellowHours) f.push(yellow(ago));
    if (m.onTapPubs === 0) f.push(red('у свіжих знімках 0 пабів із кранами'));
  }
  const week = previousDays(i.history, i.dateKey, R.historyDays);
  if (week !== null) {
    const usual = median(week.map((s) => s.metrics.pubsScraped24h));
    if (m.pubsScraped24h < usual * R.pubsYellowShare) {
      f.push(yellow(`скрейп за 24 год охопив ${m.pubsScraped24h} пабів проти звичних ${usual}`));
    }
  }
  return evaluation('taps', f);
}

export function evaluateUntappd(i: StatusInputs): Evaluation {
  const f: Finding[] = [];
  if (!i.canary.ok) f.push(yellow(`нема даних: ${i.canary.reason}`));
  else if (i.canary.value === null) f.push(yellow('нема даних: канарка пошуку ще не запускалась'));
  else if (!i.canary.value.ok) {
    f.push(red(`канарка пошуку порожня на останньому запуску (${warsawClock(i.canary.value.at)})`));
  }
  const algolia = openUntil(i.algoliaOpenUntil, i.now);
  if (algolia !== null) f.push(red(`Algolia-breaker відкритий до ${warsawClock(algolia)}`));
  const profile = openUntil(i.profileOpenUntil, i.now);
  if (profile !== null) f.push(yellow(`breaker профіль-скрейпу відкритий до ${warsawClock(profile)}`));
  const week = previousDays(i.history, i.dateKey, R.historyDays);
  if (week !== null) {
    const usual = median(week.map((s) => s.metrics.ratingsMissing));
    const excess = i.metrics.ratingsMissing - usual;
    if (excess > R.ratingsMissingAbs && excess > usual * R.ratingsMissingRel) {
      f.push(yellow(`зматчених без рейтингу ${groupThousands(i.metrics.ratingsMissing)} проти звичних ${groupThousands(usual)}`));
    }
  }
  return evaluation('untappd', f);
}

function staleness(what: string, lastAt: string | null, cycleMs: number, now: Date): Finding[] {
  if (lastAt === null) return [yellow(`${what}: ще жодного успішного оновлення`)];
  const age = now.getTime() - Date.parse(lastAt);
  const text = `${what} не оновлювалось ${Math.round(age / 3_600_000)} год`;
  if (age > cycleMs * R.festRedCycles) return [red(text)];
  if (age > cycleMs * R.festYellowCycles) return [yellow(text)];
  return [];
}

export function evaluateFest(fest: FestInputs, now: Date): Evaluation {
  return evaluation('fest', [
    ...staleness('меню фесту', fest.menuLastAt, fest.menuCycleMs, now),
    ...staleness('MCP keep-alive фесту', fest.keepaliveLastAt, fest.keepaliveCycleMs, now),
  ]);
}

export function evaluateInfra(i: StatusInputs): Evaluation {
  if (!i.disk.ok) return evaluation('infra', [yellow(`нема даних: ${i.disk.reason}`)]);
  const d = i.disk.value;
  const f: Finding[] = [];
  if (d.bytesAvailable <= R.diskRedBytes) f.push(red(`диск: ${gib(d.bytesAvailable)} GiB вільно`));
  else if (d.bytesAvailable <= R.diskYellowBytes) f.push(yellow(`диск: ${gib(d.bytesAvailable)} GiB вільно`));
  if (d.inodesFree < R.inodesRedFree) f.push(red(`inode: ${groupThousands(d.inodesFree)} вільно`));
  if (d.pendingRuns === null) f.push(yellow('нема даних: інвентар тестових каталогів'));
  else if (d.pendingRuns > 0) f.push(yellow(`тестових каталогів на перевірку: ${d.pendingRuns}`));
  const weekAgo = snapshotOn(i.history, shiftDate(i.dateKey, -R.historyDays));
  if (weekAgo !== null && weekAgo.metrics.diskBytesAvailable !== null) {
    const perDay = (weekAgo.metrics.diskBytesAvailable - d.bytesAvailable) / R.historyDays;
    if (perDay > R.diskFallYellowBytesPerDay) f.push(yellow(`диск тане ~${gib(perDay)} GiB/добу`));
  }
  return evaluation('infra', f);
}
```

- [ ] **Step 7: Run the gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Mutation check (required — `CLAUDE.md` feedback "mutation-prove every test")**

Temporarily change `> R.scrapeRedHours` to `>= R.scrapeRedHours` and `<= R.diskRedBytes` to `< R.diskRedBytes`; run `npx vitest run src/domain/status/evaluate.test.ts`; expect the `26` and `5 * GIB_BYTES` cases to FAIL. Revert both; rerun; PASS.

- [ ] **Step 9: Commit**

```bash
git add src/domain/status
git commit -m "feat(status): rules and evaluators for taps, Untappd, fest and infrastructure

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Сироти, Канали and `evaluateAll`

**Files:**
- Modify: `src/domain/status/evaluate.ts`
- Test: `src/domain/status/evaluate-all.test.ts`

**Interfaces:**
- Consumes: Task 3 (`worst`, the four evaluators, helpers, fixture).
- Produces:

```ts
export function evaluateOrphans(i: StatusInputs): Evaluation;
export function evaluateChannels(i: StatusInputs): Evaluation;
export interface StatusEvaluation { overall: Colour; subsystems: Evaluation[]; footers: string[] }
export function evaluateAll(i: StatusInputs): StatusEvaluation;
```

- [ ] **Step 1: Write the failing tests**

`src/domain/status/evaluate-all.test.ts`:

```ts
import { evaluateAll, evaluateChannels, evaluateOrphans } from './evaluate';
import { GREEN_METRICS, greenInputs, pastDays } from './test-inputs';
import type { BugReportSummary } from '../bug-report-types';

const idleSummary: BugReportSummary = {
  processed: 0, byVerdict: { new: 0, duplicate_open: 0, duplicate_closed: 0, not_a_bug: 0 },
  queued: 0, needsReview: [], failed: [], closedLinks: [],
};

describe('Сироти', () => {
  test('green fixture is green', () => {
    expect(evaluateOrphans(greenInputs())).toEqual({ subsystem: 'orphans', colour: 'green', reasons: [] });
  });
  test('every orphan rule firing at once is still only yellow (capped)', () => {
    const inputs = greenInputs({
      triage: { ranToday: false, line: null, saturated: 'Насичені: #452 (14) — усього 1' },
      unlock: { ranToday: false, withheld: [{ beerId: 38770, issueNumber: 452 }] },
      metrics: { ...GREEN_METRICS, unlockedUnadjudicated7d: 2, sealRetiredFalsified: 5 },
      history: pastDays(1, { sealRetiredFalsified: 2 }),
    });
    expect(evaluateOrphans(inputs)).toEqual({
      subsystem: 'orphans', colour: 'yellow', reasons: [
        'тріаж сиріт сьогодні не відпрацював',
        'Насичені: #452 (14) — усього 1',
        'замок сьогодні не перевірявся (unlock-fixed-orphans)',
        'утримано після закриття: 1 (#452 / beer 38770)',
        'розімкнено без негативного маркера за 7 днів: 2',
        'спростованих retire: 2 → 5',
      ],
    });
  });
  test('withheld rows list at most five examples', () => {
    const withheld = [1, 2, 3, 4, 5, 6].map((n) => ({ beerId: n, issueNumber: 400 + n }));
    expect(evaluateOrphans(greenInputs({ unlock: { ranToday: true, withheld } })).reasons).toEqual([
      'утримано після закриття: 6 (#401 / beer 1, #402 / beer 2, #403 / beer 3, #404 / beer 4, #405 / beer 5, …)',
    ]);
  });
  test('retire count equal to yesterday does not fire; no yesterday snapshot means inactive', () => {
    expect([
      evaluateOrphans(greenInputs({ history: pastDays(1, { sealRetiredFalsified: 2 }) })).colour,
      evaluateOrphans(greenInputs({ metrics: { ...GREEN_METRICS, sealRetiredFalsified: 99 } })).colour,
    ]).toEqual(['green', 'green']);
  });
});

describe('Канали', () => {
  test('no repo configured means no bug-report channel and green', () => {
    expect(evaluateChannels(greenInputs({ bugReports: null }))).toEqual({ subsystem: 'channels', colour: 'green', reasons: [] });
  });
  test('paused bug reports are red', () => {
    const inputs = greenInputs({ bugReports: { summary: idleSummary, paused: { since: '2026-10-06T04:12:33.000Z', status: 401 } } });
    expect(evaluateChannels(inputs)).toEqual({
      subsystem: 'channels', colour: 'red', reasons: ['скарги на паузі з 2026-10-06 04:12 UTC: ключ відхилено (401)'],
    });
  });
  test('reports needing review or failed are yellow and named', () => {
    const inputs = greenInputs({ bugReports: { summary: { ...idleSummary, needsReview: [7], failed: [9] }, paused: null } });
    expect(evaluateChannels(inputs)).toEqual({
      subsystem: 'channels', colour: 'yellow', reasons: ['скарги потребують перевірки: R-7, R-9'],
    });
  });
});

describe('evaluateAll', () => {
  const fest = { menuLastAt: null, menuCycleMs: 6 * 3_600_000, keepaliveLastAt: '2026-10-05T21:26:00.000Z', keepaliveCycleMs: 24 * 3_600_000 };
  test('subsystem order, no fest without a fest, history footer counts the week', () => {
    const result = evaluateAll(greenInputs({ history: pastDays(3) }));
    expect(result).toEqual({
      overall: 'green',
      subsystems: ['taps', 'untappd', 'orphans', 'channels', 'infra'].map((subsystem) => ({ subsystem, colour: 'green', reasons: [] })),
      footers: ['історія: 3/7 днів — порівняльні правила ще не діють'],
    });
  });
  test('fest sits before infra when present, and the overall colour is the worst', () => {
    const result = evaluateAll(greenInputs({ history: pastDays(7), fest, algoliaOpenUntil: '2026-10-06T10:00:00.000Z' }));
    expect([result.overall, result.subsystems.map((s) => s.subsystem), result.footers]).toEqual([
      'red', ['taps', 'untappd', 'orphans', 'channels', 'fest', 'infra'], [],
    ]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/domain/status/evaluate-all.test.ts`
Expected: FAIL — `evaluateOrphans is not a function`.

- [ ] **Step 3: Implement**

Append to `src/domain/status/evaluate.ts`:

```ts
const WITHHELD_EXAMPLES = 5;

// Capped at yellow by construction: an orphan is "rating unknown", never a wrong answer. Every
// finding below is built with yellow(); there is deliberately no red() call in this function.
export function evaluateOrphans(i: StatusInputs): Evaluation {
  const m = i.metrics;
  const f: Finding[] = [];
  if (!i.triage.ranToday) f.push(yellow('тріаж сиріт сьогодні не відпрацював'));
  if (i.triage.saturated !== null) f.push(yellow(i.triage.saturated));
  if (!i.unlock.ranToday) f.push(yellow('замок сьогодні не перевірявся (unlock-fixed-orphans)'));
  const w = i.unlock.withheld;
  if (w.length > 0) {
    const examples = w.slice(0, WITHHELD_EXAMPLES).map((r) => `#${r.issueNumber} / beer ${r.beerId}`).join(', ');
    f.push(yellow(`утримано після закриття: ${w.length} (${examples}${w.length > WITHHELD_EXAMPLES ? ', …' : ''})`));
  }
  if (m.unlockedUnadjudicated7d > 0) {
    f.push(yellow(`розімкнено без негативного маркера за 7 днів: ${m.unlockedUnadjudicated7d}`));
  }
  const yesterday = snapshotOn(i.history, shiftDate(i.dateKey, -1));
  if (yesterday !== null && m.sealRetiredFalsified > yesterday.metrics.sealRetiredFalsified) {
    f.push(yellow(`спростованих retire: ${yesterday.metrics.sealRetiredFalsified} → ${m.sealRetiredFalsified}`));
  }
  return evaluation('orphans', f);
}

// Stage 1 sees only the bug-report worker; /match and MCP error counters arrive in stage 2.
export function evaluateChannels(i: StatusInputs): Evaluation {
  const f: Finding[] = [];
  if (i.bugReports !== null) {
    const { summary, paused } = i.bugReports;
    if (paused !== null) {
      f.push(red(`скарги на паузі з ${paused.since.slice(0, 16).replace('T', ' ')} UTC: ключ відхилено (${paused.status})`));
    }
    const review = [...summary.needsReview, ...summary.failed];
    if (review.length > 0) f.push(yellow(`скарги потребують перевірки: ${review.map((id) => `R-${id}`).join(', ')}`));
  }
  return evaluation('channels', f);
}

export interface StatusEvaluation {
  overall: Colour;
  subsystems: Evaluation[];
  footers: string[];
}

export function evaluateAll(i: StatusInputs): StatusEvaluation {
  const subsystems = [
    evaluateTaps(i),
    evaluateUntappd(i),
    evaluateOrphans(i),
    evaluateChannels(i),
    ...(i.fest === null ? [] : [evaluateFest(i.fest, i.now)]),
    evaluateInfra(i),
  ];
  const known = Array.from({ length: R.historyDays }, (_, k) => shiftDate(i.dateKey, -(k + 1)))
    .filter((d) => snapshotOn(i.history, d) !== null).length;
  const footers = known < R.historyDays
    ? [`історія: ${known}/${R.historyDays} днів — порівняльні правила ще не діють`]
    : [];
  return { overall: worst(subsystems.map((s) => s.colour)), subsystems, footers };
}
```

- [ ] **Step 4: Run the gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Mutation check**

Temporarily replace `yellow(\`спростованих retire` with `red(\`спростованих retire` — the "capped" test must FAIL. Revert; PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/status
git commit -m "feat(status): orphan and channel evaluators, overall colour and history footer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Trends

**Files:**
- Create: `src/domain/status/trends.ts`
- Test: `src/domain/status/trends.test.ts`

**Interfaces:**
- Consumes: helpers, rules, fixture.
- Produces: `export function computeTrends(dateKey: string, today: SnapshotMetrics, history: SnapshotRecord[]): string[];`

- [ ] **Step 1: Write the failing tests**

`src/domain/status/trends.test.ts`:

```ts
import { computeTrends } from './trends';
import { DATE, GREEN_METRICS, pastDays } from './test-inputs';
import { GIB_BYTES } from './rules';
import type { SnapshotMetrics } from './types';

const today = (patch: Partial<SnapshotMetrics>) => ({ ...GREEN_METRICS, ...patch });
const weekAgo = (patch: Partial<SnapshotMetrics>) => [{ date: '2026-09-29', metrics: today(patch) }];

test('no history means no trends', () => {
  expect(computeTrends(DATE, today({ orphansPending: 9_999 }), [])).toEqual([]);
});

test('a stock line needs both +10 % and +20 units against the value a week ago', () => {
  expect([
    computeTrends(DATE, today({ orphansPending: 120 }), weekAgo({ orphansPending: 100 })),  // +20 exactly: no
    computeTrends(DATE, today({ orphansPending: 121 }), weekAgo({ orphansPending: 100 })),
    computeTrends(DATE, today({ orphansPending: 1_021 }), weekAgo({ orphansPending: 1_000 })), // +2.1 %: no
  ]).toEqual([[], ['сиріт у черзі: 100 → 121 (+21 % за тиждень)'], []]);
});

test('a falling stock reads with a minus sign and grouped thousands', () => {
  expect(computeTrends(DATE, today({ beersTotal: 26_000 }), weekAgo({ beersTotal: 30_000 })))
    .toEqual(['пив у каталозі: 30 000 → 26 000 (−13 % за тиждень)']);
});

test('disk trend is in GiB and needs a full GiB of movement', () => {
  expect([
    computeTrends(DATE, today({ diskBytesAvailable: 31 * GIB_BYTES }), weekAgo({ diskBytesAvailable: 32 * GIB_BYTES })),
    computeTrends(DATE, today({ diskBytesAvailable: 28 * GIB_BYTES }), weekAgo({ diskBytesAvailable: 32 * GIB_BYTES })),
  ]).toEqual([[], ['вільно на диску, GiB: 32.00 → 28.00 (−13 % за тиждень)']]);
});

test('a null disk value on either side skips the disk line', () => {
  expect(computeTrends(DATE, today({ diskBytesAvailable: null }), weekAgo({ diskBytesAvailable: 1 }))).toEqual([]);
});

test('flows compare two 7-day sums and need both +50 % and +10', () => {
  // previous window DATE-7..DATE-13: 7 × 2 = 14. Current window = today + DATE-1..DATE-6 at 3 each:
  // today 6 → 24 (delta 10, not > 10: silent); today 7 → 25 (delta 11 > 10 and > 7: shown).
  const history = [...pastDays(6, { extMatchRequests: 3 }), ...pastDays(13, { extMatchRequests: 2 }).slice(6)];
  expect([
    computeTrends(DATE, today({ extMatchRequests: 6 }), history),
    computeTrends(DATE, today({ extMatchRequests: 7 }), history),
  ]).toEqual([[], ['запитів розширення: 14 → 25 за 7 днів (+79 %)']]);
});

test('flows stay silent when any of the 13 previous days is missing', () => {
  const history = [...pastDays(6, { extMatchRequests: 30 }), ...pastDays(12, { extMatchRequests: 0 }).slice(6)];
  expect(computeTrends(DATE, today({ extMatchRequests: 30 }), history)).toEqual([]);
});

test('a flow growing from zero reads as new', () => {
  const history = [...pastDays(6, { mcpMatchRequests: 2 }), ...pastDays(13, { mcpMatchRequests: 0 }).slice(6)];
  expect(computeTrends(DATE, today({ mcpMatchRequests: 2 }), history)).toEqual(['запитів MCP: 0 → 14 за 7 днів (нове)']);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/domain/status/trends.test.ts`
Expected: FAIL — `Cannot find module './trends'`.

- [ ] **Step 3: Implement**

`src/domain/status/trends.ts`:

```ts
import type { SnapshotMetrics, SnapshotRecord } from './types';
import { STATUS_RULES as R } from './rules';
import { gib, groupThousands, previousDays, shiftDate, snapshotOn } from './helpers';

interface Series {
  label: string;
  read: (m: SnapshotMetrics) => number | null;
  abs: number;
  format: (n: number) => string;
}

// Stocks accumulate: compare today with the snapshot exactly a week ago.
const STOCKS: Series[] = [
  { label: 'сиріт у черзі', read: (m) => m.orphansPending, abs: R.stockAbs, format: groupThousands },
  { label: 'у relay-черзі', read: (m) => m.orphansRelayQueue, abs: R.stockAbs, format: groupThousands },
  { label: 'зматчених без рейтингу', read: (m) => m.ratingsMissing, abs: R.stockAbs, format: groupThousands },
  { label: 'рядків під замком', read: (m) => m.lockedRows, abs: R.stockAbs, format: groupThousands },
  { label: 'пив у каталозі', read: (m) => m.beersTotal, abs: R.stockAbs, format: groupThousands },
  { label: 'вільно на диску, GiB', read: (m) => m.diskBytesAvailable, abs: R.diskTrendAbsBytes, format: gib },
];

// Flows are per-day counts that swing 4–73 day to day (probe 2026-10-06): compare two 7-day sums.
const FLOWS: Series[] = [
  { label: 'запитів розширення', read: (m) => m.extMatchRequests, abs: R.flowAbs, format: groupThousands },
  { label: 'запитів MCP', read: (m) => m.mcpMatchRequests, abs: R.flowAbs, format: groupThousands },
  { label: 'зматчено enrich', read: (m) => m.enrichMatched24h, abs: R.flowAbs, format: groupThousands },
  { label: 'провалів enrich', read: (m) => m.enrichFailures24h, abs: R.flowAbs, format: groupThousands },
  { label: 'нових на кранах', read: (m) => m.newOnTap24h, abs: R.flowAbs, format: groupThousands },
];

function moved(from: number, to: number, rel: number, abs: number): boolean {
  const delta = Math.abs(to - from);
  return delta > abs && delta > Math.abs(from) * rel;
}

function change(from: number, to: number): string {
  if (from === 0) return 'нове';
  return `${to > from ? '+' : '−'}${Math.round((Math.abs(to - from) / from) * 100)} %`;
}

export function computeTrends(dateKey: string, today: SnapshotMetrics, history: SnapshotRecord[]): string[] {
  const lines: string[] = [];
  const weekAgo = snapshotOn(history, shiftDate(dateKey, -R.historyDays));
  if (weekAgo !== null) {
    for (const s of STOCKS) {
      const from = s.read(weekAgo.metrics);
      const to = s.read(today);
      if (from === null || to === null || !moved(from, to, R.stockRel, s.abs)) continue;
      lines.push(`${s.label}: ${s.format(from)} → ${s.format(to)} (${change(from, to)} за тиждень)`);
    }
  }
  const recent = previousDays(history, dateKey, R.historyDays - 1);                          // d-1 .. d-6
  const earlier = previousDays(history, shiftDate(dateKey, -(R.historyDays - 1)), R.historyDays); // d-7 .. d-13
  if (recent !== null && earlier !== null) {
    for (const s of FLOWS) {
      const sum = (ms: SnapshotMetrics[]) => ms.reduce((acc, m) => acc + (s.read(m) ?? 0), 0);
      const to = sum([today, ...recent.map((r) => r.metrics)]);
      const from = sum(earlier.map((r) => r.metrics));
      if (!moved(from, to, R.flowRel, s.abs)) continue;
      lines.push(`${s.label}: ${s.format(from)} → ${s.format(to)} за 7 днів (${change(from, to)})`);
    }
  }
  return lines;
}
```

- [ ] **Step 4: Run the gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/status/trends.ts src/domain/status/trends.test.ts
git commit -m "feat(status): stock and flow trends over daily snapshots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Renderer

**Files:**
- Create: `src/domain/status/render.ts`
- Test: `src/domain/status/render.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:

```ts
export const TELEGRAM_LIMIT = 4096;
export interface StatusReport { stamp: string; overall: Colour; subsystems: Evaluation[]; footers: string[]; events: string[]; users: string[]; trends: string[] }
export function renderStatusReport(r: StatusReport): string;
```

- [ ] **Step 1: Write the failing tests**

`src/domain/status/render.test.ts`:

```ts
import { renderStatusReport, TELEGRAM_LIMIT, type StatusReport } from './render';

const allGreen: StatusReport = {
  stamp: '2026-10-06 09:00', overall: 'green',
  subsystems: [
    { subsystem: 'taps', colour: 'green', reasons: [] },
    { subsystem: 'untappd', colour: 'green', reasons: [] },
    { subsystem: 'infra', colour: 'green', reasons: [] },
  ],
  footers: [], events: [], users: [], trends: [],
};

test('an all-green day with nothing else is the header and the light row only', () => {
  expect(renderStatusReport(allGreen)).toBe('🟢 Статус бота — 2026-10-06 09:00 · все гаразд\n\n🟢 Крани  🟢 Untappd  🟢 Інфраструктура');
});

test('full layout: reasons only under non-green, footers, then events, users, trends', () => {
  const report: StatusReport = {
    stamp: '2026-10-06 09:00', overall: 'red',
    subsystems: [
      { subsystem: 'taps', colour: 'green', reasons: [] },
      { subsystem: 'untappd', colour: 'red', reasons: ['канарка пошуку порожня на останньому запуску (05:30)'] },
      { subsystem: 'orphans', colour: 'yellow', reasons: ['тріаж сиріт сьогодні не відпрацював', 'спростованих retire: 2 → 5'] },
    ],
    footers: ['історія: 3/7 днів — порівняльні правила ще не діють'],
    events: ['Тріаж: 7 рядків'],
    users: ['розширення /match (вчора): 3 запитів · 1 анонім. · 200 пив'],
    trends: ['сиріт у черзі: 100 → 121 (+21 % за тиждень)'],
  };
  expect(renderStatusReport(report)).toBe([
    '🔴 Статус бота — 2026-10-06 09:00 · потрібна реакція',
    '',
    '🟢 Крани  🔴 Untappd  🟡 Сироти',
    '',
    '🔴 Untappd',
    '  • канарка пошуку порожня на останньому запуску (05:30)',
    '',
    '🟡 Сироти',
    '  • тріаж сиріт сьогодні не відпрацював',
    '  • спростованих retire: 2 → 5',
    '',
    'ℹ️ історія: 3/7 днів — порівняльні правила ще не діють',
    '',
    'Події',
    '  • Тріаж: 7 рядків',
    '',
    'Живі користувачі',
    '  • розширення /match (вчора): 3 запитів · 1 анонім. · 200 пив',
    '',
    'Тренди',
    '  • сиріт у черзі: 100 → 121 (+21 % за тиждень)',
  ].join('\n'));
});

test('a yellow overall says it needs attention', () => {
  const text = renderStatusReport({ ...allGreen, overall: 'yellow' });
  expect(text.split('\n')[0]).toBe('🟡 Статус бота — 2026-10-06 09:00 · потребує уваги');
});

test('an over-long report is cut to the Telegram limit with a visible mark', () => {
  const text = renderStatusReport({ ...allGreen, trends: Array.from({ length: 400 }, (_, k) => `тренд ${k}`) });
  expect([text.length, text.endsWith('\n… (обрізано)'), text.startsWith('🟢 Статус бота')]).toEqual([TELEGRAM_LIMIT, true, true]);
});

test('a report exactly at the limit is not cut', () => {
  const head = renderStatusReport(allGreen);
  const filler = 'x'.repeat(TELEGRAM_LIMIT - head.length - '\n\nПодії\n  • '.length);
  const text = renderStatusReport({ ...allGreen, events: [filler] });
  expect([text.length, text.endsWith(filler)]).toEqual([TELEGRAM_LIMIT, true]);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/domain/status/render.test.ts`
Expected: FAIL — `Cannot find module './render'`.

- [ ] **Step 3: Implement**

`src/domain/status/render.ts`:

```ts
import type { Colour, Evaluation, SubsystemId } from './types';

export const TELEGRAM_LIMIT = 4096;
const TRUNCATION_MARK = '\n… (обрізано)';

const EMOJI: Record<Colour, string> = { green: '🟢', yellow: '🟡', red: '🔴' };
const VERDICT: Record<Colour, string> = { green: 'все гаразд', yellow: 'потребує уваги', red: 'потрібна реакція' };
const NAME: Record<SubsystemId, string> = {
  taps: 'Крани', untappd: 'Untappd', orphans: 'Сироти', channels: 'Канали', fest: 'Фест', infra: 'Інфраструктура',
};

export interface StatusReport {
  stamp: string;          // Warsaw "YYYY-MM-DD HH:mm"
  overall: Colour;
  subsystems: Evaluation[];
  footers: string[];
  events: string[];
  users: string[];
  trends: string[];
}

const section = (title: string, lines: string[]): string[][] =>
  lines.length === 0 ? [] : [[title, ...lines.map((l) => `  • ${l}`)]];

// Order is urgency: what needs a reaction first, trends last — so truncation eats trends first.
export function renderStatusReport(r: StatusReport): string {
  const blocks: string[][] = [
    [
      `${EMOJI[r.overall]} Статус бота — ${r.stamp} · ${VERDICT[r.overall]}`,
      '',
      r.subsystems.map((s) => `${EMOJI[s.colour]} ${NAME[s.subsystem]}`).join('  '),
    ],
    ...r.subsystems
      .filter((s) => s.colour !== 'green')
      .map((s) => [`${EMOJI[s.colour]} ${NAME[s.subsystem]}`, ...s.reasons.map((x) => `  • ${x}`)]),
    ...(r.footers.length === 0 ? [] : [r.footers.map((x) => `ℹ️ ${x}`)]),
    ...section('Події', r.events),
    ...section('Живі користувачі', r.users),
    ...section('Тренди', r.trends),
  ];
  const text = blocks.map((b) => b.join('\n')).join('\n\n');
  return text.length <= TELEGRAM_LIMIT
    ? text
    : text.slice(0, TELEGRAM_LIMIT - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}
```

- [ ] **Step 4: Run the gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/status/render.ts src/domain/status/render.test.ts
git commit -m "feat(status): traffic-light renderer with urgency-ordered truncation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Collector, `dailyStatus` wiring, fallback and `spec.md`

**Files:**
- Create: `src/jobs/status-inputs.ts`
- Test: `src/jobs/status-inputs.test.ts`
- Modify: `src/jobs/daily-status.ts` (replace `buildStatusMessage` and the body of `dailyStatus`; keep `buildBugReportLine`, `shouldSendDailyStatus`, `DailyStatusDeps`, `warsawStamp`)
- Modify: `src/jobs/daily-status.test.ts` (keep the `buildBugReportLine` and `shouldSendDailyStatus` tests; replace every test that asserts `buildStatusMessage` output or `• Тести:` lines)
- Modify: `spec.md`

**Interfaces:**
- Consumes: everything above; `collectStatus` (`src/storage/stats.ts`), `getJobState`/`setJobState`, `summarizeSince` (`src/storage/bug_reports.ts`), `CANARY_STATE_KEY` (`src/jobs/enrich-orphans.ts`), `TRIAGE_LAST_RUN_KEY`/`TRIAGE_LAST_RESULT_KEY` (`src/jobs/orphan-triage.ts`), `UNLOCK_LAST_RUN_KEY`/`UNLOCK_LAST_RESULT_KEY` (`src/jobs/unlock-fixed-orphans.ts`), `BUG_REPORT_PAUSED_KEY` (`src/jobs/bug-report-worker.ts`), `currentOrNextFests` (`src/storage/fests.ts`), `FEST_MENU_LAST_KEY` (`src/jobs/fest-poll.ts`), `KEEPALIVE_LAST_KEY`/`KEEPALIVE_EVERY_MS` (`src/jobs/fest-friend-feed.ts`), `MENU_INTERVAL_RUN_UP_MS` (`src/domain/fest/schedule.ts`).
- Produces:

```ts
// status-inputs.ts
export interface StatusInputOptions { repo?: string; testDiagnosticsPath?: string; testDiagnosticsUid?: number }
export function collectStatusInputs(db: DB, now: Date, dateKey: string, opts: StatusInputOptions): StatusInputs;
// daily-status.ts
export const EVENTS_FOOTER: string;
export function buildDailyReport(db: DB, now: Date, dateKey: string, opts: StatusInputOptions): string;
export async function dailyStatus(deps: DailyStatusDeps): Promise<void>; // unchanged signature
```

- [ ] **Step 1: Write the failing collector tests**

`src/jobs/status-inputs.test.ts`:

```ts
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { setJobState } from '../storage/job_state';
import { saveStatusSnapshot } from '../storage/status_snapshots';
import { collectStatusInputs } from './status-inputs';
import { CANARY_STATE_KEY } from './enrich-orphans';
import { TRIAGE_LAST_RESULT_KEY, TRIAGE_LAST_RUN_KEY } from './orphan-triage';
import { UNLOCK_LAST_RESULT_KEY, UNLOCK_LAST_RUN_KEY } from './unlock-fixed-orphans';
import { GREEN_METRICS } from '../domain/status/test-inputs';

const NOW = new Date('2026-10-06T07:00:00.000Z');
const DATE = '2026-10-06';
const missing = { testDiagnosticsPath: join(tmpdir(), 'wbb-status-inputs-missing', 'summary.json') };

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('canary: absent → never ran; valid → value; malformed → unavailable', () => {
  const db = emptyDb();
  const absent = collectStatusInputs(db, NOW, DATE, missing).canary;
  setJobState(db, CANARY_STATE_KEY, JSON.stringify({ ok: false, at: '2026-10-06T03:30:10.000Z' }));
  const valid = collectStatusInputs(db, NOW, DATE, missing).canary;
  setJobState(db, CANARY_STATE_KEY, '{"ok":"yes"}');
  const malformed = collectStatusInputs(db, NOW, DATE, missing).canary;
  expect([absent, valid, malformed]).toEqual([
    { ok: true, value: null },
    { ok: true, value: { ok: false, at: '2026-10-06T03:30:10.000Z' } },
    { ok: false, reason: 'стан канарки пошкоджено' },
  ]);
});

test('triage and unlock: ran today only when their run key is today; stale results are ignored', () => {
  const db = emptyDb();
  setJobState(db, TRIAGE_LAST_RUN_KEY, DATE);
  setJobState(db, TRIAGE_LAST_RESULT_KEY, JSON.stringify({ date: DATE, line: 'Тріаж: 7 рядків', saturated: 'Насичені: #452 (14) — усього 1' }));
  setJobState(db, UNLOCK_LAST_RUN_KEY, '2026-10-05');
  setJobState(db, UNLOCK_LAST_RESULT_KEY, JSON.stringify({ date: '2026-10-05', withheld: [{ beerId: 1, issueNumber: 2 }] }));
  const i = collectStatusInputs(db, NOW, DATE, missing);
  expect([i.triage, i.unlock]).toEqual([
    { ranToday: true, line: 'Тріаж: 7 рядків', saturated: 'Насичені: #452 (14) — усього 1' },
    { ranToday: false, withheld: [] },
  ]);
});

test('unlock withheld rows with an invalid id are dropped as a whole result', () => {
  const db = emptyDb();
  setJobState(db, UNLOCK_LAST_RUN_KEY, DATE);
  setJobState(db, UNLOCK_LAST_RESULT_KEY, JSON.stringify({ date: DATE, withheld: [{ beerId: 1, issueNumber: 2 }, { beerId: -3, issueNumber: 4 }] }));
  expect(collectStatusInputs(db, NOW, DATE, missing).unlock).toEqual({ ranToday: true, withheld: [] });
});

test('missing monitor file is unavailable disk data and null disk metrics', () => {
  const i = collectStatusInputs(emptyDb(), NOW, DATE, missing);
  expect([i.disk, i.metrics.diskBytesAvailable, i.metrics.inodesFree]).toEqual([
    { ok: false, reason: 'дані монітора недоступні' }, null, null,
  ]);
});

test('no repo → no bug-report channel; a repo → summary and paused state', () => {
  const db = emptyDb();
  const without = collectStatusInputs(db, NOW, DATE, missing).bugReports;
  const withRepo = collectStatusInputs(db, NOW, DATE, { ...missing, repo: 'o/r' }).bugReports;
  expect([without, withRepo?.paused, withRepo?.summary.processed]).toEqual([null, null, 0]);
});

test('history covers the 13 days before the report date and excludes today', () => {
  const db = emptyDb();
  for (const date of ['2026-09-22', '2026-09-23', '2026-10-05', '2026-10-06']) {
    saveStatusSnapshot(db, { date, metrics: GREEN_METRICS, colours: [], createdAt: `${date}T07:00:00.000Z` });
  }
  expect(collectStatusInputs(db, NOW, DATE, missing).history.map((s) => s.date)).toEqual(['2026-09-23', '2026-10-05']);
});

test('fest inputs are null without a current or upcoming fest', () => {
  expect(collectStatusInputs(emptyDb(), new Date('2027-06-01T07:00:00.000Z'), '2027-06-01', missing).fest).toBeNull();
});
```

(Migration v42 seeds WFP22. If its sessions are in the past relative to `2027-06-01`, the last test holds. Check `V42_FEST_SQL` before running; if the seed is later than 2027-06-01, move that test's date past the seed's last session and say so in the report.)

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/jobs/status-inputs.test.ts`
Expected: FAIL — `Cannot find module './status-inputs'`.

- [ ] **Step 3: Implement the collector**

`src/jobs/status-inputs.ts`:

```ts
import type { DB } from '../storage/db';
import type { Avail, FestInputs, StatusInputs } from '../domain/status/types';
import { collectStatus } from '../storage/stats';
import { getJobState } from '../storage/job_state';
import { summarizeSince } from '../storage/bug_reports';
import { listStatusSnapshots } from '../storage/status_snapshots';
import { currentOrNextFests } from '../storage/fests';
import { shiftDate } from '../domain/status/helpers';
import { STATUS_RULES } from '../domain/status/rules';
import { MENU_INTERVAL_RUN_UP_MS } from '../domain/fest/schedule';
import { readTestDiagnostics } from './test-diagnostics';
import { CANARY_STATE_KEY } from './enrich-orphans';
import { TRIAGE_LAST_RESULT_KEY, TRIAGE_LAST_RUN_KEY } from './orphan-triage';
import { UNLOCK_LAST_RESULT_KEY, UNLOCK_LAST_RUN_KEY } from './unlock-fixed-orphans';
import { BUG_REPORT_PAUSED_KEY } from './bug-report-worker';
import { FEST_MENU_LAST_KEY } from './fest-poll';
import { KEEPALIVE_EVERY_MS, KEEPALIVE_LAST_KEY } from './fest-friend-feed';

export interface StatusInputOptions {
  repo?: string;
  testDiagnosticsPath?: string;
  testDiagnosticsUid?: number;
}

const parse = (raw: string | null): unknown => {
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
};

function readCanary(db: DB): Avail<{ ok: boolean; at: string } | null> {
  const raw = getJobState(db, CANARY_STATE_KEY);
  if (raw === null) return { ok: true, value: null };
  const p = parse(raw) as { ok?: unknown; at?: unknown } | null | undefined;
  return p && typeof p.ok === 'boolean' && typeof p.at === 'string'
    ? { ok: true, value: { ok: p.ok, at: p.at } }
    : { ok: false, reason: 'стан канарки пошкоджено' };
}

function readTriage(db: DB, dateKey: string): StatusInputs['triage'] {
  const p = parse(getJobState(db, TRIAGE_LAST_RESULT_KEY)) as { date?: unknown; line?: unknown; saturated?: unknown } | null | undefined;
  const today = p && p.date === dateKey;
  return {
    ranToday: getJobState(db, TRIAGE_LAST_RUN_KEY) === dateKey,
    line: today && typeof p.line === 'string' ? p.line : null,
    // `?? null` semantics: a payload written before #431 has no saturated key.
    saturated: today && typeof p.saturated === 'string' ? p.saturated : null,
  };
}

const validId = (n: unknown): boolean => Number.isSafeInteger(n) && Number(n) > 0;

function readUnlock(db: DB, dateKey: string): StatusInputs['unlock'] {
  const ranToday = getJobState(db, UNLOCK_LAST_RUN_KEY) === dateKey;
  const p = parse(getJobState(db, UNLOCK_LAST_RESULT_KEY)) as { date?: unknown; withheld?: unknown } | null | undefined;
  if (!p || p.date !== dateKey || !Array.isArray(p.withheld)) return { ranToday, withheld: [] };
  const rows = p.withheld as { beerId?: unknown; issueNumber?: unknown }[];
  // All-or-nothing, as the old digest did: one malformed row means the result is not trustworthy.
  if (!rows.every((r) => r && validId(r.beerId) && validId(r.issueNumber))) return { ranToday, withheld: [] };
  return { ranToday, withheld: rows.map((r) => ({ beerId: Number(r.beerId), issueNumber: Number(r.issueNumber) })) };
}

function readPaused(db: DB): { since: string; status: number } | null {
  const p = parse(getJobState(db, BUG_REPORT_PAUSED_KEY)) as { since?: unknown; status?: unknown } | null | undefined;
  return p && typeof p.since === 'string' && typeof p.status === 'number' ? { since: p.since, status: p.status } : null;
}

function readFest(db: DB, now: Date): FestInputs | null {
  if (currentOrNextFests(db, now).length === 0) return null;
  return {
    menuLastAt: getJobState(db, FEST_MENU_LAST_KEY),
    menuCycleMs: MENU_INTERVAL_RUN_UP_MS,
    keepaliveLastAt: getJobState(db, KEEPALIVE_LAST_KEY),
    keepaliveCycleMs: KEEPALIVE_EVERY_MS,
  };
}

// The only place the morning report reads the DB, job_state and files. Every source that can be
// missing comes back as a value the evaluators can colour, never as an exception.
export function collectStatusInputs(db: DB, now: Date, dateKey: string, opts: StatusInputOptions): StatusInputs {
  const metrics = collectStatus(db, now);
  const diag = readTestDiagnostics(now, opts.testDiagnosticsPath, opts.testDiagnosticsUid);
  const historyDays = 2 * STATUS_RULES.historyDays - 1; // flows compare d-13..d-7 with d-6..today
  return {
    now,
    dateKey,
    metrics: {
      ...metrics,
      diskBytesAvailable: diag.kind === 'ok' ? diag.bytesAvailable : null,
      inodesFree: diag.kind === 'ok' ? diag.inodesFree : null,
    },
    history: listStatusSnapshots(db, shiftDate(dateKey, -historyDays), dateKey),
    canary: readCanary(db),
    algoliaOpenUntil: getJobState(db, 'untappd_circuit_open_until'),
    profileOpenUntil: getJobState(db, 'untappd_profile_http_open_until'),
    triage: readTriage(db, dateKey),
    unlock: readUnlock(db, dateKey),
    bugReports: opts.repo
      ? { summary: summarizeSince(db, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()), paused: readPaused(db) }
      : null,
    disk: diag.kind === 'ok'
      ? { ok: true, value: { bytesAvailable: diag.bytesAvailable, inodesFree: diag.inodesFree, pendingRuns: diag.pendingRuns } }
      : { ok: false, reason: diag.kind === 'stale' ? 'дані монітора застарілі' : 'дані монітора недоступні' },
    fest: readFest(db, now),
  };
}
```

Note `readTestDiagnostics(now, undefined, …)` uses the default `SUMMARY_PATH` because the parameter has a default value — production passes no path.

- [ ] **Step 4: Run the collector tests**

Run: `npx vitest run src/jobs/status-inputs.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite `dailyStatus`**

In `src/jobs/daily-status.ts`:

1. Delete `buildStatusMessage` and the old body of `dailyStatus` (from `const metrics = collectStatus(db, now);` to the end of the function), and the now-unused imports (`collectStatus`, `StatusMetrics`, `TRIAGE_LAST_RESULT_KEY`, `UNLOCK_LAST_RESULT_KEY`, `readTestDiagnosticsLine`, `summarizeSince` if no longer used).
2. Keep `group`, `buildBugReportLine`, `warsawStamp`, `ShouldSendArgs`, `shouldSendDailyStatus`, `DailyStatusDeps`, `DAILY_STATUS_KEY`.
3. Add:

```ts
import type { DB } from '../storage/db';
import type { StatusMetrics } from '../storage/stats';
import { saveStatusSnapshot, pruneStatusSnapshots } from '../storage/status_snapshots';
import { summarizeSince } from '../storage/bug_reports';
import { evaluateAll } from '../domain/status/evaluate';
import { computeTrends } from '../domain/status/trends';
import { renderStatusReport } from '../domain/status/render';
import { shiftDate } from '../domain/status/helpers';
import { STATUS_RULES } from '../domain/status/rules';
import { collectStatusInputs, type StatusInputOptions } from './status-inputs';

// Stage 1 of the traffic light reads no event log yet, so an incident that ended before 09:00 is
// invisible; the report says so instead of letting 🟢 claim it (spec, "Claims and evidence").
export const EVENTS_FOOTER = 'події: ще не підключені — нічні інциденти, що вже минули, звіт поки не бачить';
const FALLBACK_SENT_KEY = 'daily_status_fallback_sent';

function buildUserLines(m: StatusMetrics, bugReportLine: string | null): string[] {
  return [
    ...(m.extMatchRequests > 0
      ? [`розширення /match (вчора): ${group(m.extMatchRequests)} запитів · ${group(m.extMatchAnon)} анонім. · ${group(m.extMatchBeers)} пив`]
      : []),
    ...(m.mcpMatchRequests > 0
      ? [`MCP /match (вчора): ${group(m.mcpMatchRequests)} запитів · ${group(m.mcpMatchBeers)} пив`]
      : []),
    ...(bugReportLine ? [bugReportLine] : []),
  ];
}

// Collect → evaluate → snapshot → render. The snapshot is written before anything is sent, so a
// failed delivery never costs a day of history; re-running the same day overwrites it.
export function buildDailyReport(db: DB, now: Date, dateKey: string, opts: StatusInputOptions): string {
  const inputs = collectStatusInputs(db, now, dateKey, opts);
  const evaluation = evaluateAll(inputs);
  saveStatusSnapshot(db, { date: dateKey, metrics: inputs.metrics, colours: evaluation.subsystems, createdAt: now.toISOString() });
  pruneStatusSnapshots(db, shiftDate(dateKey, -STATUS_RULES.snapshotRetentionDays));
  // The pause is a channel-health fact (🔴 Канали), so the users section shows activity only.
  const bugReportLine = opts.repo && inputs.bugReports
    ? buildBugReportLine(inputs.bugReports.summary, null, opts.repo)
    : null;
  return renderStatusReport({
    stamp: warsawStamp(now),
    overall: evaluation.overall,
    subsystems: evaluation.subsystems,
    footers: [...evaluation.footers, EVENTS_FOOTER],
    events: inputs.triage.line ? [inputs.triage.line] : [],
    users: buildUserLines(inputs.metrics, bugReportLine),
    trends: computeTrends(dateKey, inputs.metrics, inputs.history),
  });
}
```

(If `summarizeSince` ends up unused in this file after the edit, drop its import — the collector owns it now.)

4. Replace the body of `dailyStatus` after the `if (!send) { … return; }` block with:

```ts
  let text: string;
  try {
    text = buildDailyReport(db, now, dateKey, {
      repo: deps.repo, testDiagnosticsPath: deps.testDiagnosticsPath, testDiagnosticsUid: deps.testDiagnosticsUid,
    });
  } catch (e) {
    // The report itself broke. Say so once per Warsaw day instead of going silent; the delivery
    // marker stays unset, so every later tick in the window retries the full report.
    log.error({ err: e }, 'daily-status: report assembly failed');
    if (getJobState(db, FALLBACK_SENT_KEY) === dateKey) return;
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    try {
      await notifyAdmin(`🔴 Статус бота — ${warsawStamp(now)} · звіт не зібрано: ${reason}`);
      setJobState(db, FALLBACK_SENT_KEY, dateKey);
    } catch (sendErr) {
      log.error({ err: sendErr }, 'daily-status fallback send failed');
    }
    return;
  }
  try {
    await notifyAdmin(text);
    setJobState(db, DAILY_STATUS_KEY, dateKey);
    log.info({ dateKey }, 'daily-status sent');
  } catch (e) {
    log.error({ err: e }, 'daily-status send failed');
  }
```

- [ ] **Step 6: Rewrite the `dailyStatus` tests**

In `src/jobs/daily-status.test.ts`: delete every test that calls `buildStatusMessage` or asserts a `• Тести:` line (`morning digest includes test telemetry…`, `missing test telemetry…`, `failed morning send retries the diagnostic line…`, `buildStatusMessage renders the report line…`, `buildStatusMessage: full message exact string`, `buildStatusMessage: the MCP line…`, `buildStatusMessage: stale scrape…`, `buildStatusMessage: no snapshots…`, `buildStatusMessage: null dbSizeMb…`, `dailyStatus includes the report digest…`, `dailyStatus without a repo leaves out the report line`, `dailyStatus shows same-day withheld…`, `dailyStatus ignores stale or malformed withheld…`). Keep the `buildBugReportLine`, window/idempotence/send-failure and `shouldSendDailyStatus` tests, adapting any assertion on message content to the new format. Add:

```ts
import { saveStatusSnapshot } from '../storage/status_snapshots';
import { EVENTS_FOOTER } from './daily-status';

const missingMonitor = { testDiagnosticsPath: join(tmpdir(), 'wbb-daily-missing', 'summary.json') };

test('dailyStatus sends the traffic light and writes today\'s snapshot first', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  await dailyStatus({ db, log: silentLog, now: () => new Date('2026-10-06T07:00:00Z'), ...missingMonitor,
    notifyAdmin: async (t) => { sent.push(t); } });
  expect([
    sent.length,
    sent[0].split('\n')[0],
    sent[0].includes(`ℹ️ ${EVENTS_FOOTER}`),
    db.prepare('SELECT date FROM status_snapshots').all(),
    getJobState(db, 'daily_status_last_sent'),
  ]).toEqual([1, '🔴 Статус бота — 2026-10-06 09:00 · потрібна реакція', true, [{ date: '2026-10-06' }], '2026-10-06']);
});

test('a failed send keeps the snapshot and leaves the day open for the next tick', async () => {
  const db = emptyDb();
  await dailyStatus({ db, log: silentLog, now: () => new Date('2026-10-06T07:00:00Z'), ...missingMonitor,
    notifyAdmin: async () => { throw new Error('synthetic transport unavailable'); } });
  expect([db.prepare('SELECT date FROM status_snapshots').all(), getJobState(db, 'daily_status_last_sent')])
    .toEqual([[{ date: '2026-10-06' }], null]);
});

test('a report that cannot be assembled sends one 🔴 fallback per day and never marks delivery', async () => {
  const db = emptyDb();
  db.exec('DROP TABLE status_snapshots');
  const sent: string[] = [];
  const deps = { db, log: silentLog, now: () => new Date('2026-10-06T07:00:00Z'), ...missingMonitor,
    notifyAdmin: async (t: string) => { sent.push(t); } };
  await dailyStatus(deps);
  await dailyStatus(deps);
  expect([sent.length, sent[0].startsWith('🔴 Статус бота — 2026-10-06 09:00 · звіт не зібрано: '),
    sent[0].includes('no such table: status_snapshots'),
    getJobState(db, 'daily_status_last_sent'), getJobState(db, 'daily_status_fallback_sent')])
    .toEqual([1, true, true, null, '2026-10-06']);
});

test('a week of history removes the history footer', async () => {
  const db = emptyDb();
  for (const date of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) {
    saveStatusSnapshot(db, { date, metrics: GREEN_METRICS, colours: [], createdAt: `${date}T07:00:00.000Z` });
  }
  const sent: string[] = [];
  await dailyStatus({ db, log: silentLog, now: () => new Date('2026-10-06T07:00:00Z'), ...missingMonitor,
    notifyAdmin: async (t) => { sent.push(t); } });
  expect(sent[0].includes('історія:')).toBe(false);
});
```

Add `import { GREEN_METRICS } from '../domain/status/test-inputs';` with the other imports. The first test's header is 🔴 because an empty DB has no scrape; pin the 🔴 to that cause by adding `sent[0].includes('  • скрейпів кранів немає взагалі')` to its asserted array (expected `true`).

- [ ] **Step 7: Run the gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Prod-copy dry run (spec, "Verification and rollout")**

```bash
mkdir -p tmp/status-dry && sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' ".backup tmp/status-dry/bot.db"
cat > tmp/status-dry/run.ts <<'EOF'
import { openDb } from '../../src/storage/db';
import { migrate } from '../../src/storage/schema';
import { buildDailyReport } from '../../src/jobs/daily-status';
const db = openDb('tmp/status-dry/bot.db');
migrate(db);
const now = new Date();
console.log(buildDailyReport(db, now, new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(now), { repo: 'ysilvestrov/warsaw-beer-bot' }));
EOF
npx tsx tmp/status-dry/run.ts
```

Expected: a traffic-light report that reflects prod state. Compare it fact-by-fact with the morning's old report; list in the PR description every old line that is now folded into a 🟢 (e.g. `Каталог`, `БД`, `Користувачі`, `На кранах`) and every old fact that moved (triage → Події, `Печатки`/`Замок` → Сироти reasons). Delete `tmp/status-dry/` afterwards.

- [ ] **Step 9: Update `spec.md`**

1. In the jobs table row for `dailyStatus` (the cell starting `health-дайджест адміну. UTC-тік; …`), replace everything after the first two sentences (schedule and idempotence, which stay) with:

> Звіт — світлофор (спека `docs/superpowers/specs/2026-10/2026-10-06-daily-status-traffic-light-design.md`): загальний колір і колір кожної підсистеми — Крани, Untappd, Сироти (стеля 🟡), Канали, Фест (лише коли `currentOrNextFests` не порожній), Інфраструктура. 🟢 без пояснень; 🟡/🔴 з причинами; «нема даних» — 🟡 з причиною `нема даних: …`. Загальний колір — найгірший. Далі розділи «Події» (зараз — рядок тріажу), «Живі користувачі» (розширення, MCP, скарги — лише ненульові рядки) і «Тренди» (запаси — проти знімка тиждень тому, потоки — сума 7 днів проти попередніх 7, обидва пороги — відносний і абсолютний). Перед відправкою джоба пише знімок дня в `status_snapshots` (90 днів); правила, що порівнюють з історією, неактивні, доки її нема, і звіт це каже рядком `історія: N/7 днів`. Поки журнал подій не підключено, звіт каже `події: ще не підключені`. Якщо зібрати звіт не вдалося, адмін отримує один раз на добу `🔴 … звіт не зібрано: <помилка>`, а маркер доставки не ставиться. Пороги — `src/domain/status/rules.ts`.

2. In the paragraph at the `Аудит у щоденному дайджесті (рядок \`Замок\`)` line, replace `Аудит у щоденному дайджесті (рядок \`Замок\`): скільки рядків …` with `Аудит у щоденному звіті: лічильники замка зберігаються в щоденному знімку, а у звіт потрапляють як причини 🟡 підсистеми «Сироти» — розімкнені без негативного маркера, ріст спростованих retire, утримані після закриття (ID рядків і issues, які втратили відкритий issue, але не мають чинного proof — сигнал оператору, що ручне закриття не завершило closeout); \`під замком\` — у трендах.` and delete the following sentence about «Утримано після закриття» (now covered).

3. In the resource-monitor paragraph, replace `Ранковий \`dailyStatus\` додає один рядок **«Тести»**: кількість каталогів …, вільний диск у GiB та вільні inode.` with `Ранковий \`dailyStatus\` читає знімок як вхід підсистеми «Інфраструктура»: вільний диск (🟡 ≤ 10 GiB, 🔴 ≤ 5 GiB), вільні inode (🔴 < 100 000), кількість каталогів на перевірку (🟡 > 0).` Keep the rest of the paragraph; replace `Неповний/зайнятий/невдалий інвентар означає «дані каталогів недоступні», не нуль.` with `Неповний/зайнятий/невдалий інвентар — 🟡 «нема даних: інвентар тестових каталогів», не нуль.` and `старший знімок позначається як застарілий, майбутній timestamp або відсутні/нечитабельні/некоректні дані — як недоступні. Це не блокує решту репорту.` with `старший знімок дає 🟡 «нема даних: дані монітора застарілі», майбутній timestamp або відсутні/нечитабельні/некоректні дані — 🟡 «нема даних: дані монітора недоступні». Це не блокує решту звіту.`

4. Append to the migrations table after the `| 44 |` row:

> `| 45 | \`status_snapshots\` (date PK, version, metrics_json, colours_json, created_at) — щоденний знімок метрик і кольорів світлофора; без бекфілу, ідемпотентна |`

- [ ] **Step 10: Amend the design spec's fallback rule**

In `docs/superpowers/specs/2026-10/2026-10-06-daily-status-traffic-light-design.md`, section "Errors in the report itself", replace `the delivery marker is **not** set, so the next tick in the window retries.` with `the delivery marker is **not** set, so the next tick in the window retries the full report; the fallback itself goes out at most once per Warsaw day (\`job_state.daily_status_fallback_sent\`), because the tick is every 15 minutes and a broken report would otherwise send twelve of them.`

- [ ] **Step 11: Run the gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/jobs/status-inputs.ts src/jobs/status-inputs.test.ts src/jobs/daily-status.ts src/jobs/daily-status.test.ts spec.md docs/superpowers/specs/2026-10/2026-10-06-daily-status-traffic-light-design.md
git commit -m "feat(status): the morning report becomes a traffic light

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the core

1. End-to-end review of Tasks 1–7 (one reviewer, whole branch), naming any inline-executed tasks.
2. Per `CLAUDE.md`: rebase on `origin/main`, full gate, cross-review in the background, PR. Merging deploys it — no host step in the core, so no `[deploy:hold]`.
3. Only then write the stage-2 plan (events, counters, closed issues, deploy journal), after probes P1/P2 from the spec.
