import { matchBeersArraySchema } from './match-input';
import { BEER_TEXT_LIMIT_CHARS } from './middleware/payload-limit';

describe('matchBeersArraySchema (shared with the MCP match_beers tool)', () => {
  it('does not accept a published bid or brand (#633)', () => {
    const parsed = matchBeersArraySchema.parse([{ brewery: 'B', name: 'N', bid: 9001, brand: 'X' }]);
    expect(parsed[0]).toEqual({ brewery: 'B', name: 'N' });
  });

  it('still takes the fields the MCP tool sends', () => {
    expect(matchBeersArraySchema.parse([{ brewery: 'B', name: 'N', abv: 5 }])[0].abv).toBe(5);
  });

  it('rejects an empty array (min 1)', () => {
    expect(() => matchBeersArraySchema.parse([])).toThrow();
  });

  it('accepts up to 200 items and rejects 201 items', () => {
    const batch200 = Array.from({ length: 200 }, () => ({ brewery: 'B', name: 'N' }));
    expect(matchBeersArraySchema.parse(batch200)).toHaveLength(200);

    const batch201 = Array.from({ length: 201 }, () => ({ brewery: 'B', name: 'N' }));
    expect(() => matchBeersArraySchema.parse(batch201)).toThrow();
  });

  it('rejects brewery or name exceeding BEER_TEXT_LIMIT_CHARS', () => {
    const tooLong = 'x'.repeat(BEER_TEXT_LIMIT_CHARS + 1);
    expect(() => matchBeersArraySchema.parse([{ brewery: tooLong, name: 'N' }])).toThrow();
    expect(() => matchBeersArraySchema.parse([{ brewery: 'B', name: tooLong }])).toThrow();

    const maxAllowed = 'x'.repeat(BEER_TEXT_LIMIT_CHARS);
    expect(matchBeersArraySchema.parse([{ brewery: maxAllowed, name: maxAllowed }])[0]).toEqual({
      brewery: maxAllowed,
      name: maxAllowed,
    });
  });

  it('rejects missing brewery or missing name', () => {
    expect(() => matchBeersArraySchema.parse([{ name: 'N' } as any])).toThrow();
    expect(() => matchBeersArraySchema.parse([{ brewery: 'B' } as any])).toThrow();
  });

  it('rejects non-numeric abv', () => {
    expect(() => matchBeersArraySchema.parse([{ brewery: 'B', name: 'N', abv: '5' as any }])).toThrow();
  });
});

