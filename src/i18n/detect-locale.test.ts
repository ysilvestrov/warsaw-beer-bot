import { detectLocale } from './detect-locale';

describe('detectLocale', () => {
  test.each([
    ['uk',     'uk'],
    ['uk-UA',  'uk'],
    ['UK',     'uk'],
    ['pl',     'pl'],
    ['pl-PL',  'pl'],
    ['en',     'en'],
    ['en-US',  'en'],
    ['en-GB',  'en'],
    // Belarusian goes to en in Phase 1; will return 'be' once Phase 3 ships.
    ['be',     'en'],
    ['be-BY',  'en'],
    // Russian explicitly maps to en — we don't impose UA on ru-locale users.
    ['ru',     'en'],
    ['ru-RU',  'en'],
    ['de',     'en'],
    ['fr',     'en'],
    ['',       'en'],
    [undefined,'en'],
  ])('%s → %s', (input, expected) => {
    expect(detectLocale(input as string | undefined)).toBe(expected);
  });
});
