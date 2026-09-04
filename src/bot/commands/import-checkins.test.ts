import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { countCheckins } from '../../storage/checkins';
import { addCoverage, coverageFor } from '../../storage/checkin_coverage';
import { recordProfileTotal } from '../../storage/checkin_sync_state';
import { importCheckins, sealImportCoverage } from './import-checkins';
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

  it('extends bounds across batches', () => {
    const first = importCheckins(db, 1, [row({ checkin_id: '500' })]);
    const second = importCheckins(db, 1, [row({ checkin_id: '100' })], first);
    expect(second).toEqual({ minId: 100, maxId: 500 });
  });

  it('ignores a non-numeric checkin id when computing the bounds', () => {
    const bounds = importCheckins(db, 1, [row({ checkin_id: 'abc' }), row({ checkin_id: '300' })]);
    expect(bounds).toEqual({ minId: 300, maxId: 300 });
  });

  it('returns the previous bounds for an empty batch', () => {
    const prev = { minId: 10, maxId: 20 };
    expect(importCheckins(db, 1, [], prev)).toEqual(prev);
  });

  // #587: `importCheckins` сам по собі більше не пише покриття — див. `sealImportCoverage`.
  it('writes no coverage on its own, even for a fully corroborated import', () => {
    recordProfileTotal(db, 1, 2);
    importCheckins(db, 1, [row({ checkin_id: '100' }), row({ checkin_id: '900' })]);
    expect(coverageFor(db, 1)).toEqual([]);
  });
});

describe('sealImportCoverage', () => {
  // #587: експорт Untappd — повна історія до своєї дати, тобто рівно доведений діапазон,
  // АЛЕ лише коли зовнішній лічильник профілю це підтверджує.
  it('seeds the coverage range the export proves, when the profile total corroborates it', () => {
    recordProfileTotal(db, 1, 2);
    const bounds = importCheckins(db, 1, [row({ checkin_id: '100' }), row({ checkin_id: '900' })]);
    const wrote = sealImportCoverage(db, 1, bounds);
    expect(wrote).toBe(true);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 900 }]);
  });

  // #587: це і є весь сенс правки. Обірвана на пів-дороги вигрузка парситься чисто й просто
  // дає менше рядків, ніж профіль каже, що їх є насправді — і в такому разі заявляти
  // покриття не можна, бо саме так [100,900] з дірою на 450 зробили б недосяжною назавжди.
  it('writes no coverage when the row count falls short of the profile total', () => {
    recordProfileTotal(db, 1, 3); // файл нібито мав дати 3, дав лише 2
    const bounds = importCheckins(db, 1, [row({ checkin_id: '100' }), row({ checkin_id: '900' })]);
    const wrote = sealImportCoverage(db, 1, bounds);
    expect(wrote).toBe(false);
    expect(coverageFor(db, 1)).toEqual([]);
  });

  it('writes no coverage when the profile total is unknown', () => {
    const bounds = importCheckins(db, 1, [row({ checkin_id: '100' }), row({ checkin_id: '900' })]);
    const wrote = sealImportCoverage(db, 1, bounds);
    expect(wrote).toBe(false);
    expect(coverageFor(db, 1)).toEqual([]);
  });

  it('writes no coverage for a null bounds (empty import)', () => {
    recordProfileTotal(db, 1, 0);
    expect(sealImportCoverage(db, 1, null)).toBe(false);
    expect(coverageFor(db, 1)).toEqual([]);
  });

  // #587: імпорт заявляє лише те, що є в самому файлі. Чужий діапазон, до якого він не
  // дотягнувся, лишається чужим — інакше стара вигрузка запечатала б діру, яку знайшла
  // жива синхронізація, і ми відтворили б рівно той дефект, проти якого ця гілка.
  it('does not swallow a coverage hole the import never spanned', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 900, 1000);
    recordProfileTotal(db, 1, 1);
    const bounds = importCheckins(db, 1, [row({ checkin_id: '150' })]);
    sealImportCoverage(db, 1, bounds);
    expect(coverageFor(db, 1)).toEqual([
      { from_id: 900, to_id: 1000 },
      { from_id: 100, to_id: 200 },
    ]);
  });
});
