# Persistent Untappd Circuit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the shared Untappd circuit cooldown across process restarts and deploys using existing `job_state`.

**Architecture:** Keep the existing pure `createCircuitBreaker` for unit-level in-memory behavior and add a DB-backed factory with the same `CircuitBreaker` interface. The persistent factory stores an absolute `untappd_circuit_open_until` ISO timestamp in `job_state`, clears it on recovery/expiry, and is wired only at the composition root.

**Tech Stack:** Node.js 20, TypeScript, Vitest, better-sqlite3, SQLite `job_state`.

---

## Source Spec

- Design: `docs/superpowers/specs/2026-06-25-persistent-untappd-circuit-design.md`
- Prior VPS-wide circuit design: `docs/superpowers/specs/2026-06-25-vps-untappd-circuit-design.md`
- Master behavior: `spec.md` §3.15 and §5.10

## Execution Setup

Before implementation, use `superpowers:using-git-worktrees` and do the work in an isolated worktree, as required by `AGENTS.md`.

## File Structure

- Modify `src/storage/job_state.ts`
  - Add `deleteJobState(db, key)`.
- Modify `src/storage/job_state.test.ts`
  - Add idempotent delete coverage.
- Modify `src/domain/untappd-circuit.ts`
  - Add `createPersistentCircuitBreaker`.
  - Reuse `CircuitBreaker` and `CircuitOptions`.
  - Import `DB`, `getJobState`, `setJobState`, `deleteJobState`.
- Modify `src/domain/untappd-circuit.test.ts`
  - Keep existing pure tests.
  - Add persistent factory tests with in-memory SQLite.
- Modify `src/index.ts`
  - Replace `createCircuitBreaker` with `createPersistentCircuitBreaker`.
  - Pass `db` and `key: 'untappd_circuit_open_until'`.
- No schema migration.
- No job callsite changes beyond the factory used in `src/index.ts`.

---

### Task 1: Add `deleteJobState`

**Files:**
- Modify: `src/storage/job_state.test.ts`
- Modify: `src/storage/job_state.ts`

- [ ] **Step 1: Write the failing delete tests**

In `src/storage/job_state.test.ts`, replace:

```ts
import { getJobState, setJobState } from './job_state';
```

with:

```ts
import { deleteJobState, getJobState, setJobState } from './job_state';
```

Append these tests to the file:

```ts
test('deleteJobState: removes an existing key', () => {
  const db = emptyDb();
  setJobState(db, 'untappd_circuit_open_until', '2026-06-25T18:30:01.000Z');

  deleteJobState(db, 'untappd_circuit_open_until');

  expect(getJobState(db, 'untappd_circuit_open_until')).toBeNull();
});

test('deleteJobState: missing key is a no-op', () => {
  const db = emptyDb();

  deleteJobState(db, 'untappd_circuit_open_until');

  expect(getJobState(db, 'untappd_circuit_open_until')).toBeNull();
});
```

- [ ] **Step 2: Run the storage tests and verify failure**

Run:

```bash
npx vitest run src/storage/job_state.test.ts
```

Expected: fail because `deleteJobState` is not exported.

- [ ] **Step 3: Implement `deleteJobState`**

In `src/storage/job_state.ts`, append:

```ts
export function deleteJobState(db: DB, key: string): void {
  db.prepare('DELETE FROM job_state WHERE key = ?').run(key);
}
```

- [ ] **Step 4: Run storage tests**

Run:

```bash
npx vitest run src/storage/job_state.test.ts
```

Expected: all `job_state` tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/storage/job_state.ts src/storage/job_state.test.ts
git commit -m "feat(storage): allow clearing job state keys"
```

---

### Task 2: Add Persistent Circuit Factory

**Files:**
- Modify: `src/domain/untappd-circuit.test.ts`
- Modify: `src/domain/untappd-circuit.ts`

- [ ] **Step 1: Add test imports**

In `src/domain/untappd-circuit.test.ts`, replace:

```ts
import { createCircuitBreaker } from './untappd-circuit';
```

with:

```ts
import { createCircuitBreaker, createPersistentCircuitBreaker } from './untappd-circuit';
import { getJobState, setJobState } from '../storage/job_state';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
```

- [ ] **Step 2: Add persistent test helpers**

After the existing `at` helper, add:

```ts
const KEY = 'untappd_circuit_open_until';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function persistent(db = freshDb()) {
  const events: string[] = [];
  const cb = createPersistentCircuitBreaker({
    db,
    key: KEY,
    cooldownMs: 6 * 3600_000,
    onTrip: () => events.push('trip'),
    onRecover: () => events.push('recover'),
  });
  return { cb, db, events };
}
```

- [ ] **Step 3: Add failing persistent circuit tests**

Append these tests to `src/domain/untappd-circuit.test.ts`:

```ts
test('persistent circuit: block writes open_until', () => {
  const { cb, db, events } = persistent();

  cb.onResult(true, at(0));

  expect(cb.state).toBe('open');
  expect(getJobState(db, KEY)).toBe('2026-06-04T06:00:00.000Z');
  expect(events).toEqual(['trip']);
});

test('persistent circuit: new breaker skips while persisted open_until is future', () => {
  const db = freshDb();
  setJobState(db, KEY, '2026-06-04T06:00:00.000Z');
  const { cb, events } = persistent(db);

  expect(cb.canAttempt(at(1))).toBe(false);

  expect(cb.state).toBe('open');
  expect(getJobState(db, KEY)).toBe('2026-06-04T06:00:00.000Z');
  expect(events).toEqual([]);
});

test('persistent circuit: expired open_until allows half-open probe and clears key', () => {
  const db = freshDb();
  setJobState(db, KEY, '2026-06-04T06:00:00.000Z');
  const { cb, events } = persistent(db);

  expect(cb.canAttempt(at(6))).toBe(true);

  expect(cb.state).toBe('half_open');
  expect(getJobState(db, KEY)).toBeNull();
  expect(events).toEqual([]);
});

test('persistent circuit: successful half-open probe clears key and emits recovery once', () => {
  const db = freshDb();
  setJobState(db, KEY, '2026-06-04T06:00:00.000Z');
  const { cb, events } = persistent(db);

  expect(cb.canAttempt(at(6))).toBe(true);
  cb.onResult(false, at(6));

  expect(cb.state).toBe('closed');
  expect(getJobState(db, KEY)).toBeNull();
  expect(events).toEqual(['recover']);
});

test('persistent circuit: malformed open_until is cleared and does not block', () => {
  const db = freshDb();
  setJobState(db, KEY, 'not-a-date');
  const { cb, events } = persistent(db);

  expect(cb.canAttempt(at(1))).toBe(true);

  expect(cb.state).toBe('closed');
  expect(getJobState(db, KEY)).toBeNull();
  expect(events).toEqual([]);
});

test('persistent circuit: failed half-open probe reopens and writes a new open_until without trip alert', () => {
  const db = freshDb();
  setJobState(db, KEY, '2026-06-04T06:00:00.000Z');
  const { cb, events } = persistent(db);

  expect(cb.canAttempt(at(6))).toBe(true);
  cb.onResult(true, at(6));

  expect(cb.state).toBe('open');
  expect(getJobState(db, KEY)).toBe('2026-06-04T12:00:00.000Z');
  expect(events).toEqual([]);
});
```

- [ ] **Step 4: Run circuit tests and verify failure**

Run:

```bash
npx vitest run src/domain/untappd-circuit.test.ts
```

Expected: fail because `createPersistentCircuitBreaker` is not exported.

- [ ] **Step 5: Add imports in `untappd-circuit.ts`**

At the top of `src/domain/untappd-circuit.ts`, add:

```ts
import type { DB } from '../storage/db';
import { deleteJobState, getJobState, setJobState } from '../storage/job_state';
```

- [ ] **Step 6: Add persistent options interface**

After `CircuitOptions`, add:

```ts
export interface PersistentCircuitOptions extends CircuitOptions {
  db: DB;
  key: string;
}
```

- [ ] **Step 7: Add a date parser helper**

After `createCircuitBreaker`, add:

```ts
function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
```

- [ ] **Step 8: Implement `createPersistentCircuitBreaker`**

After `parseTimestamp`, add:

```ts
export function createPersistentCircuitBreaker(opts: PersistentCircuitOptions): CircuitBreaker {
  let state: CircuitState = 'closed';
  let openedAt = 0;

  return {
    get state() { return state; },
    canAttempt(now: Date): boolean {
      const persisted = getJobState(opts.db, opts.key);
      const openUntil = parseTimestamp(persisted);
      if (persisted && openUntil == null) {
        deleteJobState(opts.db, opts.key);
      }
      if (openUntil != null) {
        if (openUntil > now.getTime()) {
          state = 'open';
          openedAt = openUntil - opts.cooldownMs;
          return false;
        }
        deleteJobState(opts.db, opts.key);
        state = 'half_open';
        openedAt = openUntil - opts.cooldownMs;
        return true;
      }

      if (state === 'open' && now.getTime() - openedAt >= opts.cooldownMs) {
        state = 'half_open';
      }
      return state !== 'open';
    },
    onResult(blocked: boolean, now: Date): void {
      if (blocked) {
        if (state === 'closed') opts.onTrip();
        state = 'open';
        openedAt = now.getTime();
        setJobState(opts.db, opts.key, new Date(now.getTime() + opts.cooldownMs).toISOString());
      } else {
        if (state !== 'closed') opts.onRecover();
        state = 'closed';
        openedAt = 0;
        deleteJobState(opts.db, opts.key);
      }
    },
  };
}
```

- [ ] **Step 9: Run circuit tests**

Run:

```bash
npx vitest run src/domain/untappd-circuit.test.ts
```

Expected: all circuit tests pass.

- [ ] **Step 10: Run storage and circuit tests together**

Run:

```bash
npx vitest run src/storage/job_state.test.ts src/domain/untappd-circuit.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 11: Commit Task 2**

```bash
git add src/domain/untappd-circuit.ts src/domain/untappd-circuit.test.ts
git commit -m "feat(untappd): persist circuit cooldown in job state"
```

---

### Task 3: Wire Persistent Circuit in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update the circuit import**

In `src/index.ts`, replace:

```ts
import { createCircuitBreaker } from './domain/untappd-circuit';
```

with:

```ts
import { createPersistentCircuitBreaker } from './domain/untappd-circuit';
```

- [ ] **Step 2: Use the persistent factory**

Replace:

```ts
  const untappdBreaker = createCircuitBreaker({
    cooldownMs: 6 * 60 * 60 * 1000,
    onTrip: () => adminAlert('⚠️ Untappd: можливий бан IP (403/429 або captcha). Енрич призупинено на ~6 год.'),
    onRecover: () => adminAlert('✅ Untappd: доступ відновлено, енрич продовжено.'),
  });
```

with:

```ts
  const untappdBreaker = createPersistentCircuitBreaker({
    db,
    key: 'untappd_circuit_open_until',
    cooldownMs: 6 * 60 * 60 * 1000,
    onTrip: () => adminAlert('⚠️ Untappd: можливий бан IP (403/429 або captcha). Енрич призупинено на ~6 год.'),
    onRecover: () => adminAlert('✅ Untappd: доступ відновлено, енрич продовжено.'),
  });
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: `tsc --noEmit` exits 0.

- [ ] **Step 4: Commit Task 3**

```bash
git add src/index.ts
git commit -m "fix(untappd): use persistent circuit in app"
```

---

### Task 4: Full Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run src/storage/job_state.test.ts src/domain/untappd-circuit.test.ts src/jobs/refresh-ontap.test.ts src/jobs/refresh-untappd.test.ts src/jobs/enrich-orphans.test.ts src/jobs/refresh-tap-ratings.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: Vitest exits 0.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: `tsc --noEmit` exits 0.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: `tsc` exits 0.

- [ ] **Step 5: Check whitespace and final diff**

Run:

```bash
git diff --check
git status --short
git diff -- src/storage/job_state.ts src/storage/job_state.test.ts src/domain/untappd-circuit.ts src/domain/untappd-circuit.test.ts src/index.ts
```

Expected: no whitespace errors; no uncommitted source changes after the task commits.

---

## Post-Deploy Verification

After deploy, once the next VPS Untappd block happens:

```bash
sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db \
  "SELECT key, value FROM job_state WHERE key = 'untappd_circuit_open_until';"
```

Expected: a future ISO timestamp while cooldown is active.

To verify restart persistence after a row exists:

```bash
sudo systemctl restart warsaw-beer-bot
journalctl -u warsaw-beer-bot --since "5 minutes ago" --no-pager |
  rg "untappd circuit open|enrich-orphans skipped|refresh-tap-ratings skipped|refresh-untappd skipped"
```

Expected: jobs skip Untappd until `open_until`; no repeated trip alert is emitted just because the process restarted.
