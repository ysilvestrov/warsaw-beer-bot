import { expect, test } from 'vitest';
import type { TemplateFields } from './bug-report-types';
import { redact, redactFields } from './bug-report-redact';

test.each([
  '+48 123 456 789', '123-456-789', '(22) 123 45 67', '+380501234567',
  '+48 123.456.789', '123.456.789', '+48.123.456.789',
  'ivan.k@gmail.com', '@ivan_hops_1987',
  'https://untappd.com/user/ivan_hops', 'untappd.com/user/ivan/beers',
  'www.untappd.com/user/x_y',
])('redacts personal value %s', (value) => {
  expect(redact(value)).toBe('[приховано]');
});

test.each([
  'ABV 6.5%', 'рейтинг 4.12', '2026', 'bid 6172824',
  'Przekład #9 16°', '0.33л', 'Kronenbourg 1664', '95 ₴',
  '2026-09-26', '2026-09-26 12:30', '1999-12-31', 'a @ b', '@ab',
  'https://untappd.com/b/volta-anima/123456', '12345678',
  '123--456-789', '1234567890123456', 'рейтинги 4.0 4.1 4.2 4.0 4.2', 'v0.20.0', '1.234.567', '4.0 4.1 4.2 4.0 4.2 4.1',
])('preserves non-personal value %s', (value) => {
  expect(redact(value)).toBe(value);
});

test('redacts a handle and email without changing the beer name', () => {
  expect(redact('Buzdygan for @ivan_hops and ivan.k@gmail.com'))
    .toBe('Buzdygan for [приховано] and [приховано]');
});

test('redacts every string and array item in template fields', () => {
  const fields: TemplateFields = {
    title: '@ivan_hops', summary: 'ivan.k@gmail.com', where: 'untappd.com/user/ivan/beers',
    subjects: ['+48 123 456 789'], expected: '@expected_1', actual: '123-456-789',
    steps: ['@step_1'], screenEvidence: ['+380501234567'], newEvidence: '@new_evidence',
  };
  expect(redactFields(fields)).toEqual({
    title: '[приховано]', summary: '[приховано]', where: '[приховано]',
    subjects: ['[приховано]'], expected: '[приховано]', actual: '[приховано]',
    steps: ['[приховано]'], screenEvidence: ['[приховано]'], newEvidence: '[приховано]',
  });
});
