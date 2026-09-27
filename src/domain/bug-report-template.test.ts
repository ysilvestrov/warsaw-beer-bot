import { expect, test } from 'vitest';
import type { ReportContext, TemplateFields } from './bug-report-types';
import { clampFields, renderDuplicateComment, renderIssueBody } from './bug-report-template';

const fields: TemplateFields = {
  title: 'Зник рейтинг', summary: 'Пиво показує чужий рейтинг', where: 'Картка пива',
  subjects: ['Броварня', 'Пиво'], expected: 'Рейтинг 4.2', actual: 'Рейтинг 3.1',
  steps: ['Відкрити картку', 'Подивитися рейтинг'],
  screenEvidence: ['Видно 3.1'], newEvidence: 'Помилка повторилася',
};
const bot: ReportContext = {
  reportId: 7, source: 'bot', category: 'wrong_beer', locale: 'uk', city: 'Варшава',
  latestExtensionVersion: null, mediaStored: 0, mediaFailed: 0,
};

test('renders a full bot issue with steps and screenshot evidence', () => {
  expect(renderIssueBody(fields, bot)).toBe(`## Симптом
Пиво показує чужий рейтинг

**Де:** Картка пива
**Об'єкти:** Броварня, Пиво
**Очікувано:** Рейтинг 4.2
**Фактично:** Рейтинг 3.1

## Кроки
1. Відкрити картку
2. Подивитися рейтинг

## Видно на скріншотах
- Видно 3.1

## Контекст
| Джерело | Категорія | Версія розширення | Місто | Мова |
|---|---|---|---|---|
| Бот | Не те пиво / чужий рейтинг | — | Варшава | uk |

Severity і effort — оцінка агента.
Скарга R-7 · медіа: немає
<!-- bug-report:7 -->`);
});

test('renders extension issue without empty optional sections and with stored media', () => {
  expect(renderIssueBody({ ...fields, steps: [], screenEvidence: [] }, {
    ...bot, source: 'extension', category: 'no_badge', city: null,
    latestExtensionVersion: '0.16.0', mediaStored: 2,
  })).toBe(`## Симптом
Пиво показує чужий рейтинг

**Де:** Картка пива
**Об'єкти:** Броварня, Пиво
**Очікувано:** Рейтинг 4.2
**Фактично:** Рейтинг 3.1

## Контекст
| Джерело | Категорія | Версія розширення | Місто | Мова |
|---|---|---|---|---|
| Розширення | Позначка не з'являється на сторінці крамниці | невідома (остання опублікована: 0.16.0) | — | uk |

Severity і effort — оцінка агента.
Скарга R-7 · медіа: 2 файл(и), лише на сервері: \`bug-reports/7/\`
<!-- bug-report:7 -->`);
});

test('renders missing extension version and failed media', () => {
  expect(renderIssueBody({ ...fields, summary: '', where: '', subjects: [], expected: '', actual: '', steps: [], screenEvidence: [] }, {
    ...bot, source: 'extension', category: 'other', city: null, mediaFailed: 1,
  })).toBe(`## Симптом
—

**Де:** —
**Об'єкти:** —
**Очікувано:** —
**Фактично:** —

## Контекст
| Джерело | Категорія | Версія розширення | Місто | Мова |
|---|---|---|---|---|
| Розширення | Інше | невідома | — | uk |

Severity і effort — оцінка агента.
Скарга R-7 · медіа: не збережено (1)
<!-- bug-report:7 -->`);
});

test('renders a duplicate comment with empty new evidence and no severity line', () => {
  expect(renderDuplicateComment({ ...fields, newEvidence: '', steps: [], screenEvidence: [] }, bot)).toBe(`**Нове в цій скарзі:** —

## Симптом
Пиво показує чужий рейтинг

**Де:** Картка пива
**Об'єкти:** Броварня, Пиво
**Очікувано:** Рейтинг 4.2
**Фактично:** Рейтинг 3.1

## Контекст
| Джерело | Категорія | Версія розширення | Місто | Мова |
|---|---|---|---|---|
| Бот | Не те пиво / чужий рейтинг | — | Варшава | uk |

Скарга R-7 · медіа: немає
<!-- bug-report:7 -->`);
});

test('reports failed media alongside stored files', () => {
  expect(renderIssueBody(fields, { ...bot, mediaStored: 2, mediaFailed: 1 }))
    .toContain('Скарга R-7 · медіа: 2 файл(и), лише на сервері: `bug-reports/7/`, не збережено: 1');
});

test('clamps title at 100 code points with an ellipsis', () => {
  expect(clampFields({ ...fields, title: 'x'.repeat(100) }).title).toBe('x'.repeat(100));
  expect(clampFields({ ...fields, title: 'x'.repeat(101) }).title).toBe(`${'x'.repeat(99)}…`);
});

test('drops empty array items and keeps only the first five', () => {
  expect(clampFields({ ...fields, subjects: ['', '  ', 'a', 'b', 'c', 'd', 'e', 'f'] }).subjects)
    .toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(clampFields({ ...fields, subjects: ['a', 'b', 'c', 'd', 'e', 'f'] }).subjects)
    .toEqual(['a', 'b', 'c', 'd', 'e']);
});

test('keeps summary newlines but flattens where newlines', () => {
  const result = clampFields({ ...fields, summary: 'a\nb', where: 'a\nb' });
  expect(result.summary).toBe('a\nb');
  expect(result.where).toBe('a b');
});

test('escapes HTML marker syntax in every field', () => {
  expect(clampFields({ ...fields, title: '<!-- x -->', steps: ['<b>'] }))
    .toEqual({ ...fields, title: '&lt;!-- x --&gt;', steps: ['&lt;b&gt;'] });
});

test('counts emoji as one character when clamping', () => {
  expect(clampFields({ ...fields, title: `😀${'x'.repeat(99)}` }).title)
    .toBe(`😀${'x'.repeat(99)}`);
  expect(clampFields({ ...fields, title: `😀${'x'.repeat(100)}` }).title)
    .toBe(`😀${'x'.repeat(98)}…`);
});

test('clamps all fields to their own limits', () => {
  const result = clampFields({
    title: 'x'.repeat(101), summary: 'x'.repeat(301), where: 'x'.repeat(201),
    subjects: ['x'.repeat(101)], expected: 'x'.repeat(201), actual: 'x'.repeat(201),
    steps: ['x'.repeat(151)], screenEvidence: ['x'.repeat(151)], newEvidence: 'x'.repeat(301),
  });
  expect(result).toEqual({
    title: `${'x'.repeat(99)}…`, summary: `${'x'.repeat(299)}…`, where: `${'x'.repeat(199)}…`,
    subjects: [`${'x'.repeat(99)}…`], expected: `${'x'.repeat(199)}…`,
    actual: `${'x'.repeat(199)}…`, steps: [`${'x'.repeat(149)}…`],
    screenEvidence: [`${'x'.repeat(149)}…`], newEvidence: `${'x'.repeat(299)}…`,
  });
});
