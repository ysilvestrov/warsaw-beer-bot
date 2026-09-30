import { rankSections } from './ranking';
import type { Target } from './targets';
import type { TapStatus } from './tap-status';

const t = (beerId: number, section: string): Target => ({ beerId, section, reasons: ['rating'], rating: 4, style: null });
const ON: TapStatus = { kind: 'on_tap', lastAt: '2026-10-15T17:50:00.000Z', count: 1 };
const UNKNOWN: TapStatus = { kind: 'unknown' };
const NOT_SEEN: TapStatus = { kind: 'not_seen' };

describe('rankSections', () => {
  it('orders by on-tap, then unknown, then total, then name — each key on its own', () => {
    const targets = [
      t(1, 'Delta'), t(2, 'Delta'), t(3, 'Delta'),   // 0 on, 0 unknown, 3 total
      t(4, 'Alpha'),                                  // 1 on
      t(5, 'Bravo'), t(6, 'Bravo'),                   // 0 on, 2 unknown
      t(7, 'Charlie'), t(8, 'Charlie'),               // 0 on, 1 unknown, 2 total
      t(9, 'Echo'),                                   // 0 on, 1 unknown, 1 total
      t(10, 'Foxtrot'),                               // 0 on, 1 unknown, 1 total (name after Echo)
    ];
    const status = new Map<number, TapStatus>([
      [1, NOT_SEEN], [2, NOT_SEEN], [3, NOT_SEEN],
      [4, ON],
      [5, UNKNOWN], [6, UNKNOWN],
      [7, UNKNOWN], [8, NOT_SEEN],
      [9, UNKNOWN],
      [10, UNKNOWN],
    ]);
    expect(rankSections(targets, status).map((r) => [r.section, r.onTap, r.unknown, r.total])).toEqual([
      ['Alpha', 1, 0, 1],
      ['Bravo', 0, 2, 2],
      ['Charlie', 0, 1, 2],
      ['Echo', 0, 1, 1],
      ['Foxtrot', 0, 1, 1],
      ['Delta', 0, 0, 3],
    ]);
  });

  it('a Target without a computed status counts as unknown', () => {
    expect(rankSections([t(1, 'Solo')], new Map()).map((r) => [r.onTap, r.unknown])).toEqual([[0, 1]]);
  });

  it('keeps each section\'s Targets and lists no section without one', () => {
    const ranked = rankSections([t(1, 'A'), t(2, 'A')], new Map<number, TapStatus>([[1, ON], [2, NOT_SEEN]]));
    expect(ranked.map((r) => [r.section, r.targets.map((x) => x.beerId)])).toEqual([['A', [1, 2]]]);
    expect(rankSections([], new Map())).toEqual([]);
  });
});
