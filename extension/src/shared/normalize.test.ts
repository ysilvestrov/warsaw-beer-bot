import { describe, it, expect } from 'vitest';
import { normalizeKey } from './normalize';

describe('normalizeKey', () => {
  it('lowercases, strips diacritics and punctuation, collapses spaces', () => {
    expect(normalizeKey('PINTA', 'Hazy  Morning!')).toBe('pinta|hazy morning');
  });

  it('removes Polish diacritics', () => {
    expect(normalizeKey('Zakładowy', 'Pełne')).toBe('zakladowy|pelne');
  });

  it('is stable across surrounding whitespace', () => {
    expect(normalizeKey('  PINTA ', ' Hazy Morning ')).toBe('pinta|hazy morning');
  });

  it('keeps a non-Latin mark outside U+0300–036F as a separator between Latin letters', () => {
    expect(normalizeKey('Example', 'A᪰B')).toBe('example|a b');
  });

  it('gives an empty half for empty or punctuation-only input', () => {
    expect(normalizeKey('', '—')).toBe('|');
  });

  // #994
  it('keeps Cyrillic, so two beers of one Cyrillic brewery get different keys', () => {
    expect([normalizeKey('Ципа', 'Орєнтал'), normalizeKey('Ципа', 'з огірками')])
      .toEqual(['ципа|орєнтал', 'ципа|з огірками']);
  });

  it('keeps the Cyrillic words of a mixed-script name', () => {
    expect(normalizeKey('JAGER', 'Hazy АРА')).toBe('jager|hazy ара');
  });

  it('lowercases Ukrainian capitals', () => {
    expect(normalizeKey('JAGER', 'БОГЕМНИЙ МІЦИК ІРА')).toBe('jager|богемний міцик іра');
  });

  it('keeps й, ї, ё, ґ as single letters, so Мій and Мии stay apart', () => {
    expect([
      normalizeKey('Мій', 'Мии'),
      normalizeKey('Їжак', 'Ґазда'),
      normalizeKey('Ёлка', ''),
    ]).toEqual(['мій|мии', 'їжак|ґазда', 'ёлка|']);
  });

  it('drops a stress accent on a Cyrillic letter', () => {
    expect(normalizeKey('', 'за́мок')).toBe('|замок');
  });

  it('treats a Cyrillic combining mark as a separator', () => {
    expect(normalizeKey('', 'ми҃р')).toBe('|ми р');
  });

  it('treats a Cyrillic-script symbol as a separator, keeping only letters', () => {
    expect(normalizeKey('', 'мир҂')).toBe('|мир');
  });
});
