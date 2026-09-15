import { matchBeersArraySchema } from './match-input';

describe('matchBeersArraySchema (shared with the MCP match_beers tool)', () => {
  it('does not accept a published bid or brand (#633)', () => {
    const parsed = matchBeersArraySchema.parse([{ brewery: 'B', name: 'N', bid: 9001, brand: 'X' }]);
    expect(parsed[0]).toEqual({ brewery: 'B', name: 'N' });
  });

  it('still takes the fields the MCP tool sends', () => {
    expect(matchBeersArraySchema.parse([{ brewery: 'B', name: 'N', abv: 5 }])[0].abv).toBe(5);
  });
});
