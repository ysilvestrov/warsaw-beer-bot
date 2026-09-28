import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile, getProfile, setUntappdUsername } from './user_profiles';
import { getHistoryOwner, isCurrentHistoryOwner } from './history-owner';
import { seedBeer } from './seed-beer.testing';
import { markHad, triedBeerIds } from './untappd_had';
import { mergeCheckin, countCheckins, latestRatingsByBeer } from './checkins';
import { addCoverage, coverageFor } from './checkin_coverage';
import { getSyncState, recordProfileTotal } from './checkin_sync_state';

function setup(path = ':memory:') {
  const db = openDb(path);
  migrate(db);
  ensureProfile(db, 1);
  const beer = seedBeer(db, { name: 'Atak', brewery: 'Pinta', normalized_name: 'atak', normalized_brewery: 'pinta' });
  return { db, beer };
}

test('A to B to A restores ratings, counts and coverage without accepting the first A binding', () => {
  const { db, beer } = setup();
  ensureProfile(db, 2);
  setUntappdUsername(db, 1, 'old');
  setUntappdUsername(db, 2, 'old');
  const captured = getHistoryOwner(db, 1);
  markHad(db, 1, beer, '2026-09-28T03:00:00Z', 0);
  markHad(db, 2, beer, '2026-09-28T03:00:00Z', 3);
  mergeCheckin(db, { telegram_id: 1, beer_id: beer, checkin_id: '123',
    user_rating: 4, checkin_at: '2026-09-01T03:00:00Z', venue: null });
  addCoverage(db, 1, 1000, 1099);
  recordProfileTotal(db, 1, 100);
  setUntappdUsername(db, 1, 'OLD');
  expect(getHistoryOwner(db, 1)).toEqual({ telegramId: 1, accountKey: 'old', linkRevision: 1 });
  expect(isCurrentHistoryOwner(db, captured)).toBe(true);
  setUntappdUsername(db, 1, 'new');
  expect(countCheckins(db, 1)).toBe(0);
  expect([...triedBeerIds(db, 1)]).toEqual([]);
  expect([...latestRatingsByBeer(db, 1)]).toEqual([]);
  expect(coverageFor(db, 1)).toEqual([]);
  expect(getSyncState(db, 1)).toEqual({ deepest_max_id: null, complete: false, profile_total: null, updated_at: null });
  markHad(db, 1, beer, '2026-09-28T04:00:00Z', 2);
  setUntappdUsername(db, 1, 'old');
  expect(countCheckins(db, 1)).toBe(1);
  expect([...latestRatingsByBeer(db, 1)]).toEqual([[beer, 4]]);
  expect(coverageFor(db, 1)).toEqual([{ from_id: 1000, to_id: 1099 }]);
  expect(getSyncState(db, 1)).toMatchObject({ deepest_max_id: '1000', profile_total: 100 });
  expect(isCurrentHistoryOwner(db, captured)).toBe(false);
  expect(getProfile(db, 1)).toMatchObject({ untappd_link_revision: 3, legacy_sync_revision: 1 });
  expect(db.prepare('SELECT telegram_id, account_key, user_rating FROM untappd_had ORDER BY telegram_id, account_key').all())
    .toEqual([{ telegram_id: 1, account_key: 'new', user_rating: 2 },
      { telegram_id: 1, account_key: 'old', user_rating: 0 }, { telegram_id: 2, account_key: 'old', user_rating: 3 }]);
  db.close();
});

test('first link adopts unbound imports once without claiming their coverage', () => {
  const { db, beer } = setup();
  mergeCheckin(db, { telegram_id: 1, beer_id: beer, checkin_id: '123', user_rating: 0,
    checkin_at: '2026-09-01T00:00:00Z', venue: 'Pub' });
  markHad(db, 1, beer, '2026-09-01T00:00:00Z', 0);
  addCoverage(db, 1, 100, 200);
  recordProfileTotal(db, 1, 100);
  setUntappdUsername(db, 1, 'New');
  expect(countCheckins(db, 1)).toBe(1);
  expect(db.prepare('SELECT id, account_key, user_rating FROM checkins').all())
    .toEqual([{ id: 1, account_key: 'new', user_rating: 0 }]);
  expect([...latestRatingsByBeer(db, 1)]).toEqual([[beer, 0]]);
  expect(coverageFor(db, 1)).toEqual([]);
  expect(getSyncState(db, 1)).toMatchObject({ profile_total: null, deepest_max_id: null });
  expect(coverageFor(db, 1, '')).toEqual([{ from_id: 100, to_id: 200 }]);
  expect(getProfile(db, 1)).toMatchObject({ untappd_link_revision: 1, legacy_sync_revision: 1 });
  setUntappdUsername(db, 1, 'Other');
  expect(countCheckins(db, 1)).toBe(0);
  expect(countCheckins(db, 1, 'new')).toBe(1);
  db.close();
});

test('first-link collisions keep named check-in facts and choose the later scraped observation', () => {
  const { db, beer } = setup();
  mergeCheckin(db, { telegram_id: 1, account_key: 'new', beer_id: beer, checkin_id: '123',
    user_rating: 0, checkin_at: '2026-09-02T00:00:00Z', venue: null });
  mergeCheckin(db, { telegram_id: 1, beer_id: null, checkin_id: '123', user_rating: 4,
    checkin_at: '2026-09-01T00:00:00Z', venue: 'Pub' });
  markHad(db, 1, beer, '2026-09-01T00:00:00Z', 4, 'new');
  markHad(db, 1, beer, '2026-09-02T00:00:00Z', 0, '');
  setUntappdUsername(db, 1, 'new');
  expect(db.prepare('SELECT id, account_key, beer_id, user_rating, checkin_at, venue FROM checkins').all())
    .toEqual([{ id: 1, account_key: 'new', beer_id: beer, user_rating: 0,
      checkin_at: '2026-09-02 00:00:00', venue: 'Pub' }]);
  expect(db.prepare('SELECT account_key, last_seen_at, user_rating FROM untappd_had').all())
    .toEqual([{ account_key: 'new', last_seen_at: '2026-09-02T00:00:00Z', user_rating: 0 }]);
  db.close();
});

test('failed first-link adoption rolls back profile and unbound observations', () => {
  const { db, beer } = setup();
  markHad(db, 1, beer, '2026-09-01T00:00:00Z', 4);
  db.exec(`CREATE TEMP TRIGGER fail_adoption BEFORE INSERT ON untappd_had
    WHEN NEW.account_key = 'new' BEGIN SELECT RAISE(ABORT, 'adoption blocked'); END;`);
  expect(() => setUntappdUsername(db, 1, 'new')).toThrow('adoption blocked');
  expect(getProfile(db, 1)).toMatchObject({ untappd_username: null, untappd_link_revision: 0, legacy_sync_revision: null });
  expect(db.prepare('SELECT account_key, user_rating FROM untappd_had').all()).toEqual([{ account_key: '', user_rating: 4 }]);
  db.close();
});

test('a second connection sees the atomic switch and invalidates the old owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'account-history-'));
  const { db } = setup(join(dir, 'bot.db'));
  const other = openDb(join(dir, 'bot.db'));
  try {
    setUntappdUsername(db, 1, 'a');
    const captured = getHistoryOwner(other, 1);
    setUntappdUsername(db, 1, 'b');
    expect(getHistoryOwner(other, 1)).toEqual({ telegramId: 1, accountKey: 'b', linkRevision: 2 });
    expect(isCurrentHistoryOwner(other, captured)).toBe(false);
  } finally {
    other.close(); db.close(); rmSync(dir, { recursive: true });
  }
});
