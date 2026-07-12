# Explicit SQLite `busy_timeout` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin SQLite's connection-level `busy_timeout` to 5000ms explicitly in `openDb`, so the WAL/litestream contention guard no longer depends on better-sqlite3's implicit default, and document the busy-handling layering.

**Architecture:** One-line pragma in `openDb` (behavior-preserving — 5000ms equals the current implicit default) plus a guard test, plus a one-line spec doc update. No write-site wrapping, no async conversion, no cron changes (prod logs show zero busy errors outside the already-handled `import` path).

**Tech Stack:** Node.js, TypeScript, Jest, better-sqlite3 v12.9.0.

---

## Design reference

Spec: `docs/superpowers/specs/2026-06-06-explicit-busy-timeout-design.md`

## Background facts the engineer needs

- `src/storage/db.ts` `openDb` currently runs only `journal_mode = WAL` and
  `foreign_keys = ON`. It does NOT set `busy_timeout`.
- better-sqlite3 v12.9.0 applies a default `busy_timeout` of 5000ms (its
  constructor `timeout` option default). Verified: `db.pragma('busy_timeout',
  { simple: true })` returns `5000` on a fresh `new Database(path)`.
- Setting `busy_timeout = 5000` explicitly is therefore **behavior-preserving**;
  it only removes the dependency on the library default and makes the guard
  visible to readers/reviewers.
- `db.pragma('busy_timeout = 5000')` is a write-pragma (sets the value);
  `db.pragma('busy_timeout', { simple: true })` reads it back as a number.
- This is the follow-up to PR #79. The spec patterns section that documents the
  busy-handling layering lands on the PR #79 branch separately; this plan only
  flips that note from "implicit default" to "explicitly pinned".
- Run all commands from repo root. Test runner: `npx jest`.

---

## Task 1: Pin `busy_timeout` explicitly in `openDb`

**Files:**
- Create: `src/storage/db.test.ts`
- Modify: `src/storage/db.ts`

- [ ] **Step 1: Write the failing test**

Create `src/storage/db.test.ts`:

```typescript
import { openDb } from './db';

test('openDb pins a 5s busy_timeout (WAL + litestream contention guard)', () => {
  const db = openDb(':memory:');
  expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
});

test('openDb enables WAL journal mode', () => {
  const db = openDb(':memory:');
  // :memory: databases report "memory" journal_mode regardless of the WAL
  // request, so assert against a real temp file to verify WAL is applied.
  const path = `/tmp/wbb-db-test-${process.pid}-${Date.now()}.sqlite`;
  const fileDb = openDb(path);
  expect(fileDb.pragma('journal_mode', { simple: true })).toBe('wal');
  fileDb.close();
  require('fs').rmSync(path, { force: true });
  require('fs').rmSync(`${path}-wal`, { force: true });
  require('fs').rmSync(`${path}-shm`, { force: true });
});
```

- [ ] **Step 2: Run the test to verify the busy_timeout case fails**

Run: `npx jest src/storage/db.test.ts`
Expected: the WAL test PASSES, but the busy_timeout test currently PASSES TOO
(better-sqlite3's implicit default is already 5000). To prove the test actually
guards the pragma, temporarily change the assertion to `.toBe(1234)` and confirm
it FAILS, then restore it to `.toBe(5000)`.

Rationale: because the explicit pragma equals the implicit default, the test
cannot red→green on the production value alone. The temporary `1234` flip
verifies the test is wired to the real pragma before we rely on it.

- [ ] **Step 3: Implement**

In `src/storage/db.ts`, add the explicit pragma after the WAL line:

```typescript
export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // Pin the WAL/litestream contention guard explicitly rather than relying on
  // better-sqlite3's implicit 5s default — a future library bump could change
  // it to 0 and silently drop the baseline that protects every writer (startup
  // jobs, crons, ad-hoc writes). The long-running import path adds a second
  // layer via withBusyRetry.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/storage/db.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Run the full suite + type check (no regressions)**

Run: `npx jest && npx tsc --noEmit`
Expected: all tests PASS, no type errors. (The pragma is behavior-preserving, so
nothing else should change.)

- [ ] **Step 6: Commit**

```bash
git add src/storage/db.ts src/storage/db.test.ts
git commit -m "chore(db): pin busy_timeout=5000 explicitly in openDb"
```

---

## Task 2: Update the busy-handling spec note to "explicit"

**Files:**
- Modify: `spec.md` (the busy-handling layering note added on the PR #79 branch)

- [ ] **Step 1: Locate the note**

Run: `grep -n "busy_timeout\|withBusyRetry\|implicit" spec.md`
Expected: finds the busy-handling bullet(s) added for PR #79 describing the
layering (5s baseline + import second layer).

- [ ] **Step 2: Edit the wording**

Change the phrase describing the baseline source from better-sqlite3's *implicit*
default to an *explicit* pragma. Concretely, replace the clause that says the 5s
`busy_timeout` comes from better-sqlite3's default with:

```markdown
  Базовий рівень: `openDb` явно ставить `busy_timeout = 5000` (PRAGMA) —
  будь-який заблокований запис синхронно ретраїться до 5 с на рівні SQLite,
  покриваючи всіх писачів (startup-джоби, крони). Другий рівень — `withBusyRetry`
  лише для довгого `import`.
```

(Adjust to match the exact surrounding wording present in `spec.md`; the
substantive change is "implicit better-sqlite3 default" → "explicit
`busy_timeout = 5000` PRAGMA in `openDb`".)

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): busy_timeout baseline is now explicit in openDb"
```

---

## Self-review checklist (completed during planning)

- **Spec coverage:** Design (A) explicit pragma + test → Task 1. Design (C)
  doc flip to "explicit" → Task 2. Design (B) correctly has no task (rejected,
  YAGNI). All covered.
- **Placeholder scan:** No TBD/TODO; all code shown in full. The one "adjust to
  match surrounding wording" note in Task 2 is bounded by an explicit before→after
  substitution, not an open placeholder.
- **Type consistency:** `openDb(path: string): DB` signature unchanged;
  `pragma('busy_timeout', { simple: true })` read form used consistently in test
  and background notes.
- **Behavior-preserving caveat:** Task 1 Step 2 explicitly handles the fact that
  the explicit value equals the implicit default (temporary `1234` flip to prove
  the test guards the pragma), so the TDD red→green is meaningful.
