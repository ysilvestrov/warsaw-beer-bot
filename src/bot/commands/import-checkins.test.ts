import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { countCheckins } from '../../storage/checkins';
import { coverageFor } from '../../storage/checkin_coverage';
import { getHistoryOwner } from '../../storage/history-owner';
import { importCheckins, ImportAccountChangedError } from './import-checkins';
import type { Checkin } from '../../sources/untappd/export';
import { getBeer } from '../../storage/beers';
import { seedBeer } from '../../storage/seed-beer.testing';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';

function row(over: Partial<Checkin>): Checkin {
  return {
    checkin_id: '100',
    beer_name: 'Some IPA',
    brewery_name: 'Some Brewery',
    beer_type: null,
    beer_abv: null,
    global_rating: null,
    rating_score: null,
    created_at: '2026-01-01 00:00:00',
    venue_name: null,
    bid: 42,
    ...over,
  };
}

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
});

describe('importCheckins', () => {
  it('merges the rows', () => {
    importCheckins(db, 1, [row({ checkin_id: '100' }), row({ checkin_id: '900' })]);
    expect(countCheckins(db, 1)).toBe(2);
  });

  // #587 (рев'ю PR #592): імпорт НЕ заявляє покриття. Довести повноту, актуальність і
  // унікальність вивантаженого файлу з самого файлу неможливо — три рев'ю знайшли три
  // різні обходи будь-якого гейта, збудованого на цьому засновку. Покриття доводить
  // перший живий обхід, він же знаходить те, що застарілий рядок замаскував би.
  it('claims no coverage at all', () => {
    importCheckins(db, 1, [row({ checkin_id: '100' }), row({ checkin_id: '900' })]);
    expect(coverageFor(db, 1)).toEqual([]);
  });

  // #617: рядок експорту без bid не має ідентичності — він сирота й злінкованого пива не торкається.
  it('a row without bid becomes an orphan and leaves a linked beer of the same name alone', () => {
    const linked = seedBeer(db, {
      untappd_id: 7, name: 'Some IPA', brewery: 'Some Brewery',
      style: 'IPA', abv: 6, rating_global: 3.9,
      normalized_name: normalizeName('Some IPA'), normalized_brewery: normalizeBrewery('Some Brewery'),
      untappd_id_source: 'search',
    });
    importCheckins(db, 1, [row({ checkin_id: '100', bid: null })]);
    const l = getBeer(db, linked)!;
    expect(l.untappd_id).toBe(7);
    expect(l.rating_global).toBeCloseTo(3.9);
    expect(l.untappd_id_source).toBe('search');
    const ck = db.prepare("SELECT beer_id FROM checkins WHERE checkin_id = '100'").get() as { beer_id: number };
    expect(ck.beer_id).not.toBe(linked);
    expect(getBeer(db, ck.beer_id)!.untappd_id).toBeNull();
    // рев'ю гілки: без цього рядок без bid, пущений у upsertBeerByBid, дав би сироту з source 'checkin'
    expect(getBeer(db, ck.beer_id)!.untappd_id_source).toBeNull();
  });

  it('import fills empty facts of a beer found by bid but never overwrites stored ones', () => {
    const id = seedBeer(db, {
      untappd_id: 42, name: 'Some IPA', brewery: 'Some Brewery',
      style: 'IPA', abv: null, rating_global: 3.9,
      normalized_name: normalizeName('Some IPA'), normalized_brewery: normalizeBrewery('Some Brewery'),
      untappd_id_source: 'search',
    });
    importCheckins(db, 1, [row({ checkin_id: '100', bid: 42, beer_abv: 6.5, global_rating: 4.2, beer_type: 'Hazy IPA' })]);
    const r = getBeer(db, id)!;
    expect(r.abv).toBeCloseTo(6.5);
    expect(r.rating_global).toBeCloseTo(3.9);
    expect(r.style).toBe('IPA');
  });
});


describe('#611 captured import owner', () => {
  it.each([['b'], ['b', 'a']])('rejects a captured A batch after %s before catalog writes', (...switches) => {
    setUntappdUsername(db, 1, 'a');
    const owner = getHistoryOwner(db, 1);
    for (const username of switches) setUntappdUsername(db, 1, username);
    expect(() => importCheckins(db, 1, [row({})], owner)).toThrow(ImportAccountChangedError);
    expect(db.prepare('SELECT * FROM beers').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM checkins').all()).toEqual([]);
  });

  it('first linking invalidates a pending unlinked batch', () => {
    const owner = getHistoryOwner(db, 1);
    importCheckins(db, 1, [row({ checkin_id: '100' })], owner);
    setUntappdUsername(db, 1, 'a');
    expect(() => importCheckins(db, 1, [row({ checkin_id: '101' })], owner)).toThrow(ImportAccountChangedError);
    expect(db.prepare('SELECT account_key, checkin_id FROM checkins').all()).toEqual([{ account_key: 'a', checkin_id: '100' }]);
  });

  it('another user switching does not invalidate the captured account', () => {
    setUntappdUsername(db, 1, 'a');
    const owner = getHistoryOwner(db, 1);
    ensureProfile(db, 2); setUntappdUsername(db, 2, 'b');
    importCheckins(db, 1, [row({ rating_score: 0 })], owner);
    expect(db.prepare('SELECT telegram_id, account_key, user_rating FROM checkins').all())
      .toEqual([{ telegram_id: 1, account_key: 'a', user_rating: 0 }]);
  });
});
