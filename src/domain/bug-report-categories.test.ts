import { expect, test } from 'vitest';
import { REPORT_CATEGORIES } from './bug-report-types';
import { CATEGORIES, categoriesFor } from './bug-report-categories';

test('bot categories follow the specified order', () => {
  expect(categoriesFor('bot').map(({ key }) => key)).toEqual([
    'wrong_beer', 'no_rating', 'had_status', 'stale_data', 'route',
    'bot_broken', 'text_ui', 'other',
  ]);
});

test('extension categories follow the specified order', () => {
  expect(categoriesFor('extension').map(({ key }) => key)).toEqual([
    'wrong_beer', 'no_rating', 'had_status', 'stale_data', 'no_badge',
    'ext_broken', 'text_ui', 'other',
  ]);
});

test('other reports use the general bug hint', () => {
  expect(CATEGORIES.find(({ key }) => key === 'other')?.hintLabel).toBe('bug');
});

test('every report category has one definition', () => {
  expect(CATEGORIES.map(({ key }) => key)).toEqual([...REPORT_CATEGORIES]);
});
