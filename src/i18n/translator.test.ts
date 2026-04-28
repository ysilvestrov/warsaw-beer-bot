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

describe('translator (plurals)', () => {
  // Synthetic dict — PR 1 has no real plural keys in uk.ts yet.
  const ukDict = {
    'pubs.uk': {
      one:  'паб у маршруті: {count}',
      few:  'паби у маршруті: {count}',
      many: 'пабів у маршруті: {count}',
      other:'пабів у маршруті: {count}',
    },
  } as unknown as Messages;
  const enDict = {
    'pubs.en': {
      one:   '{count} pub on the route',
      other: '{count} pubs on the route',
    },
  } as unknown as Messages;

  const ukT = makeTranslatorFromDict('uk', ukDict);
  const enT = makeTranslatorFromDict('en', enDict);

  test('UA selects "one" for count = 1', () => {
    expect(ukT('pubs.uk' as keyof Messages, { count: 1 })).toBe('паб у маршруті: 1');
  });

  test('UA selects "few" for count = 3', () => {
    expect(ukT('pubs.uk' as keyof Messages, { count: 3 })).toBe('паби у маршруті: 3');
  });

  test('UA selects "many" for count = 5', () => {
    expect(ukT('pubs.uk' as keyof Messages, { count: 5 })).toBe('пабів у маршруті: 5');
  });

  test('UA selects "many" for count = 0 (Intl.PluralRules convention)', () => {
    expect(ukT('pubs.uk' as keyof Messages, { count: 0 })).toBe('пабів у маршруті: 0');
  });

  test('EN selects "one" for count = 1', () => {
    expect(enT('pubs.en' as keyof Messages, { count: 1 })).toBe('1 pub on the route');
  });

  test('EN selects "other" for count = 3', () => {
    expect(enT('pubs.en' as keyof Messages, { count: 3 })).toBe('3 pubs on the route');
  });

  test('falls back to "other" when the selected form is missing', () => {
    const partial = {
      'partial': { other: 'fallback' },
    } as unknown as Messages;
    const t = makeTranslatorFromDict('uk', partial);
    expect(t('partial' as keyof Messages, { count: 1 })).toBe('fallback');
  });

  test('falls back to "other" when params is undefined', () => {
    expect(ukT('pubs.uk' as keyof Messages, undefined)).toBe('пабів у маршруті: {count}');
  });

  test('falls back to "other" when count is not a number (interpolation still runs)', () => {
    expect(ukT('pubs.uk' as keyof Messages, { count: 'three' as unknown as number })).toBe(
      'пабів у маршруті: three',
    );
  });
});
