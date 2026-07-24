import type { DB } from './db';

// Atomically consume one unit of the day's Google CSE budget. Returns true if a
// unit was available (and was consumed), false if the day is already at `cap`.
// The single UPSERT is atomic: a brand-new day inserts count=1; an existing day
// increments only while count < cap (so the max stored count is exactly `cap`);
// at/over cap the WHERE clause fails and no row changes.
export function tryConsumeGoogleQuota(db: DB, day: string, cap: number): boolean {
  const info = db
    .prepare(
      `INSERT INTO google_quota (day, count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < ?`,
    )
    .run(day, cap);
  return info.changes > 0;
}
