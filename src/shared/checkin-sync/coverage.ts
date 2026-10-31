export interface CoverageRange {
  from_id: number;
  to_id: number;
}

// #587: покриття чекінів — це об'єднання діапазонів, кожен з яких доводить сама сторінка фіду.
// Чиста версія `addCoverage` (storage/checkin_coverage.ts) для покриття, що живе не в SQLite
// (#924, IndexedDB розширення). Семантика та сама: дотик рахується злиттям (`from - 1` / `to + 1`),
// бо між 200 і 201 немає жодного id; розрив в один id — це чекін, якого ми не бачили, і такі
// діапазони лишаються окремими. Що SQL і ця функція дають однакове покриття, доводить
// coverage-parity.test.ts.
export function mergeRange(ranges: readonly CoverageRange[], from: number, to: number): CoverageRange[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
    throw new Error(`invalid coverage range: ${from}..${to}`);
  }
  const low = from - 1;
  const high = to + 1;
  let lo = from;
  let hi = to;
  const kept: CoverageRange[] = [];
  for (const r of ranges) {
    if (r.to_id >= low && r.from_id <= high) {
      if (r.from_id < lo) lo = r.from_id;
      if (r.to_id > hi) hi = r.to_id;
    } else {
      kept.push({ from_id: r.from_id, to_id: r.to_id });
    }
  }
  kept.push({ from_id: lo, to_id: hi });
  return kept.sort((a, b) => b.from_id - a.from_id);
}

export function rangeContaining(ranges: readonly CoverageRange[], id: number): CoverageRange | null {
  return ranges.find((r) => r.from_id <= id && r.to_id >= id) ?? null;
}
