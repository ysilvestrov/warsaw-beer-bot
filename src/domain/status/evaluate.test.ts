import { evaluateFest, evaluateInfra, evaluateTaps, evaluateUntappd, worst } from './evaluate';
import { GREEN_METRICS, greenInputs, NOW, pastDays } from './test-inputs';
import { GIB_BYTES } from './rules';
import type { FestInputs } from './types';

const withMetrics = (patch: Partial<typeof GREEN_METRICS>) => greenInputs({ metrics: { ...GREEN_METRICS, ...patch } });

test('worst picks the most severe colour; no colours is green', () => {
  expect([worst([]), worst(['green', 'yellow']), worst(['yellow', 'red', 'green'])]).toEqual(['green', 'yellow', 'red']);
});

describe('Крани', () => {
  test('green fixture is green with no reasons', () => {
    expect(evaluateTaps(greenInputs())).toEqual({ subsystem: 'taps', colour: 'green', reasons: [] });
  });
  test.each([
    [14, 'green', []],
    [14.6, 'yellow', ['останній скрейп 15 год тому']],
    [26, 'yellow', ['останній скрейп 26 год тому']],
    [26.4, 'red', ['останній скрейп 26 год тому']],
  ] as const)('scrape %f h ago → %s', (hours, colour, reasons) => {
    expect(evaluateTaps(withMetrics({ lastScrapeHoursAgo: hours }))).toEqual({ subsystem: 'taps', colour, reasons });
  });
  test('no scrape at all is red', () => {
    expect(evaluateTaps(withMetrics({ lastScrapeHoursAgo: null }))).toEqual({
      subsystem: 'taps', colour: 'red', reasons: ['скрейпів кранів немає взагалі'],
    });
  });
  test('zero pubs in fresh snapshots is red', () => {
    expect(evaluateTaps(withMetrics({ onTapPubs: 0 }))).toEqual({
      subsystem: 'taps', colour: 'red', reasons: ['у свіжих знімках 0 пабів із кранами'],
    });
  });
  test('pubs below 90 % of the 7-day median is yellow; exactly 90 % is not', () => {
    const history = pastDays(7, { pubsScraped24h: 100 });
    expect([
      evaluateTaps(greenInputs({ history, metrics: { ...GREEN_METRICS, pubsScraped24h: 90 } })).colour,
      evaluateTaps(greenInputs({ history, metrics: { ...GREEN_METRICS, pubsScraped24h: 89 } })),
    ]).toEqual(['green', { subsystem: 'taps', colour: 'yellow', reasons: ['скрейп за 24 год охопив 89 пабів проти звичних 100'] }]);
  });
  test('the pubs rule is inactive with six days of history', () => {
    const inputs = greenInputs({ history: pastDays(6, { pubsScraped24h: 100 }), metrics: { ...GREEN_METRICS, pubsScraped24h: 10 } });
    expect(evaluateTaps(inputs).colour).toBe('green');
  });
});

describe('Untappd', () => {
  test('green fixture is green', () => {
    expect(evaluateUntappd(greenInputs())).toEqual({ subsystem: 'untappd', colour: 'green', reasons: [] });
  });
  test('canary empty on the latest run is red with its Warsaw time', () => {
    const inputs = greenInputs({ canary: { ok: true, value: { ok: false, at: '2026-10-06T03:30:10.000Z' } } });
    expect(evaluateUntappd(inputs)).toEqual({
      subsystem: 'untappd', colour: 'red', reasons: ['канарка пошуку порожня на останньому запуску (05:30)'],
    });
  });
  test('a canary that never ran is yellow, not green', () => {
    expect(evaluateUntappd(greenInputs({ canary: { ok: true, value: null } }))).toEqual({
      subsystem: 'untappd', colour: 'yellow', reasons: ['нема даних: канарка пошуку ще не запускалась'],
    });
  });
  test('unreadable canary state is yellow with the reason', () => {
    expect(evaluateUntappd(greenInputs({ canary: { ok: false, reason: 'стан канарки пошкоджено' } }))).toEqual({
      subsystem: 'untappd', colour: 'yellow', reasons: ['нема даних: стан канарки пошкоджено'],
    });
  });
  test('Algolia breaker open now is red; one that closed a second ago is not', () => {
    expect([
      evaluateUntappd(greenInputs({ algoliaOpenUntil: '2026-10-06T10:00:00.000Z' })),
      evaluateUntappd(greenInputs({ algoliaOpenUntil: '2026-10-06T06:59:59.000Z' })).colour,
    ]).toEqual([{ subsystem: 'untappd', colour: 'red', reasons: ['Algolia-breaker відкритий до 12:00'] }, 'green']);
  });
  test('profile breaker open now is yellow', () => {
    expect(evaluateUntappd(greenInputs({ profileOpenUntil: '2026-10-06T10:00:00.000Z' }))).toEqual({
      subsystem: 'untappd', colour: 'yellow', reasons: ['breaker профіль-скрейпу відкритий до 12:00'],
    });
  });
  test('ratings missing must beat the median by both 10 % and 20 rows', () => {
    const history = pastDays(7, { ratingsMissing: 100 });
    expect([
      evaluateUntappd(greenInputs({ history, metrics: { ...GREEN_METRICS, ratingsMissing: 120 } })).colour,
      evaluateUntappd(greenInputs({ history, metrics: { ...GREEN_METRICS, ratingsMissing: 121 } })),
    ]).toEqual(['green', { subsystem: 'untappd', colour: 'yellow', reasons: ['зматчених без рейтингу 121 проти звичних 100'] }]);
  });
});

describe('Фест', () => {
  const fest = (patch: Partial<FestInputs>): FestInputs => ({
    menuLastAt: '2026-10-06T06:00:00.000Z', menuCycleMs: 6 * 3_600_000,
    keepaliveLastAt: '2026-10-05T21:26:00.000Z', keepaliveCycleMs: 24 * 3_600_000, ...patch,
  });
  test('fresh menu and keep-alive are green', () => {
    expect(evaluateFest(fest({}), NOW)).toEqual({ subsystem: 'fest', colour: 'green', reasons: [] });
  });
  test.each([
    ['2026-10-05T19:00:00.000Z', 'green', []],                                       // exactly 2 cycles
    ['2026-10-05T18:59:00.000Z', 'yellow', ['меню фесту не оновлювалось 12 год']],
    ['2026-10-05T07:00:00.000Z', 'yellow', ['меню фесту не оновлювалось 24 год']],   // exactly 4 cycles
    ['2026-10-05T06:59:00.000Z', 'red', ['меню фесту не оновлювалось 24 год']],
  ] as const)('menu last read %s → %s', (menuLastAt, colour, reasons) => {
    expect(evaluateFest(fest({ menuLastAt }), NOW)).toEqual({ subsystem: 'fest', colour, reasons });
  });
  test('never-read menu and never-passed keep-alive are yellow', () => {
    expect(evaluateFest(fest({ menuLastAt: null, keepaliveLastAt: null }), NOW)).toEqual({
      subsystem: 'fest', colour: 'yellow',
      reasons: ['меню фесту: ще жодного успішного оновлення', 'MCP keep-alive фесту: ще жодного успішного оновлення'],
    });
  });
});

describe('Інфраструктура', () => {
  const disk = (bytesAvailable: number, inodesFree = 2_000_000, pendingRuns: number | null = 0) =>
    greenInputs({ disk: { ok: true, value: { bytesAvailable, inodesFree, pendingRuns } } });
  test('green fixture is green', () => {
    expect(evaluateInfra(greenInputs())).toEqual({ subsystem: 'infra', colour: 'green', reasons: [] });
  });
  test.each([
    [10 * GIB_BYTES + 1, 'green', []],
    [10 * GIB_BYTES, 'yellow', ['диск: 10.00 GiB вільно']],
    [5 * GIB_BYTES + 1, 'yellow', ['диск: 5.00 GiB вільно']],
    [5 * GIB_BYTES, 'red', ['диск: 5.00 GiB вільно']],
  ] as const)('disk %i bytes → %s', (bytes, colour, reasons) => {
    expect(evaluateInfra(disk(bytes))).toEqual({ subsystem: 'infra', colour, reasons });
  });
  test('inodes below 100 000 are red; exactly 100 000 is not', () => {
    expect([evaluateInfra(disk(32 * GIB_BYTES, 100_000)).colour, evaluateInfra(disk(32 * GIB_BYTES, 99_999))])
      .toEqual(['green', { subsystem: 'infra', colour: 'red', reasons: ['inode: 99 999 вільно'] }]);
  });
  test('pending test directories and an unavailable inventory are yellow', () => {
    expect([evaluateInfra(disk(32 * GIB_BYTES, 2_000_000, 2)), evaluateInfra(disk(32 * GIB_BYTES, 2_000_000, null))]).toEqual([
      { subsystem: 'infra', colour: 'yellow', reasons: ['тестових каталогів на перевірку: 2'] },
      { subsystem: 'infra', colour: 'yellow', reasons: ['нема даних: інвентар тестових каталогів'] },
    ]);
  });
  test('an unreadable monitor is yellow with its reason', () => {
    expect(evaluateInfra(greenInputs({ disk: { ok: false, reason: 'дані монітора недоступні' } }))).toEqual({
      subsystem: 'infra', colour: 'yellow', reasons: ['нема даних: дані монітора недоступні'],
    });
  });
  test('disk falling more than 1 GiB/day over a week is yellow; exactly 1 GiB/day is not', () => {
    const weekAgo = (bytes: number) => [{ date: '2026-09-29', metrics: { ...GREEN_METRICS, diskBytesAvailable: bytes } }];
    const today = 20 * GIB_BYTES;
    expect([
      evaluateInfra(greenInputs({ history: weekAgo(today + 7 * GIB_BYTES), disk: { ok: true, value: { bytesAvailable: today, inodesFree: 2_000_000, pendingRuns: 0 } } })).colour,
      evaluateInfra(greenInputs({ history: weekAgo(today + 7 * GIB_BYTES + 7), disk: { ok: true, value: { bytesAvailable: today, inodesFree: 2_000_000, pendingRuns: 0 } } })),
    ]).toEqual(['green', { subsystem: 'infra', colour: 'yellow', reasons: ['диск тане ~1.00 GiB/добу'] }]);
  });
});
