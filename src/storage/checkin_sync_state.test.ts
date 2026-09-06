import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from './db';
import { migrate } from './schema';
import { ensureProfile } from './user_profiles';
import { addCoverage } from './checkin_coverage';
import { getSyncState, recordProfileTotal } from './checkin_sync_state';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
});

describe('getSyncState', () => {
  it('returns an empty state for a user with no rows', () => {
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: null, complete: false, profile_total: null });
  });

  // #587: курсор більше не зберігається — він ПОХІДНИЙ від покриття, тож збрехати не може.
  it('derives deepest_max_id from the coverage floor', () => {
    addCoverage(db, 1, 500, 600);
    addCoverage(db, 1, 100, 200);
    expect(getSyncState(db, 1).deepest_max_id).toBe('100');
  });

  it('keeps profile_total when a later page parses none', () => {
    recordProfileTotal(db, 1, 11287);
    expect(getSyncState(db, 1).profile_total).toBe(11287);
    recordProfileTotal(db, 1, null);
    expect(getSyncState(db, 1).profile_total).toBe(11287);
    recordProfileTotal(db, 1, 11290);
    expect(getSyncState(db, 1).profile_total).toBe(11290);
  });

  it('never writes complete', () => {
    recordProfileTotal(db, 1, 10);
    addCoverage(db, 1, 100, 200);
    expect(getSyncState(db, 1).complete).toBe(false);
  });
});
