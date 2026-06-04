# Snapshot Data Retention — Design

**Date:** 2026-06-04
**Status:** Approved (brainstorming)
**Slug:** snapshot-data-retention

## Problem

`tap_snapshots` and `taps` grow without bound. `refreshOntap` writes a fresh
snapshot for every pub every 12h regardless of whether anything changed
(`src/jobs/refresh-ontap.ts:67-68`), so at ~50 pubs × 2/day the tables accrue
~36k snapshots and several hundred thousand `taps` rows per year. The spec
never defined a cleanup policy. Over a year the DB balloons, slowing index
traversal / `MAX(snapshot_at)` group-bys and inflating Litestream backup cost.

Business logic only ever reads the **latest** snapshot per pub
(`latestSnapshot`, `latestSnapshotsPerPub` in `src/storage/snapshots.ts`).
History has no current feature consumer — its only value is debug/forensics.

## Decisions

- **Retention strategy = "solution 1": `DELETE` only, no `VACUUM`.**
  SQLite `DELETE` does not shrink the file; freed pages go on the free list and
  are reused by subsequent inserts. The file therefore *ramps up* during the
  first retention window, then **plateaus** at its high-water mark — it stops
  growing year-over-year (which solves the stated problem) but does not shrink.
  This is deliberately the Litestream-friendly choice: steady-state WAL churn is
  just "insert a day, delete a day", bounded and predictable. `VACUUM` would
  rewrite the whole DB and force a full Litestream re-snapshot each run — exactly
  what we want to avoid.

- **Retention window = `SNAPSHOT_RETENTION_DAYS`, default 14 days**, configurable
  via `.env`. Since the safety invariant below guarantees every pub always keeps
  its latest snapshot, the window is purely a debug/forensics buffer, not a
  feature dependency.

- **Safety invariant (non-negotiable): never delete a pub's most recent
  snapshot**, even if it is older than the cutoff. A pub that stops being scraped
  (ontap page breaks, pub delisted) must retain its last known taps, or it
  silently vanishes from `/newbeers`, `/route`, `/pubs`.

- **Schedule: once at startup + daily cron at 05:00 Warsaw (`0 5 * * *`).**
  Daily is ample for a single bounded `DELETE`; 05:00 is a quiet slot away from
  the busy on-the-hour scraper runs (00:00/12:00 ontap, 03:00 untappd). The
  startup run cleans the already-bloated prod DB immediately on first deploy
  instead of waiting up to 24h.

## Components

### 1. Storage — `src/storage/snapshots.ts`

New function:

```ts
export function deleteOldSnapshots(db: DB, cutoffIso: string): number
```

```sql
DELETE FROM tap_snapshots
WHERE snapshot_at < :cutoff
  AND id NOT IN (SELECT MAX(id) FROM tap_snapshots GROUP BY pub_id);
```

`MAX(id)` per pub identifies the newest-inserted snapshot per pub — `id`
(AUTOINCREMENT) and `snapshot_at` (`new Date().toISOString()` set at insert) are
co-monotonic, so this matches what `latestSnapshotsPerPub` considers "latest"
while guaranteeing exactly one keeper per pub (no tie ambiguity). Rows excluded
by the `NOT IN` keeper set are preserved even when older than the cutoff.
`taps` rows are removed by the existing `taps.snapshot_id ... ON DELETE CASCADE`
(`foreign_keys = ON`, `src/storage/db.ts:8`). Returns `info.changes`
(deleted snapshot count) for logging.

### 2. Job — `src/jobs/cleanup-old-snapshots.ts`

```ts
export function cleanupOldSnapshots(db: DB, log: Logger, retentionDays: number): void
```

Computes `cutoff = (now − retentionDays days).toISOString()`, calls
`deleteOldSnapshots`, logs `{ deleted, retentionDays }`. Positional `(db, log,
…)` signature, matching the other startup jobs (`dedupeBreweryAliases`,
`cleanupPollutedOntap`). Synchronous (single SQL statement); the function itself
does not swallow errors — the cron wrapper guards it with `try/catch` (not
`.catch`, since there is no promise), matching how a sync job is invoked.

### 3. Config — `src/config/env.ts` + `.env.example`

Add `SNAPSHOT_RETENTION_DAYS`, parsed as a positive integer, default `14`.
Add a documented line to `.env.example`.

### 4. Wiring — `src/index.ts`

- Boot: call `cleanupOldSnapshots(db, log, env.SNAPSHOT_RETENTION_DAYS)` next to
  the existing `dedupeBreweryAliases(db, log)` / `cleanupPollutedOntap(db, log)`
  calls.
- Cron: push `cron.schedule('0 5 * * *', () => { try { cleanupOldSnapshots(...) }
  catch (e) { log.error({ err: e }, 'cleanup-old-snapshots cron') } })` into
  `cronJobs` so it is torn down by the existing `createShutdown`.

## Testing (Jest, per CLAUDE.md)

`src/jobs/cleanup-old-snapshots.test.ts` (and/or a storage-level test) seeding an
in-memory DB through `migrate`:

1. Old + non-latest snapshot → **deleted**.
2. Old **but** latest-for-its-pub → **preserved** (the safety invariant).
3. Recent (within window) → **preserved**.
4. `taps` belonging to a deleted snapshot are gone (CASCADE verified).
5. Return value equals the number of snapshots deleted.

## Spec update (same PR)

`spec.md` is the single source of truth (OpenSpec), so this PR also:

- Adds `cleanupOldSnapshots` to the §4 "Фонові джоби" table
  (`0 5 * * *`, purpose) **and** to the startup-jobs list.
- Adds a one-line retention-policy note under §3.3 `tap_snapshots` / §3.4 `taps`
  (delete > `SNAPSHOT_RETENTION_DAYS`, always keep latest per pub).

No schema migration — no DDL change — so §3.13 migration history is untouched.

## Out of scope (YAGNI)

- `VACUUM` / `auto_vacuum` / physical file shrink.
- Retention for any table other than `tap_snapshots`/`taps`.
- Analytics/archival of historical snapshots before deletion.
