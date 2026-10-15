import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMcpBeer } from './mcp-beer';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';

// A live get_beer answer (2026-10-15, beerId 6134008), cut to the fields around the ones read.
const BODY = readFileSync(join(__dirname, '__fixtures__/mcp-get-beer.json'), 'utf8');
const asTool = (text: string, isError = false) => ({ isError, content: [{ type: 'text', text }] });

describe('parseMcpBeer', () => {
  it('reads the beer the catalogue needs from a live answer', () => {
    expect(parseMcpBeer(asTool(BODY))).toEqual({
      untappd_id: 6134008,
      name: 'Hop Selection: Motueka',
      brewery: 'PINTA',
      style: 'IPA - New England / Hazy',
      abv: 6.5,
      rating_global: 4.02203,
      normalized_name: normalizeName('Hop Selection: Motueka'),
      normalized_brewery: normalizeBrewery('PINTA'),
      untappd_id_source: 'checkin',
    });
  });

  it('a 0 rating is no rating, and missing style and ABV are null', () => {
    const body = JSON.parse(BODY);
    body.beer.rating_score = 0;
    delete body.beer.beer_style;
    delete body.beer.beer_abv;
    expect(parseMcpBeer(asTool(JSON.stringify(body)))).toMatchObject({ rating_global: null, style: null, abv: null });
  });

  it('is null for a tool error, text that is not JSON, a beer without a brewery and no content', () => {
    const body = JSON.parse(BODY);
    delete body.beer.brewery;
    expect([
      parseMcpBeer(asTool(BODY, true)),
      parseMcpBeer(asTool('not json')),
      parseMcpBeer(asTool(JSON.stringify(body))),
      parseMcpBeer({ content: [] }),
    ]).toEqual([null, null, null, null]);
  });
});
