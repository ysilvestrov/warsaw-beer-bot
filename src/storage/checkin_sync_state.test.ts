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
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: null, complete: false });
  });

  it('advances the deepest cursor and persists completeness', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '500', false);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '500', complete: false });
    advanceSyncState(db, 1, '300', false);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '300', complete: false });
  });

  it('keeps the lowest (deepest) cursor when a higher one arrives later', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '300', false);
    advanceSyncState(db, 1, '900', false); // a Phase-1 top-up page; must not rewind the deep cursor
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '300', complete: false });
  });

  it('latches complete=true once set', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '100', true);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '100', complete: true });
    advanceSyncState(db, 1, '50', false);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '50', complete: true });
  });

  it('handles a null maxId without rewinding an existing cursor', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '300', false);
    advanceSyncState(db, 1, null, false);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '300', complete: false });
  });
});
