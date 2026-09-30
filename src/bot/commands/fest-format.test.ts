import { createTranslator } from '../../i18n';
import type { FestView } from '../../jobs/fest-view';
import type { TapStatus } from '../../domain/fest/tap-status';
import { formatRanking, formatSection, formatTargets, searchMenu, sectionKey, standLabel, statusLabel } from './fest-format';
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

describe('formatTargets', () => {
  it('shows history completeness (unknown profile as ?), Targets with reasons, and the unrated list apart', () => {
    const v = view({
      members: [
        { telegramId: 1, initials: 'YS', untappdUsername: 'ysilvestrov', inBot: 12709, profileTotal: 12709 },
        { telegramId: 2, initials: 'OB', untappdUsername: 'Nesh05', inBot: 3201, profileTotal: null },
      ],
      targets: [
        { beerId: 1, section: 'PINTA', reasons: ['rating', 'manual'], rating: 4.1, style: null },
        { beerId: 3, section: 'Verdant <&>', reasons: ['style'], rating: null, style: 'Stout - Imperial / Double' },
      ],
      unrated: [{ beer_id: 2, section: 'PINTA', rating_global: null, style: 'Lager - Pale' }],
    });
    expect(formatTargets(t, v)).toBe([
      '<b>Повнота історії</b> (чекінів у боті / у профілі Untappd):',
      'YS: 12709 / 12709',
      'OB: 3201 / ? (синк розширенням не робився)',
      '',
      '<b>Target-и: 2</b>',
      '• Motueka — PINTA · ⭐ 4.10 · ✋ вручну',
      '• Beskidy — Verdant · 🧪 стиль',
      '',
      '<b>Непите без рейтингу: 1</b> (не Target, але й не відкинуте)',
      '• Nelson — Lager - Pale',
    ].join('\n'));
  });

  it('caps the list and says how many more there are', () => {
    const many = Array.from({ length: 42 }, (_, i) => ({ beerId: 1000 + i, section: 'S', reasons: ['rating' as const], rating: 4, style: null }));
    const lines = formatTargets(t, view({ members: [], targets: many })).split('\n');
    expect([lines.filter((l) => l.startsWith('• ')).length, lines[lines.length - 1]]).toEqual([40, '…і ще 2']);
  });
});

describe('searchMenu', () => {
  it('matches name or brewery case-insensitively, up to the limit', () => {
    expect([searchMenu(view(), 'pinta').map((f) => f.beerId), searchMenu(view(), 'BESK').map((f) => f.label), searchMenu(view(), 'pinta', 1).length])
      .toEqual([[1, 2], ['Beskidy — Verdant'], 1]);
  });

  it('finds nothing for an empty or unmatched query', () => {
    expect([searchMenu(view(), '   '), searchMenu(view(), 'zzz')]).toEqual([[], []]);
  });
});
