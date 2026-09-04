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

  // #587 (рев'ю PR #592): імпорт НЕ заявляє покриття. Довести повноту, актуальність і
  // унікальність вивантаженого файлу з самого файлу неможливо — три рев'ю знайшли три
  // різні обходи будь-якого гейта, збудованого на цьому засновку. Покриття доводить
  // перший живий обхід, він же знаходить те, що застарілий рядок замаскував би.
  it('claims no coverage at all', () => {
    importCheckins(db, 1, [row({ checkin_id: '100' }), row({ checkin_id: '900' })]);
    expect(coverageFor(db, 1)).toEqual([]);
  });
});
