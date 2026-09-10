import { createTranslator } from './index';
import { uk } from './locales/uk';
import { pl } from './locales/pl';
import { en } from './locales/en';

describe('locale completeness', () => {
  // tsc already enforces this today: each locale is a fresh object literal annotated
  // `: Messages`, so assignability catches a missing key and the excess-property check
  // catches an extra one; even without the annotation, `LOCALES: Record<Locale, Messages>`
  // in ./index.ts still catches a missing key. This test is not the completeness
  // guarantee — it is the tripwire for the ways that static check can be silently lost:
  // a key made optional in `Messages`, a locale built via spread or `as Messages`
  // (freshness gone, so extra keys stop erroring), or a computed key.
  test('uk, pl, en carry exactly the same message keys', () => {
    const ukKeys = Object.keys(uk).sort();
    const plKeys = Object.keys(pl).sort();
    const enKeys = Object.keys(en).sort();
    expect(plKeys).toEqual(ukKeys);
    expect(enKeys).toEqual(ukKeys);
  });
});

describe('extension.mcp placeholder', () => {
  // A translator who writes {link} or drops the placeholder entirely ships a literal
  // "{link}" — or a sentence promising a guide with no link in it — straight to users,
  // and nothing else in the suite would catch it (the fake Translator in
  // extension.test.ts can't see the real locale strings).
  test('the real uk, pl, en strings all carry the {url} placeholder', () => {
    expect(uk['extension.mcp']).toContain('{url}');
    expect(pl['extension.mcp']).toContain('{url}');
    expect(en['extension.mcp']).toContain('{url}');
  });
});

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

  test('#399 outside-Poland strings resolve in all three locales', () => {
    expect(createTranslator('uk')('city.outside')).toBe('🌍 Поза Польщею');
    expect(createTranslator('pl')('city.outside')).toBe('🌍 Poza Polską');
    expect(createTranslator('en')('city.outside')).toBe('🌍 Outside Poland');
    for (const loc of ['uk', 'pl', 'en'] as const) {
      expect(createTranslator(loc)('city.blocked')).toContain('/city');
      expect(createTranslator(loc)('help.city_hint')).toContain('/city');
    }
  });
});
