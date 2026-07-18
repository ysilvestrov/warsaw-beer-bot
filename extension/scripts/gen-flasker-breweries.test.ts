import { describe, it, expect } from 'vitest';
import { buildRegistryEntries } from './gen-flasker-breweries';

describe('buildRegistryEntries', () => {
  it('drops non-brewery sections and the curated 5, applies overrides, decodes entities, sorts', () => {
    const raw = [
      'Оболонь', 'Copper Head', 'Імпортне пиво', 'Bench Cafe Brewing',
      'KLB', 'Mad Brew', "П&#039;Ю ПЕРШИЙ", 'НАБОРИ І КОЛАБИ', 'Gold Fish',
    ];
    const out = buildRegistryEntries(raw);
    const byMatch = Object.fromEntries(out.map((e) => [e.match[0], e]));

    for (const gone of ['Імпортне пиво', 'НАБОРИ І КОЛАБИ', 'Copper Head', 'Mad Brew']) {
      expect(out.find((e) => e.match.includes(gone))).toBeUndefined();
    }
    expect(byMatch['Оболонь'].canonical).toBe('Obolon');
    expect(byMatch['KLB'].canonical).toBe('Kyiv Local Brewery');
    expect(out.find((e) => e.match[0] === "П'Ю ПЕРШИЙ")).toBeDefined();
    expect(byMatch['Gold Fish'].match).toContain('GoldFish');
    expect(byMatch['Bench Cafe Brewing'].canonical).toBe('Bench Cafe Brewing');
    const forms = out.map((e) => e.match[0]);
    expect(forms).toEqual([...forms].sort((a, b) => a.localeCompare(b)));
  });
});
