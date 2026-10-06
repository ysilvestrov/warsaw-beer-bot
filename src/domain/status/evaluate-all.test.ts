import { evaluateAll, evaluateChannels, evaluateOrphans } from './evaluate';
import { GREEN_METRICS, greenInputs, pastDays } from './test-inputs';
import type { BugReportSummary } from '../bug-report-types';

const idleSummary: BugReportSummary = {
  processed: 0, byVerdict: { new: 0, duplicate_open: 0, duplicate_closed: 0, not_a_bug: 0 },
  queued: 0, needsReview: [], failed: [], closedLinks: [],
};

describe('Сироти', () => {
  test('green fixture is green', () => {
    expect(evaluateOrphans(greenInputs())).toEqual({ subsystem: 'orphans', colour: 'green', reasons: [] });
  });
  test('every orphan rule firing at once is still only yellow (capped)', () => {
    const inputs = greenInputs({
      triage: { ranToday: false, line: null, saturated: 'Насичені: #452 (14) — усього 1' },
      unlock: { ranToday: false, withheld: [{ beerId: 38770, issueNumber: 452 }] },
      metrics: { ...GREEN_METRICS, unlockedUnadjudicated7d: 2, sealRetiredFalsified: 5 },
      history: pastDays(1, { sealRetiredFalsified: 2 }),
    });
    expect(evaluateOrphans(inputs)).toEqual({
      subsystem: 'orphans', colour: 'yellow', reasons: [
        'тріаж сиріт сьогодні не відпрацював',
        'Насичені: #452 (14) — усього 1',
        'замок сьогодні не перевірявся (unlock-fixed-orphans)',
        'утримано після закриття: 1 (#452 / beer 38770)',
        'розімкнено без негативного маркера за 7 днів: 2',
        'спростованих retire: 2 → 5',
      ],
    });
  });
  test('withheld rows list at most five examples', () => {
    const withheld = [1, 2, 3, 4, 5, 6].map((n) => ({ beerId: n, issueNumber: 400 + n }));
    expect(evaluateOrphans(greenInputs({ unlock: { ranToday: true, withheld } })).reasons).toEqual([
      'утримано після закриття: 6 (#401 / beer 1, #402 / beer 2, #403 / beer 3, #404 / beer 4, #405 / beer 5, …)',
    ]);
  });
  test('an unreadable unlock result is missing data, not zero withheld', () => {
    const e = evaluateOrphans(greenInputs({ unlock: { ranToday: true, withheld: null } }));
    expect([e.colour, e.reasons]).toEqual(['yellow', ['нема даних: результат замка пошкоджено']]);
  });
  test('retire count equal to yesterday does not fire; no yesterday snapshot means inactive', () => {
    expect([
      evaluateOrphans(greenInputs({ history: pastDays(1, { sealRetiredFalsified: 2 }) })).colour,
      evaluateOrphans(greenInputs({ metrics: { ...GREEN_METRICS, sealRetiredFalsified: 99 } })).colour,
    ]).toEqual(['green', 'green']);
  });
});

test('an unreadable triage result is no data in Сироти', () => {
  expect(evaluateOrphans(greenInputs({ triage: { ranToday: true, line: null, saturated: null, unreadable: true } }))).toEqual({
    subsystem: 'orphans', colour: 'yellow', reasons: ['нема даних: результат тріажу пошкоджено'],
  });
});

describe('Канали', () => {
  test('no repo configured means no bug-report channel and green', () => {
    expect(evaluateChannels(greenInputs({ bugReports: null }))).toEqual({ subsystem: 'channels', colour: 'green', reasons: [] });
  });
  test('an unreadable pause marker is no data, not "not paused"', () => {
    const inputs = greenInputs({ bugReports: { summary: idleSummary, paused: null, pausedUnreadable: true } });
    expect(evaluateChannels(inputs)).toEqual({
      subsystem: 'channels', colour: 'yellow', reasons: ['нема даних: стан паузи скарг пошкоджено'],
    });
  });
  test('paused bug reports are red', () => {
    const inputs = greenInputs({ bugReports: { summary: idleSummary, paused: { since: '2026-10-06T04:12:33.000Z', status: 401 } } });
    expect(evaluateChannels(inputs)).toEqual({
      subsystem: 'channels', colour: 'red', reasons: ['скарги на паузі з 2026-10-06 04:12 UTC: ключ відхилено (401)'],
    });
  });
  test('reports needing review or failed are yellow and named', () => {
    const inputs = greenInputs({ bugReports: { summary: { ...idleSummary, needsReview: [7], failed: [9] }, paused: null } });
    expect(evaluateChannels(inputs)).toEqual({
      subsystem: 'channels', colour: 'yellow', reasons: ['скарги потребують перевірки: R-7, R-9'],
    });
  });
});

describe('evaluateAll', () => {
  const fest = { menuLastAt: null, menuCycleMs: 6 * 3_600_000, keepaliveLastAt: '2026-10-05T21:26:00.000Z', keepaliveCycleMs: 24 * 3_600_000 };
  test('subsystem order, no fest without a fest, history footer counts the week', () => {
    const result = evaluateAll(greenInputs({ history: pastDays(3) }));
    expect(result).toEqual({
      overall: 'green',
      subsystems: ['taps', 'untappd', 'orphans', 'channels', 'infra'].map((subsystem) => ({ subsystem, colour: 'green', reasons: [] })),
      footers: ['історія: 3/7 днів — порівняльні правила без потрібних днів ще не діють'],
    });
  });
  test('fest sits before infra when present, and the overall colour is the worst', () => {
    const result = evaluateAll(greenInputs({ history: pastDays(7), fest, algoliaOpenUntil: '2026-10-06T10:00:00.000Z' }));
    expect([result.overall, result.subsystems.map((s) => s.subsystem), result.footers]).toEqual([
      'red', ['taps', 'untappd', 'orphans', 'channels', 'fest', 'infra'], [],
    ]);
  });
});
