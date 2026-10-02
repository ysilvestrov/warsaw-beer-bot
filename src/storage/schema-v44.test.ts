import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';

// Migration v44 (spec 2026-10-02-wfp-mcp-venue-eye-design.md §3.4): rebuilds venue_checkins and
// fest_coverage so their eye CHECK admits 'mcp_venue', keeping every row and index.

const migrated = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};

const insertCheckin = (db: ReturnType<typeof openDb>, id: number, eye: string) =>
  db.prepare(`INSERT INTO venue_checkins (checkin_id, venue_id, bid, untappd_user, checkin_at, first_eye, observed_at)
              VALUES (?, 11142155, 6134008, 'probe_user', '2026-10-15T14:10:00.000Z', ?, '2026-10-15T14:11:00.000Z')`).run(id, eye);

const insertCoverage = (db: ReturnType<typeof openDb>, eye: string) =>
  db.prepare(`INSERT INTO fest_coverage (venue_id, from_at, to_at, eye, recorded_at)
              VALUES (11142155, '2026-10-15T14:00:00.000Z', '2026-10-15T14:10:00.000Z', ?, '2026-10-15T14:11:00.000Z')`).run(eye);

describe('migration v44', () => {
  it('records its version', () => {
    const db = migrated();
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 44').get()).toEqual({ version: 44 });
    db.close();
  });

  it('accepts the mcp_venue eye in both tables', () => {
    const db = migrated();
    insertCheckin(db, 1, 'mcp_venue');
    insertCoverage(db, 'mcp_venue');
    expect([
      db.prepare('SELECT first_eye FROM venue_checkins').get(),
      db.prepare('SELECT eye FROM fest_coverage').get(),
    ]).toEqual([{ first_eye: 'mcp_venue' }, { eye: 'mcp_venue' }]);
    db.close();
  });

  it('still refuses an eye nobody defined', () => {
    const db = migrated();
    expect(() => insertCheckin(db, 1, 'other')).toThrow(/CHECK constraint failed/);
    expect(() => insertCoverage(db, 'other')).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('keeps the rows already there when it runs over them', () => {
    const db = migrated();
    insertCheckin(db, 1605001196, 'laptop');
    insertCoverage(db, 'server');
    db.prepare('DELETE FROM schema_version WHERE version = 44').run();
    migrate(db);
    expect([
      db.prepare('SELECT * FROM venue_checkins').all(),
      db.prepare('SELECT * FROM fest_coverage').all(),
    ]).toEqual([
      [{
        checkin_id: 1605001196, venue_id: 11142155, bid: 6134008, untappd_user: 'probe_user',
        checkin_at: '2026-10-15T14:10:00.000Z', first_eye: 'laptop', observed_at: '2026-10-15T14:11:00.000Z',
      }],
      [{
        venue_id: 11142155, from_at: '2026-10-15T14:00:00.000Z', to_at: '2026-10-15T14:10:00.000Z',
        eye: 'server', recorded_at: '2026-10-15T14:11:00.000Z',
      }],
    ]);
    db.close();
  });

  it('leaves both venue_checkins indexes in place and no rebuild table behind', () => {
    const db = migrated();
    const names = (db.prepare(
      `SELECT name FROM sqlite_master WHERE name LIKE 'idx_venue_checkins_%' OR name LIKE '%_v44' ORDER BY name`,
    ).all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(['idx_venue_checkins_bid_at', 'idx_venue_checkins_venue_at']);
    db.close();
  });
});
