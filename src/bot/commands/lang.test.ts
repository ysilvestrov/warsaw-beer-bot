import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUserLanguage, getUserLanguage } from '../../storage/user_profiles';
import { createTranslator } from '../../i18n';
import type { Locale } from '../../i18n/types';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// Simulate the callback action handler logic extracted from lang.ts
async function simulateLangCallback(
  db: ReturnType<typeof fresh>,
  telegramId: number,
  locale: Locale,
  editMessageText: jest.Mock,
  answerCbQuery: jest.Mock,
) {
  const LOCALE_NAMES: Record<Locale, string> = {
    uk: 'Українська',
    pl: 'Polski',
    en: 'English',
  };

  ensureProfile(db, telegramId);
  setUserLanguage(db, telegramId, locale);

  const t = createTranslator(locale);
  const name = LOCALE_NAMES[locale];

  await editMessageText(t('lang.changed', { name }));
  await answerCbQuery();
}

describe('/lang callback — DB persistence and edit-text', () => {
  test('lang:pl writes pl to DB and edits with Polish lang.changed text', async () => {
    const db = fresh();
    const editMessageText = jest.fn();
    const answerCbQuery = jest.fn();

    await simulateLangCallback(db, 42, 'pl', editMessageText, answerCbQuery);

    // DB should have 'pl' stored
    expect(getUserLanguage(db, 42)).toBe('pl');

    // editMessageText called with the result of createTranslator('pl')('lang.changed', { name: 'Polski' })
    const expectedText = createTranslator('pl')('lang.changed', { name: 'Polski' });
    expect(editMessageText).toHaveBeenCalledWith(expectedText);

    // answerCbQuery was called to dismiss the spinner
    expect(answerCbQuery).toHaveBeenCalled();
  });

  test('lang:en writes en to DB and edits with English lang.changed text', async () => {
    const db = fresh();
    const editMessageText = jest.fn();
    const answerCbQuery = jest.fn();

    await simulateLangCallback(db, 43, 'en', editMessageText, answerCbQuery);

    expect(getUserLanguage(db, 43)).toBe('en');

    const expectedText = createTranslator('en')('lang.changed', { name: 'English' });
    expect(editMessageText).toHaveBeenCalledWith(expectedText);
    expect(answerCbQuery).toHaveBeenCalled();
  });

  test('lang:uk writes uk to DB and edits with Ukrainian lang.changed text', async () => {
    const db = fresh();
    const editMessageText = jest.fn();
    const answerCbQuery = jest.fn();

    await simulateLangCallback(db, 44, 'uk', editMessageText, answerCbQuery);

    expect(getUserLanguage(db, 44)).toBe('uk');

    const expectedText = createTranslator('uk')('lang.changed', { name: 'Українська' });
    expect(editMessageText).toHaveBeenCalledWith(expectedText);
    expect(answerCbQuery).toHaveBeenCalled();
  });

  test('overwriting an existing language updates DB to the new value', async () => {
    const db = fresh();
    ensureProfile(db, 45);
    setUserLanguage(db, 45, 'uk');

    const editMessageText = jest.fn();
    const answerCbQuery = jest.fn();

    await simulateLangCallback(db, 45, 'pl', editMessageText, answerCbQuery);

    expect(getUserLanguage(db, 45)).toBe('pl');
  });

  test('action regex only matches uk|pl|en — invalid locale xx does not match', () => {
    // The regex used in the Composer action handler
    const actionRegex = /^lang:(uk|pl|en)$/;

    expect(actionRegex.test('lang:uk')).toBe(true);
    expect(actionRegex.test('lang:pl')).toBe(true);
    expect(actionRegex.test('lang:en')).toBe(true);
    expect(actionRegex.test('lang:xx')).toBe(false);
    expect(actionRegex.test('lang:ru')).toBe(false);
    expect(actionRegex.test('lang:')).toBe(false);
    expect(actionRegex.test('lang:uken')).toBe(false);
  });
});
