import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { countCheckins } from '../../storage/checkins';
import { coverageFor } from '../../storage/checkin_coverage';
import { importCheckins } from './import-checkins';
import type { Checkin } from '../../sources/untappd/export';

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

  // #587: експорт Untappd — повна історія до своєї дати, тобто рівно доведений діапазон.
  // Саме цього свідчення бракувало: дані імпорт давав, покриття — ні, і синхронізація
  // потім змушена була вгадувати, що вже покрито.
  it('seeds the coverage range the export proves', () => {
    importCheckins(db, 1, [row({ checkin_id: '100' }), row({ checkin_id: '900' })]);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 900 }]);
  });

  it('extends coverage across batches', () => {
    importCheckins(db, 1, [row({ checkin_id: '500' })]);
    importCheckins(db, 1, [row({ checkin_id: '100' })]);
    // Дві партії одного експорту; між 100 і 500 експорт теж усе віддав, тож діапазон один.
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 500 }]);
  });

  it('ignores a non-numeric checkin id when computing the range', () => {
    importCheckins(db, 1, [row({ checkin_id: 'abc' }), row({ checkin_id: '300' })]);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 300, to_id: 300 }]);
  });

  it('writes no coverage for an empty batch', () => {
    importCheckins(db, 1, []);
    expect(coverageFor(db, 1)).toEqual([]);
  });
});
