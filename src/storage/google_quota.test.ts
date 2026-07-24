import { describe, it, expect } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { tryConsumeGoogleQuota } from './google_quota';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('tryConsumeGoogleQuota', () => {
  it('allows exactly `cap` calls per day, then blocks', () => {
    const db = freshDb();
    const day = '2026-07-24';
    let ok = 0;
    for (let i = 0; i < 5; i++) if (tryConsumeGoogleQuota(db, day, 3)) ok++;
    expect(ok).toBe(3);
    expect((db.prepare('SELECT count FROM google_quota WHERE day = ?').get(day) as { count: number }).count).toBe(3);
    db.close();
  });

  it('tracks each day independently', () => {
    const db = freshDb();
    expect(tryConsumeGoogleQuota(db, '2026-07-24', 1)).toBe(true);
    expect(tryConsumeGoogleQuota(db, '2026-07-24', 1)).toBe(false);
    expect(tryConsumeGoogleQuota(db, '2026-07-25', 1)).toBe(true);
    db.close();
  });
});
