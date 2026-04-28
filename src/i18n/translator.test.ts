import { makeTranslatorFromDict } from './translator';
import type { Messages } from './types';

describe('translator (plain string keys)', () => {
  const dict: Pick<Messages, 'app.start' | 'link.success' | 'route.header'> = {
    'app.start': 'Hello, world',
    'link.success': 'Linked: {username}',
    'route.header': 'Found {count} beers, {km} km, {pubs} pubs',
  };
  const t = makeTranslatorFromDict('en', dict as Messages);

  test('returns a string verbatim when no params and no placeholders', () => {
    expect(t('app.start')).toBe('Hello, world');
  });

  test('interpolates a single named placeholder', () => {
    expect(t('link.success', { username: 'yuriy' })).toBe('Linked: yuriy');
  });

  test('interpolates multiple placeholders, preserving order', () => {
    expect(t('route.header', { count: 10, km: 4.7, pubs: 6 })).toBe(
      'Found 10 beers, 4.7 km, 6 pubs',
    );
  });

  test('leaves placeholder text in output when a param is missing', () => {
    expect(t('link.success', {})).toBe('Linked: {username}');
  });

  test('coerces number params to string', () => {
    expect(t('link.success', { username: 42 })).toBe('Linked: 42');
  });
});
