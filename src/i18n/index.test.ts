import { createTranslator } from './index';

describe('createTranslator', () => {
  test('returns a translator that resolves uk strings for locale=uk', () => {
    const t = createTranslator('uk');
    expect(t('newbeers.empty')).toBe('Нічого цікавого — спробуй /refresh.');
    expect(t('refresh.done')).toBe('✅ Готово.');
  });

  // PR 1 placeholder: pl + en aliases point at the uk dict because real
  // translations land in PR 2. This test pins the placeholder behavior so
  // PR 2 must update both the LOCALES map and this expectation — preventing
  // a silent ship of "supposedly Polish bot still speaks Ukrainian".
  test('pl alias resolves uk strings (placeholder — update in PR 2)', () => {
    const t = createTranslator('pl');
    expect(t('newbeers.empty')).toBe('Нічого цікавого — спробуй /refresh.');
  });

  test('en alias resolves uk strings (placeholder — update in PR 2)', () => {
    const t = createTranslator('en');
    expect(t('newbeers.empty')).toBe('Нічого цікавого — спробуй /refresh.');
  });

  test('interpolates parameters', () => {
    const t = createTranslator('uk');
    expect(t('link.success', { username: 'yuriy' })).toBe(
      "✅ Прив'язано до untappd.com/user/yuriy",
    );
  });
});
