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
    expect(normalizeKey('  PINTA ', ' Hazy Morning ')).toBe(normalizeKey('PINTA', 'Hazy Morning'));
  });
});
