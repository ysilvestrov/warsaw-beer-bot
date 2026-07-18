import { describe, it, expect } from 'vitest';
import { FLASKER_BREWERIES } from './flasker-breweries.generated';

describe('FLASKER_BREWERIES registry', () => {
  it('is a non-empty list of well-formed entries', () => {
    expect(FLASKER_BREWERIES.length).toBeGreaterThanOrEqual(49);
    for (const b of FLASKER_BREWERIES) {
      expect(b.match.length).toBeGreaterThan(0);
      expect(b.match.every((m) => m.trim().length > 0)).toBe(true);
      expect(b.canonical.trim().length).toBeGreaterThan(0);
    }
  });

  it('has unique, case-insensitive match forms across the registry', () => {
    const seen = new Set<string>();
    for (const b of FLASKER_BREWERIES) {
      for (const m of b.match) {
        const key = m.toLowerCase();
        expect(seen.has(key), `duplicate match form: ${m}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('excludes the 5 curated-rule breweries', () => {
    const forms = new Set(FLASKER_BREWERIES.flatMap((b) => b.match.map((m) => m.toLowerCase())));
    for (const curated of ['mad brew', 'copper head', 'flasker', 'hoppy hog']) {
      expect(forms.has(curated), `${curated} must be handled by the curated rule, not the registry`).toBe(false);
    }
  });
});
