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
