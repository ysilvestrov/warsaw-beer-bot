import { openDb } from './db';
import { migrate } from './schema';
import type { DB } from './db';
import { ensureProfile } from './user_profiles';
import { getSyncState, advanceSyncState } from './checkin_sync_state';

function freshDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('checkin_sync_state', () => {
  it('returns a default state when no row exists', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: null, complete: false, profile_total: null });
  });

  it('advances the deepest cursor and persists completeness', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '500', false);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '500', complete: false, profile_total: null });
    advanceSyncState(db, 1, '300', false);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '300', complete: false, profile_total: null });
  });

  it('keeps the lowest (deepest) cursor when a higher one arrives later', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '300', false);
    advanceSyncState(db, 1, '900', false); // a Phase-1 top-up page; must not rewind the deep cursor
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '300', complete: false, profile_total: null });
  });

  it('latches complete=true once set', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '100', true);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '100', complete: true, profile_total: null });
    advanceSyncState(db, 1, '50', false);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '50', complete: true, profile_total: null });
  });

  it('handles a null maxId without rewinding an existing cursor', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '300', false);
    advanceSyncState(db, 1, null, false);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '300', complete: false, profile_total: null });
  });

  it('stores profile_total and keeps the latest non-null value', () => {
    const db = freshDb();
    ensureProfile(db, 1);

    // first sync sees a total
    advanceSyncState(db, 1, '500', false, 11287);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '500', complete: false, profile_total: 11287 });

    // a later page parses null → previous total is preserved
    advanceSyncState(db, 1, '400', false, null);
    expect(getSyncState(db, 1).profile_total).toBe(11287);

    // a later page with a fresh total overwrites (latest non-null wins)
    advanceSyncState(db, 1, '300', false, 11290);
    expect(getSyncState(db, 1).profile_total).toBe(11290);
  });

  it('defaults profile_total to null when omitted', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '500', false);
    expect(getSyncState(db, 1).profile_total).toBeNull();
  });
});
