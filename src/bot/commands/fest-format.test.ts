import { createTranslator } from '../../i18n';
import type { FestView } from '../../jobs/fest-view';
import type { TapStatus } from '../../domain/fest/tap-status';
import { formatRanking, formatSection, sectionKey, standLabel, statusLabel } from './fest-format';
import { initialsOf } from './fest';

const t = createTranslator('uk');
const NOW = new Date('2026-10-15T18:00:00.000Z'); // 20:00 in Warsaw

function view(over: Partial<FestView> = {}): FestView {
  const target = (beerId: number, section: string, rating: number | null) =>
    ({ beerId, section, reasons: ['rating' as const], rating, style: null });
  const status = new Map<number, TapStatus>([
    [1, { kind: 'on_tap', lastAt: '2026-10-15T17:48:00.000Z', count: 4 }],
    [2, { kind: 'not_seen' }],
    [3, { kind: 'unknown' }],
  ]);
  return {
    menuCount: 3,
    menuUpdatedAt: '2026-10-15T12:15:00.000Z',
    members: [],
    targets: [target(1, 'PINTA', 4.1), target(2, 'PINTA', 3.85), target(3, 'Verdant <&>', null)],
    unrated: [],
    statusByBeer: status,
    ranking: [
      { section: 'PINTA', onTap: 1, unknown: 0, total: 2, targets: [target(1, 'PINTA', 4.1), target(2, 'PINTA', 3.85)] },
      { section: 'Verdant <&>', onTap: 0, unknown: 1, total: 1, targets: [target(3, 'Verdant <&>', null)] },
    ],
    stands: new Map([['PINTA', { section: 'PINTA', floor: '2', stand: 'B14' }]]),
    bidByBeer: new Map([[1, 101], [2, 102], [3, 103]]),
    beerNames: new Map([[1, { name: 'Motueka', brewery: 'PINTA' }], [2, { name: 'Nelson', brewery: 'PINTA' }], [3, { name: 'Beskidy', brewery: 'Verdant' }]]),
    ...over,
  };
}

describe('formatRanking', () => {
  it('lists sections best first with counts, escaped names and stands, under the menu line', () => {
    expect(formatRanking(t, view())).toBe([
      'Позицій у меню: 3, оновлено о 14:15.',
      '',
      '🍺 1 · ❔ 0 · <b>PINTA</b> · 2 пов., B14',
      '🍺 0 · ❔ 1 · <b>Verdant &lt;&amp;&gt;</b>',
      '',
      '🍺 — Target-и, що зараз наливають · ❔ — не можемо побачити',
    ].join('\n'));
  });

  it('says the menu is not loaded instead of listing nothing', () => {
    expect(formatRanking(t, view({ menuUpdatedAt: null, menuCount: 0, ranking: [] }))).toBe('Меню фестивалю ще не завантажене.');
  });

  it('says there are no Targets when the menu has none for the team', () => {
    expect(formatRanking(t, view({ ranking: [] })).split('\n').slice(-1)).toEqual(['У меню немає Target-ів для цієї команди.']);
  });
});

describe('formatSection', () => {
  it('shows each Target with its rating and tap status', () => {
    expect(formatSection(t, view(), sectionKey('PINTA'), NOW)).toBe([
      '<b>PINTA</b> · 2 пов., B14',
      '',
      'Motueka · ⭐ 4.10',
      '   🟢 чекін 12 хв тому (4)',
      'Nelson · ⭐ 3.85',
      '   ⚪ не бачили за годину',
    ].join('\n'));
  });

  it('is null for a key no ranked section has', () => {
    expect(formatSection(t, view(), 'deadbeef00', NOW)).toBeNull();
  });
});

describe('labels', () => {
  it('unknown and missing statuses read the same', () => {
    expect([statusLabel(t, undefined, NOW), statusLabel(t, { kind: 'unknown' }, NOW)])
      .toEqual(['❔ невідомо — ми не бачили всю годину', '❔ невідомо — ми не бачили всю годину']);
  });

  it('a stand without floor or number is empty; a floor alone is shown', () => {
    expect([standLabel(t, undefined), standLabel(t, { section: 'x', floor: null, stand: null }), standLabel(t, { section: 'x', floor: '1', stand: null })])
      .toEqual(['', '', '1 пов.']);
  });
});

describe('callback data', () => {
  it('fits Telegram’s 64-byte limit for a very long section name and a large team id', () => {
    const data = `fest:s:${2 ** 31}:${sectionKey('Browar '.repeat(40))}`;
    expect([Buffer.byteLength(data) <= 64, sectionKey('PINTA') === sectionKey('PINTA'), sectionKey('PINTA') === sectionKey('Pinta')])
      .toEqual([true, true, false]);
  });
});

describe('initialsOf', () => {
  it('takes first letters of first and last name, upper-cased', () => {
    expect([initialsOf({ first_name: 'yuriy', last_name: 'Silvestrov' }), initialsOf({ first_name: 'Олег' }), initialsOf({ username: 'nesh05' }), initialsOf({})])
      .toEqual(['YS', 'О', 'NE', '?']);
  });
});
