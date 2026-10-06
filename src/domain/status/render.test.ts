import { renderStatusReport, TELEGRAM_LIMIT, type StatusReport } from './render';

const allGreen: StatusReport = {
  stamp: '2026-10-06 09:00', overall: 'green',
  subsystems: [
    { subsystem: 'taps', colour: 'green', reasons: [] },
    { subsystem: 'untappd', colour: 'green', reasons: [] },
    { subsystem: 'infra', colour: 'green', reasons: [] },
  ],
  footers: [], events: [], users: [], trends: [],
};

test('an all-green day with nothing else is the header and the light row only', () => {
  expect(renderStatusReport(allGreen)).toBe('🟢 Статус бота — 2026-10-06 09:00 · все гаразд\n\n🟢 Крани  🟢 Untappd  🟢 Інфраструктура');
});

test('full layout: reasons only under non-green, footers, then events, users, trends', () => {
  const report: StatusReport = {
    stamp: '2026-10-06 09:00', overall: 'red',
    subsystems: [
      { subsystem: 'taps', colour: 'green', reasons: [] },
      { subsystem: 'untappd', colour: 'red', reasons: ['канарка пошуку порожня на останньому запуску (05:30)'] },
      { subsystem: 'orphans', colour: 'yellow', reasons: ['тріаж сиріт сьогодні не відпрацював', 'спростованих retire: 2 → 5'] },
    ],
    footers: ['історія: 3/7 днів — порівняльні правила без потрібних днів ще не діють'],
    events: ['Тріаж: 7 рядків'],
    users: ['розширення /match (вчора): 3 запитів · 1 анонім. · 200 пив'],
    trends: ['сиріт у черзі: 100 → 121 (+21 % за тиждень)'],
  };
  expect(renderStatusReport(report)).toBe([
    '🔴 Статус бота — 2026-10-06 09:00 · потрібна реакція',
    '',
    '🟢 Крани  🔴 Untappd  🟡 Сироти',
    '',
    '🔴 Untappd',
    '  • канарка пошуку порожня на останньому запуску (05:30)',
    '',
    '🟡 Сироти',
    '  • тріаж сиріт сьогодні не відпрацював',
    '  • спростованих retire: 2 → 5',
    '',
    'ℹ️ історія: 3/7 днів — порівняльні правила без потрібних днів ще не діють',
    '',
    'Події',
    '  • Тріаж: 7 рядків',
    '',
    'Живі користувачі',
    '  • розширення /match (вчора): 3 запитів · 1 анонім. · 200 пив',
    '',
    'Тренди',
    '  • сиріт у черзі: 100 → 121 (+21 % за тиждень)',
  ].join('\n'));
});

test('a yellow overall says it needs attention', () => {
  const text = renderStatusReport({ ...allGreen, overall: 'yellow' });
  expect(text.split('\n')[0]).toBe('🟡 Статус бота — 2026-10-06 09:00 · потребує уваги');
});

test('an over-long report is cut to the Telegram limit with a visible mark', () => {
  const text = renderStatusReport({ ...allGreen, trends: Array.from({ length: 400 }, (_, k) => `тренд ${k}`) });
  expect([text.length, text.endsWith('\n… (обрізано)'), text.startsWith('🟢 Статус бота')]).toEqual([TELEGRAM_LIMIT, true, true]);
});

test('a report exactly at the limit is not cut', () => {
  const head = renderStatusReport(allGreen);
  const filler = 'x'.repeat(TELEGRAM_LIMIT - head.length - '\n\nПодії\n  • '.length);
  const text = renderStatusReport({ ...allGreen, events: [filler] });
  expect([text.length, text.endsWith(filler)]).toEqual([TELEGRAM_LIMIT, true]);
});

test('truncation never leaves half of an emoji at the cut', () => {
  const head = renderStatusReport(allGreen);
  const cut = TELEGRAM_LIMIT - '\n… (обрізано)'.length;
  // Put the first UTF-16 unit of 🍺 exactly at the last position the cut keeps.
  const before = 'x'.repeat(cut - 1 - head.length - '\n\nПодії\n  • '.length);
  const text = renderStatusReport({ ...allGreen, events: [`${before}🍺${'y'.repeat(100)}`] });
  expect([text.length, text.endsWith('x\n… (обрізано)'), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)])
    .toEqual([TELEGRAM_LIMIT - 1, true, false]);
});
