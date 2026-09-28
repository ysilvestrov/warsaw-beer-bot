import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as historyOwner from './history-owner';
import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile, setUntappdUsername } from './user_profiles';
import { seedBeer } from './seed-beer.testing';
import { mergeCheckin, countCheckins, oldestCheckinId, latestRatingsByBeer, countDistinctBeers, latestCheckinAt, hasBeenDrunk } from './checkins';
import { markHad, triedBeerIds, countHadWithoutCheckins } from './untappd_had';
import { addCoverage, coverageFor, rangeContaining } from './checkin_coverage';
import { recordProfileTotal, getSyncState } from './checkin_sync_state';

test('account ownership isolates counts, ratings, drunk status and coverage within the same Telegram user', () => {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  ensureProfile(db, 2);
  db.prepare('UPDATE user_profiles SET untappd_username = ? WHERE telegram_id = 1').run('A');
  const a = seedBeer(db, { name: 'A', brewery: 'Pinta', normalized_name: 'a', normalized_brewery: 'pinta' });
  const b = seedBeer(db, { name: 'B', brewery: 'Pinta', normalized_name: 'b', normalized_brewery: 'pinta' });
  mergeCheckin(db, { telegram_id: 1, account_key: 'a', checkin_id: '123', beer_id: a,
    user_rating: 4, checkin_at: '2026-09-01T00:00:00Z', venue: null });
  mergeCheckin(db, { telegram_id: 1, account_key: 'b', checkin_id: '123', beer_id: b,
    user_rating: 0, checkin_at: '2026-09-02T00:00:00Z', venue: null });
  mergeCheckin(db, { telegram_id: 2, account_key: 'a', checkin_id: '123', beer_id: b,
    user_rating: 2, checkin_at: '2026-09-03T00:00:00Z', venue: null });
  markHad(db, 1, b, '2026-09-03T00:00:00Z', 3, 'a');
  markHad(db, 1, a, '2026-09-03T00:00:00Z', 1, 'b');
  addCoverage(db, 1, 100, 200, 'a');
  addCoverage(db, 1, 500, 600, 'b');
  recordProfileTotal(db, 1, 100, 'a');
  recordProfileTotal(db, 1, 30, 'b');
  expect(db.prepare('SELECT telegram_id, account_key, checkin_id FROM checkins ORDER BY telegram_id, account_key').all())
    .toEqual([{ telegram_id: 1, account_key: 'a', checkin_id: '123' },
      { telegram_id: 1, account_key: 'b', checkin_id: '123' },
      { telegram_id: 2, account_key: 'a', checkin_id: '123' }]);
  expect(countCheckins(db, 1)).toBe(1);
  expect(oldestCheckinId(db, 1)).toBe(123);
  expect(countDistinctBeers(db, 1)).toBe(1);
  expect(latestCheckinAt(db, 1)).toBe('2026-09-01 00:00:00');
  expect(hasBeenDrunk(db, 1, b)).toBe(false);
  expect([...latestRatingsByBeer(db, 1)]).toEqual([[a, 4], [b, 3]]);
  expect([...triedBeerIds(db, 1)]).toEqual([a, b]);
  expect(countHadWithoutCheckins(db, 1)).toBe(1);
  expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 200 }]);
  expect(rangeContaining(db, 1, 550)).toBe(null);
  expect(getSyncState(db, 1)).toMatchObject({ deepest_max_id: '100', profile_total: 100 });
  db.prepare('UPDATE user_profiles SET untappd_username = ? WHERE telegram_id = 1').run('B');
  expect([...latestRatingsByBeer(db, 1)]).toEqual([[b, 0], [a, 1]]);
  expect(coverageFor(db, 1)).toEqual([{ from_id: 500, to_id: 600 }]);
  expect(getSyncState(db, 1)).toMatchObject({ deepest_max_id: '500', profile_total: 30 });
  expect(countHadWithoutCheckins(db, 1)).toBe(1);
  expect(countCheckins(db, 1, '')).toBe(0);
  db.close();
});

test('records the account-history migration', () => {
  const db = openDb(':memory:');
  migrate(db);
  expect(db.prepare('SELECT version FROM schema_version WHERE version = 41').get()).toEqual({ version: 41 });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  db.close();
});

test.each(['ratings', 'tried', 'sync'] as const)('%s uses one SQLite snapshot when another connection switches accounts', (kind) => {
  const dir = mkdtempSync(join(tmpdir(), 'history-snapshot-'));
  const db = openDb(join(dir, 'bot.db'));
  migrate(db);
  const other = openDb(join(dir, 'bot.db'));
  ensureProfile(db, 1);
  setUntappdUsername(db, 1, 'a');
  const a = seedBeer(db, { name: 'A', brewery: 'Pinta', normalized_name: 'a', normalized_brewery: 'pinta' });
  const b = seedBeer(db, { name: 'B', brewery: 'Pinta', normalized_name: 'b', normalized_brewery: 'pinta' });
  mergeCheckin(db, { telegram_id: 1, account_key: 'a', checkin_id: '123', beer_id: a,
    user_rating: 4, checkin_at: '2026-09-01T00:00:00Z', venue: null });
  markHad(db, 1, b, '2026-09-01T00:00:00Z', 3, 'a');
  markHad(db, 1, a, '2026-09-01T00:00:00Z', 1, 'b');
  addCoverage(db, 1, 100, 200, 'a');
  addCoverage(db, 1, 500, 600, 'b');
  recordProfileTotal(db, 1, 100, 'a');
  recordProfileTotal(db, 1, 30, 'b');
  const original = historyOwner.getHistoryOwner;
  const spy = vi.spyOn(historyOwner, 'getHistoryOwner').mockImplementationOnce((connection, id) => {
    const owner = original(connection, id);
    setUntappdUsername(other, 1, 'b');
    return owner;
  });
  try {
    const reads = {
      ratings: () => [...latestRatingsByBeer(db, 1)],
      tried: () => [...triedBeerIds(db, 1)],
      sync: () => { const s = getSyncState(db, 1); return [s.profile_total, s.deepest_max_id]; },
    };
    const expected = { ratings: [[a, 4], [b, 3]], tried: [a, b], sync: [100, '100'] };
    expect(reads[kind]()).toEqual(expected[kind]);
    expect(original(other, 1).accountKey).toBe('b');
  } finally {
    spy.mockRestore();
    other.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
