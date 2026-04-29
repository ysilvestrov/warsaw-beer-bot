import { createTranslator } from './index';

describe('createTranslator', () => {
  test('uk resolves Ukrainian strings', () => {
    const t = createTranslator('uk');
    expect(t('newbeers.empty')).toBe('Нічого цікавого — спробуй /refresh.');
    expect(t('refresh.done')).toBe('✅ Готово.');
  });

  test('pl resolves Polish strings', () => {
    const t = createTranslator('pl');
    expect(t('newbeers.empty')).toBe('Nic ciekawego — spróbuj /refresh.');
    expect(t('refresh.done')).toBe('✅ Gotowe.');
  });

  test('en resolves English strings', () => {
    const t = createTranslator('en');
    expect(t('newbeers.empty')).toBe('Nothing interesting — try /refresh.');
    expect(t('refresh.done')).toBe('✅ Done.');
  });

  test('interpolates parameters in uk', () => {
    const t = createTranslator('uk');
    expect(t('link.success', { username: 'yuriy' })).toBe(
      "✅ Прив'язано до untappd.com/user/yuriy",
    );
  });

  test('interpolates parameters in pl', () => {
    const t = createTranslator('pl');
    expect(t('link.success', { username: 'yuriy' })).toBe(
      '✅ Powiązano z untappd.com/user/yuriy',
    );
  });

  test('interpolates parameters in en', () => {
    const t = createTranslator('en');
    expect(t('link.success', { username: 'yuriy' })).toBe(
      '✅ Linked to untappd.com/user/yuriy',
    );
  });

  test('lang.changed uses {name} param across all locales', () => {
    expect(createTranslator('uk')('lang.changed', { name: 'Polski' })).toBe(
      '✅ Мову змінено на Polski.',
    );
    expect(createTranslator('pl')('lang.changed', { name: 'Українська' })).toBe(
      '✅ Zmieniono język na Українська.',
    );
    expect(createTranslator('en')('lang.changed', { name: 'English' })).toBe(
      '✅ Language switched to English.',
    );
  });
});
