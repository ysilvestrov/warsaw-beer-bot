# Explicit SQLite `busy_timeout` — design

**Date:** 2026-06-06
**Status:** Approved (brainstorming)
**Origin:** Follow-up from PR #79 review (ChatGPT reviewer flagged a missing `SQLITE_BUSY` guard on the startup backfill).

## Problem / premise correction

The PR #79 reviewer raised a P1: the startup `backfill-normalized-brewery` job
should wrap its `UPDATE` in `withBusyRetry` to survive litestream checkpoint
contention. Investigation showed the premise is largely already satisfied:

- `openDb` does `new Database(path)` with no options. **better-sqlite3 v12.9.0
  defaults `timeout` to 5000ms and applies it as a connection-level
  `busy_timeout`** (verified: `pragma busy_timeout` returns `5000`). So every
  connection already blocks-and-retries on a locked write for 5s, synchronously
  at the C layer, before throwing `SQLITE_BUSY`.
- This baseline covers **every** writer uniformly — startup jobs, cron jobs, and
  ad-hoc writes. The startup backfill is a short, single transaction running once
  at boot *before* crons and the bot start — the lowest-contention moment — so it
  sits comfortably inside the 5s window. No app-level retry is warranted.
- `import.ts` has app-level `withBusyRetry` (the #67 fix) because it is a long,
  multi-batch operation running *while the bot is live*; under sustained
  checkpointing a statement can repeatedly exhaust the 5s window. That is a
  deliberate, targeted second layer — not the baseline.

Prod-log evidence (decides whether other live writers need the second layer):
`journalctl -u warsaw-beer-bot` over its full history contains **exactly one**
`SQLITE_BUSY`/"database is locked" entry, and it originates in the `import` path
(`import.js` → `upsertBeer`). **Zero** busy errors from any cron or startup job.
So extending app-level retry to cron writers is YAGNI.

## Two real weaknesses remain

1. The 5s protection is **implicit** — it depends on better-sqlite3's default. A
   future library bump could change the default to `0` (no timeout) and silently
   remove the baseline guard across the whole app.
2. The guard is **invisible** — nothing in the source states the intent, so
   reviewers (human or AI) reasonably keep flagging missing busy handling.

## Decision

- **(A)** Set `busy_timeout` explicitly in `openDb`.
- **(C)** Document the busy-handling layering so the convention is discoverable.
- **(B, rejected)** Do not wrap cron/startup writes in `withBusyRetry` — the 5s
  baseline covers them and prod logs show no busy errors there.

## Design (A)

`src/storage/db.ts`, in `openDb`, after `journal_mode = WAL`:

```typescript
db.pragma('busy_timeout = 5000');
```

- Value `5000` equals better-sqlite3's current implicit default, so **runtime
  behavior is unchanged** — this only pins intent against a future default change
  and makes the guard visible.
- No write-site wrapping, no async conversion of the synchronous jobs, no cron
  changes.

### Testing

New `src/storage/db.test.ts`:

```typescript
import { openDb } from './db';

test('openDb pins a 5s busy_timeout (WAL + litestream contention guard)', () => {
  const db = openDb(':memory:');
  expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
});
```

Guards the pragma against accidental removal and documents the value.

## Documentation (C)

- **PR #79 (now), in `spec.md` review-conventions/patterns section:** document the
  layering — (1) the connection-level 5s `busy_timeout` is the uniform baseline
  covering all writers including startup/cron one-shots; (2) `withBusyRetry` is a
  deliberate second layer for the long-running `import` path only; (3) startup and
  cron one-shots intentionally rely on the baseline (justifies "backfill needs no
  busy-retry"). At this point the note says the baseline comes from
  better-sqlite3's *implicit* default.
- **Follow-up (when A lands):** update that note from "implicit default" to
  "explicitly pinned in `openDb` (`busy_timeout = 5000`)."

## Out of scope

- Wrapping cron/startup writes in `withBusyRetry` (B) — YAGNI per prod logs.
- Changing the `import` retry behavior.
- Raising the timeout above 5s (no evidence the current window is insufficient
  outside the already-handled import path).
