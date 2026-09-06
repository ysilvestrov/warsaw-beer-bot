import type { DB } from './db';

export interface CoverageRange {
  from_id: number;
  to_id: number;
}

// #587: покриття чекінів — це об'єднання діапазонів, кожен з яких доводить сама сторінка
// фіду: фрагмент, запитаний із курсором M, повертає ВСЕ, що лежить нижче M до найстарішого
// свого елемента. Тому діапазон не залежить ні від того, з якого прогону сторінка прийшла,
// ні від того, чи той прогін обірвався.
export function coverageFor(db: DB, telegramId: number): CoverageRange[] {
  return db
    .prepare('SELECT from_id, to_id FROM checkin_coverage WHERE telegram_id = ? ORDER BY from_id DESC')
    .all(telegramId) as CoverageRange[];
}

// Зливає діапазон у покриття. Дотик рахується злиттям (`from - 1` / `to + 1`): між 200 і 201
// немає жодного id, тож жоден чекін не міг би туди сховатися. А от розрив у один id — це вже
// чекін, якого ми не бачили, і такі діапазони лишаються окремими.
export function addCoverage(db: DB, telegramId: number, from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
    throw new Error(`invalid coverage range: ${from}..${to}`);
  }
  const low = from - 1;
  const high = to + 1;
  const touching = db
    .prepare('SELECT from_id, to_id FROM checkin_coverage WHERE telegram_id = ? AND to_id >= ? AND from_id <= ?')
    .all(telegramId, low, high) as CoverageRange[];

  let lo = from;
  let hi = to;
  for (const r of touching) {
    if (r.from_id < lo) lo = r.from_id;
    if (r.to_id > hi) hi = r.to_id;
  }

  db.prepare('DELETE FROM checkin_coverage WHERE telegram_id = ? AND to_id >= ? AND from_id <= ?')
    .run(telegramId, low, high);
  db.prepare('INSERT INTO checkin_coverage (telegram_id, from_id, to_id) VALUES (?, ?, ?)')
    .run(telegramId, lo, hi);
}

export function rangeContaining(db: DB, telegramId: number, id: number): CoverageRange | null {
  const row = db
    .prepare('SELECT from_id, to_id FROM checkin_coverage WHERE telegram_id = ? AND from_id <= ? AND to_id >= ? LIMIT 1')
    .get(telegramId, id, id) as CoverageRange | undefined;
  return row ?? null;
}

export function deepestCoveredId(db: DB, telegramId: number): number | null {
  const row = db
    .prepare('SELECT MIN(from_id) AS m FROM checkin_coverage WHERE telegram_id = ?')
    .get(telegramId) as { m: number | null };
  return row.m;
}
