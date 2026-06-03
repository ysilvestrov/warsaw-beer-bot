import { COMMAND_CATALOG, buildHelpText, buildCommandMenu } from './catalog';
import { createTranslator } from '../../i18n';
import type { Locale } from '../../i18n/types';

const LOCALES: Locale[] = ['uk', 'pl', 'en'];

describe('buildHelpText', () => {
  test('includes the intro and one line per command, each starting with /command', () => {
    const t = createTranslator('en');
    const text = buildHelpText(t);
    expect(text).toContain(t('help.intro'));
    for (const e of COMMAND_CATALOG) {
      expect(text).toContain(`/${e.command} — ${t(e.descKey)}`);
    }
    const cmdLines = text.split('\n').filter((l) => l.startsWith('/'));
    expect(cmdLines).toHaveLength(COMMAND_CATALOG.length);
  });
});

describe('buildCommandMenu', () => {
  test('one entry per command; lowercase, no slash, <=32 chars; non-empty descriptions', () => {
    const menu = buildCommandMenu(createTranslator('uk'));
    expect(menu).toHaveLength(COMMAND_CATALOG.length);
    for (const c of menu) {
      expect(c.command).toMatch(/^[a-z]+$/);
      expect(c.command.length).toBeLessThanOrEqual(32);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});

describe('catalog translations are complete', () => {
  test('every descKey + help.intro resolve to non-empty, placeholder-free strings in all locales', () => {
    for (const loc of LOCALES) {
      const t = createTranslator(loc);
      expect(t('help.intro').length).toBeGreaterThan(0);
      for (const e of COMMAND_CATALOG) {
        const s = t(e.descKey);
        expect(s.length).toBeGreaterThan(0);
        expect(s).not.toContain('{');
      }
    }
  });
});
