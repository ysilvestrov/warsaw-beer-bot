import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from './db';
import { migrate } from './schema';
import { ensureProfile } from './user_profiles';
import { addCoverage, coverageFor, rangeContaining, deepestCoveredId } from './checkin_coverage';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
});

describe('addCoverage', () => {
  it('keeps disjoint ranges apart', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 500, 600);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 500, to_id: 600 }, { from_id: 100, to_id: 200 }]);
  });

  it('merges an overlapping range', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 150, 300);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 300 }]);
  });

  it('merges ranges that only touch at one id (consecutive feed pages)', () => {
    addCoverage(db, 1, 200, 300);
    addCoverage(db, 1, 100, 200);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 300 }]);
  });

  it('merges ranges separated by no integer at all', () => {
    addCoverage(db, 1, 201, 300);
    addCoverage(db, 1, 100, 200);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 300 }]);
  });

  // Той самий стик, але в зворотному порядку вставки: тут працює нижня межа пошуку
  // (`from - 1`), а не верхня. Без цього тесту рядок `const low = from - 1` не має доказу.
  it('merges ranges separated by no integer at all, lower range added first', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 201, 300);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 300 }]);
  });

  // Розрив у ОДИН id — це чекін, якого ми не бачили. Зливати не можна.
  it('does not merge across a one-id gap', () => {
    addCoverage(db, 1, 202, 300);
    addCoverage(db, 1, 100, 200);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 202, to_id: 300 }, { from_id: 100, to_id: 200 }]);
  });

  it('collapses several ranges when one bridges them', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 500, 600);
    addCoverage(db, 1, 900, 1000);
    addCoverage(db, 1, 150, 950);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 1000 }]);
  });

  it('is idempotent for the same page submitted twice', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 100, 200);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 200 }]);
  });

  it('keeps users apart', () => {
    ensureProfile(db, 2);
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 2, 100, 200);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 200 }]);
    expect(coverageFor(db, 2)).toEqual([{ from_id: 100, to_id: 200 }]);
  });

  it('rejects an inverted range instead of writing it', () => {
    expect(() => addCoverage(db, 1, 300, 100)).toThrow();
    expect(coverageFor(db, 1)).toEqual([]);
  });
});

describe('rangeContaining / deepestCoveredId', () => {
  it('finds the range holding an id, and nothing for a hole', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 500, 600);
    expect(rangeContaining(db, 1, 150)).toEqual({ from_id: 100, to_id: 200 });
    expect(rangeContaining(db, 1, 100)).toEqual({ from_id: 100, to_id: 200 });
    expect(rangeContaining(db, 1, 300)).toBeNull();
  });

  it('reports the deepest covered id, and null with no coverage', () => {
    expect(deepestCoveredId(db, 1)).toBeNull();
    addCoverage(db, 1, 500, 600);
    addCoverage(db, 1, 100, 200);
    expect(deepestCoveredId(db, 1)).toBe(100);
  });
});

// Рев'ю PR #592 (P1): рівність лічильників не доводить суцільність — застарілий рядок
// (чекін, видалений на Untappd, лишився в нас) може задовольнити COUNT(*) >= profile_total,
// поки інший id усередині того самого діапазону насправді відсутній. Сид тоді ствердив би
// покриття діри, яку цей застарілий рядок маскував. Тому міграція 29 більше нічого не сидує —
// цей тест доводить саме це: навіть коли лічильники сходяться, checkin_coverage лишається
// порожньою, і перший живий обхід проходить історію користувача сам.
describe('migration 29', () => {
  function seedUser(d: DB, id: number, ids: number[], profileTotal: number | null): void {
    ensureProfile(d, id);
    for (const cid of ids) {
      d.prepare('INSERT INTO checkins (checkin_id, telegram_id, beer_id, user_rating, checkin_at, venue) VALUES (?, ?, NULL, NULL, ?, NULL)')
        .run(String(cid), id, '2026-01-01 00:00:00');
    }
    d.prepare('INSERT INTO checkin_sync_state (telegram_id, deepest_max_id, complete, profile_total) VALUES (?, NULL, 0, ?)')
      .run(id, profileTotal);
  }

  it('leaves checkin_coverage empty for a user whose counts agree — no seed, no unproven claim', () => {
    const fresh = openDb(':memory:');
    migrate(fresh);
    fresh.exec('DELETE FROM checkin_coverage');
    seedUser(fresh, 10, [100, 500, 900], 3); // synced == total — раніше це сидувало б [100, 900]
    fresh.prepare('DELETE FROM schema_version WHERE version = 29').run();
    migrate(fresh);

    expect(coverageFor(fresh, 10)).toEqual([]);
  });
});
