import { lookupBeer } from './untappd-lookup';
import { HttpError } from '../sources/http';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';

function fakeSearch(fn: (q: string) => SearchResult[] | Promise<SearchResult[]>): BeerSearch {
  return { search: async (q) => fn(q) };
}
function throwingSearch(err: unknown): BeerSearch {
  return { search: async () => { throw err; } };
}

describe('lookupBeer', () => {
  test('matched: brewery overlaps + name fuzzy >= 0.85 returns best result', async () => {
    const search = fakeSearch(() => [
      { bid: 5000, beer_name: 'Fifty / Fifty - Pineapple', brewery_name: 'Magic Road', style: 'IPA', abv: 5, global_rating: 3.5 },
      { bid: 5001, beer_name: 'Fifty / Fifty Clementine & Passionfruit', brewery_name: 'Magic Road', style: 'IPA', abv: 5, global_rating: 3.98 },
    ]);
    const out = await lookupBeer({
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      search,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(5001);
    expect(out.result.global_rating).toBe(3.98);
  });

  test('not_found: brewery hard-gate filters every candidate', async () => {
    const search = fakeSearch(() => [
      { bid: 9000, beer_name: 'Fifty/Fifty Clementine & Passionfruit', brewery_name: 'Some Other Brewery', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      search,
    });
    expect(out.kind).toBe('not_found');
  });

  test('matched: token-prefix gate accepts official-suffix brewery', async () => {
    // Candidate brewery has extra non-noise tokens ("craft beer") that the
    // old exact-equality gate would reject; only the token-prefix gate passes.
    const search = fakeSearch(() => [
      { bid: 6620595, beer_name: 'Buzdygan Rozkoszy', brewery_name: 'Harpagan Craft Beer', style: 'IPA', abv: 5, global_rating: 3.5 },
      { bid: 3240662, beer_name: 'Buzdygan Rozkoszy Rum BA', brewery_name: 'Harpagan Craft Beer', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({
      brewery: 'Harpagan Brewery',
      name: 'Buzdygan Rozkoszy',
      search,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6620595);
  });

  test('matched: ABV breaks name-fuzzy ties between same-brand vintages', async () => {
    // normalizeName strips the year, so both names collapse to "buzdygan
    // rozkoszy" and tie at score 1.0. Untappd returns the 9.8% 2026 vintage
    // first; only the ABV tiebreak should pull the 8.5% entry the tap shows.
    const search = fakeSearch(() => [
      { bid: 6620595, beer_name: 'Buzdygan Rozkoszy 2026', brewery_name: 'Harpagan Craft Beer', style: 'IPA', abv: 9.8, global_rating: 3.5 },
      { bid: 2388534, beer_name: 'Buzdygan Rozkoszy', brewery_name: 'Harpagan Contracts', style: 'IPA', abv: 8.5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({
      brewery: 'Harpagan Brewery',
      name: 'Buzdygan Rozkoszy',
      abv: 8.5,
      search,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(2388534);
  });

  test('not_found: brewery passes hard-gate but every name is below 0.85 fuzzy', async () => {
    const search = fakeSearch(() => [
      { bid: 9000, beer_name: 'Atak Chmielu IPA', brewery_name: 'Magic Road', style: 'IPA', abv: 5, global_rating: 3.5 },
      { bid: 9001, beer_name: 'Buty Skejta Pils', brewery_name: 'Magic Road', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      search,
    });
    expect(out.kind).toBe('not_found');
  });

  test('transient: search throws → kind=transient with the error captured', async () => {
    const boom = new Error('ETIMEDOUT');
    const out = await lookupBeer({
      brewery: 'Magic Road',
      name: 'Fifty/Fifty',
      search: throwingSearch(boom),
    });
    expect(out.kind).toBe('transient');
    if (out.kind !== 'transient') return;
    expect(out.error).toBe(boom);
  });

  test('empty search results return not_found', async () => {
    const out = await lookupBeer({
      brewery: 'Magic Road',
      name: 'Fifty/Fifty',
      search: fakeSearch(() => []),
    });
    expect(out.kind).toBe('not_found');
  });

  test('strips brewery noise word from the search query', async () => {
    const calledQueries: string[] = [];
    const search = fakeSearch((q) => {
      calledQueries.push(q);
      return [{ bid: 6172039, beer_name: 'WOCKY TALKY', brewery_name: 'JBW Browar', style: 'IPA', abv: 5, global_rating: 3.18 }];
    });
    const out = await lookupBeer({ brewery: 'JBW Brewery', name: 'Wocky Talky', search });

    expect(calledQueries[0]).toContain('JBW');
    expect(calledQueries[0]).toContain('Wocky');
    expect(calledQueries[0]).not.toContain('Brewery');

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6172039);
  });

  test('non-collab brewery: single search call (behaviour unchanged)', async () => {
    const calledQueries: string[] = [];
    const search = fakeSearch((q) => {
      calledQueries.push(q);
      return [{ bid: 1, beer_name: 'Fifty/Fifty', brewery_name: 'Magic Road', style: 'IPA', abv: 5, global_rating: 3.5 }];
    });
    await lookupBeer({ brewery: 'Magic Road Brewery', name: 'Fifty/Fifty', search });
    expect(calledQueries).toHaveLength(1);
    expect(calledQueries[0]).toContain('Magic');
    expect(calledQueries[0]).toContain('Road');
    expect(calledQueries[0]).not.toContain('Brewery');
  });

  test('slash collab: first part returns 0 results, second part matches', async () => {
    const calledQueries: string[] = [];
    const search = fakeSearch((q) => {
      calledQueries.push(q);
      if (q.includes('TankBusters')) return [];
      return [{ bid: 7777, beer_name: 'S.M.O.K.E.', brewery_name: 'TankBusters / Blech.Brut', style: 'IPA', abv: 5, global_rating: 3.5 }];
    });
    const out = await lookupBeer({
      brewery: 'TankBusters/Blech.Brut/Yeast Side Labs Brewery',
      name: 'S.M.O.K.E.',
      search,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(7777);
    expect(calledQueries).toHaveLength(2);
    expect(calledQueries[0]).toContain('TankBusters');
    expect(calledQueries[1]).toContain('Blech');
  });

  test('x-connector collab: first part finds the beer', async () => {
    const calledQueries: string[] = [];
    const search = fakeSearch((q) => {
      calledQueries.push(q);
      return [{ bid: 8888, beer_name: 'NOT YOUR MILKSHAKE', brewery_name: 'Ziemia Obiecana', style: 'IPA', abv: 5, global_rating: 3.5 }];
    });
    const out = await lookupBeer({
      brewery: 'ZIEMIA OBIECANA x Weźże Krafta Brewery',
      name: 'NOT YOUR MILKSHAKE',
      search,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(8888);
    expect(calledQueries).toHaveLength(1);
    expect(calledQueries[0]).toContain('ZIEMIA');
  });

  test('collab: transient on any part short-circuits immediately', async () => {
    const boom = new Error('ETIMEDOUT');
    let callCount = 0;
    const search: BeerSearch = { search: async () => { callCount++; throw boom; } };
    const out = await lookupBeer({
      brewery: 'TankBusters/Blech.Brut Brewery',
      name: 'S.M.O.K.E.',
      search,
    });
    expect(out.kind).toBe('transient');
    if (out.kind !== 'transient') return;
    expect(out.error).toBe(boom);
    expect(callCount).toBe(1);
  });

  test('blocked: HttpError 403 → blocked (not transient)', async () => {
    const out = await lookupBeer({ brewery: 'X', name: 'Y', search: throwingSearch(new HttpError(403, 'u')) });
    expect(out.kind).toBe('blocked');
  });

  test('blocked: HttpError 429 → blocked (not transient)', async () => {
    // block-page detection has moved to the transport layer (BeerSearch impl);
    // both 403 and 429 are covered by isBlockStatus
    const out = await lookupBeer({ brewery: 'X', name: 'Y', search: throwingSearch(new HttpError(429, 'u')) });
    expect(out.kind).toBe('blocked');
  });

  describe('diagnostics (orphan logging)', () => {
    test('not_found returns the tried search URL(s) and parsed candidates', async () => {
      const search = fakeSearch(() => [
        { bid: 1, beer_name: 'Atak Chmielu', brewery_name: 'Magic Road', style: 'IPA', abv: 5, global_rating: 3.5 },
      ]);
      const out = await lookupBeer({ brewery: 'Magic Road', name: 'Totally Different Beer', search });
      expect(out.kind).toBe('not_found');
      if (out.kind !== 'not_found') return;
      expect(out.searchUrls[0]).toContain('Magic%20Road');
      expect(out.candidates.map((c) => c.beer_name)).toContain('Atak Chmielu');
    });

    test('not_found with zero results returns empty candidates', async () => {
      const out = await lookupBeer({ brewery: 'Magic Road', name: 'Whatever', search: fakeSearch(() => []) });
      expect(out.kind).toBe('not_found');
      if (out.kind !== 'not_found') return;
      expect(out.candidates).toEqual([]);
      expect(out.searchUrls.length).toBeGreaterThan(0);
    });

    test('blocked returns the search URL that tripped the block', async () => {
      const out = await lookupBeer({ brewery: 'Magic Road', name: 'X', search: throwingSearch(new HttpError(403, 'u')) });
      expect(out.kind).toBe('blocked');
      if (out.kind !== 'blocked') return;
      expect(out.searchUrl).toContain('Magic%20Road');
    });
  });

  describe('name-keys stage (#117)', () => {
    test('matched: reordered name (below fuzzy 0.85) via key intersection', async () => {
      const search = fakeSearch(() => [
        { bid: 11827, beer_name: 'Festweisse (TAP04)', brewery_name: 'Schneider Weisse G. Schneider & Sohn', style: 'IPA', abv: 5, global_rating: 3.5 },
      ]);
      const out = await lookupBeer({ brewery: 'Schneider', name: 'TAP04 FESTWEISSE', search });
      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(11827);
    });

    test('matched: collab partner in input name → base-beer key hit', async () => {
      const search = fakeSearch(() => [
        { bid: 6683161, beer_name: 'Fast Talking', brewery_name: 'Root + Branch Brewing', style: 'IPA', abv: 5, global_rating: 3.5 },
      ]);
      const out = await lookupBeer({ brewery: 'Root + Branch', name: 'Fast Talking / North Park', search });
      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(6683161);
    });

    test('not_found: single-token name with no fuzzy hit stays not_found', async () => {
      const search = fakeSearch(() => [
        { bid: 1, beer_name: 'Totally Different', brewery_name: 'Root + Branch', style: 'IPA', abv: 5, global_rating: 3.5 },
      ]);
      const out = await lookupBeer({ brewery: 'Root + Branch', name: 'Hazy', search });
      expect(out.kind).toBe('not_found');
    });
  });

  describe('fuzzy target normalization (#137)', () => {
    test('matched: strips duplicated brewery before fuzzy matching candidate names', async () => {
      const search = fakeSearch(() => [
        { bid: 7201, beer_name: 'Nealko', brewery_name: 'Rohozec', style: 'IPA', abv: 5, global_rating: 3.5 },
      ]);
      const out = await lookupBeer({
        brewery: 'Rohozec Brewery',
        name: 'Rohozec Nealko',
        search,
      });
      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(7201);
    });

    test('matched: fuzzy-checks each single-token collab side when name keys are weak', async () => {
      const search = fakeSearch(() => [
        { bid: 7202, beer_name: 'Lièvre', brewery_name: 'Nano Cinco', style: 'IPA', abv: 5, global_rating: 3.5 },
      ]);
      const out = await lookupBeer({
        brewery: 'Nano Cinco',
        name: 'Lièvre / Slake',
        search,
      });
      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(7202);
    });

    test('not_found: single-token collab side does not fuzzy-match a longer variant', async () => {
      const search = fakeSearch(() => [
        { bid: 7203, beer_name: 'Lièvre Rouge', brewery_name: 'Nano Cinco', style: 'IPA', abv: 5, global_rating: 3.5 },
      ]);
      const out = await lookupBeer({
        brewery: 'Nano Cinco',
        name: 'Lièvre / Slake',
        search,
      });
      expect(out.kind).toBe('not_found');
    });
  });

  test('matched: empty input brewery → exact name bypasses gate (#149)', async () => {
    const search = fakeSearch(() => [
      { bid: 22540, beer_name: 'St-Feuillien Blonde', brewery_name: 'Brasserie St-Feuillien', style: 'IPA', abv: 5, global_rating: 3.5 },
      { bid: 999, beer_name: 'Bière Léon', brewery_name: 'Chez Léon 1893', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: '', name: 'St-Feuillien Blonde', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(22540);
  });

  test('matched: contained (trailing) brewery token + exact name (#120)', async () => {
    const search = fakeSearch(() => [
      { bid: 1673808, beer_name: 'Kultowe Pils', brewery_name: 'Kultowy Browar Staropolski', style: 'IPA', abv: 5, global_rating: 3.5 },
      { bid: 2, beer_name: 'Rodowite Pils', brewery_name: 'Kultowy Browar Staropolski', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Staropolski', name: 'KULTOWE PILS', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1673808);
  });

  test('not_found: relaxed brewery + approximate (not exact) name is NOT fuzzy-matched (#120 FP guard)', async () => {
    // fuzzy('imperial stout reserve','imperial stout reserva') = 0.955, but the brewery
    // only matches via the relaxed contained-token path, so an EXACT name is required.
    const search = fakeSearch(() => [
      { bid: 77, beer_name: 'Imperial Stout Reserva', brewery_name: 'Kultowy Browar Staropolski', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Staropolski', name: 'Imperial Stout Reserve', search });
    expect(out.kind).toBe('not_found');
  });

  test('not_found: empty brewery + different name → no match (#149 FP guard)', async () => {
    const search = fakeSearch(() => [
      { bid: 5, beer_name: 'Completely Different Beer', brewery_name: 'Some Brewery', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: '', name: 'St-Feuillien Blonde', search });
    expect(out.kind).toBe('not_found');
  });

  test('matched: brand-as-beer-name — input brewery sits in candidate beer name, exact name (#138B)', async () => {
    const search = fakeSearch(() => [
      { bid: 5932, beer_name: "Murphy's Irish Stout", brewery_name: 'Heineken Ireland', style: 'IPA', abv: 5, global_rating: 3.5 },
      { bid: 2, beer_name: "Mike Murphy's Irish Stout", brewery_name: 'Northville', style: 'IPA', abv: 5, global_rating: 3.5 },
      { bid: 3, beer_name: 'Murphys Dry Irish Stout', brewery_name: 'Great Barn', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: "Murphy's Brewery", name: "Murphy's Irish Stout", search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(5932);
  });

  test('not_found: brand in candidate name but the name differs (#138B FP guard)', async () => {
    const search = fakeSearch(() => [
      { bid: 2, beer_name: "Mike Murphy's Irish Stout", brewery_name: 'Northville', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: "Murphy's Brewery", name: "Murphy's Irish Stout", search });
    expect(out.kind).toBe('not_found');
  });

  test('not_found: brand token absent from all candidate beer names → brandPool empty (#138B FP guard)', async () => {
    const search = fakeSearch(() => [
      { bid: 9, beer_name: 'Atak Chmielu', brewery_name: 'Some Other Brewery', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Pinta', name: 'Atak Chmielu', search });
    expect(out.kind).toBe('not_found');
  });

  describe('shared structural-noise normalization (#269)', () => {
    test.each([
      { bid: 30278, brewery: 'NEPOMUCEN', input: 'Nonalco Matcha IPA (puszka)', candidate: 'Nonalco Matcha IPA' },
      { bid: 30277, brewery: 'Browar Stu Mostów', input: 'Free Pan Da (puszka)', candidate: 'Free Pan Da' },
      { bid: 30276, brewery: 'Browar Stu Mostów', input: 'Ole! (puszka)', candidate: 'Ole!' },
      { bid: 30294, brewery: 'StarKraft', input: 'Jubilance (Pure Bedlam Collab)', candidate: 'Jubilance' },
    ])('matched: noisy input resolves to clean candidate $bid', async ({ bid, brewery, input, candidate }) => {
      const search = fakeSearch(() => [
        { bid, beer_name: candidate, brewery_name: brewery, style: 'IPA', abv: 5, global_rating: 3.5 },
      ]);

      const out = await lookupBeer({ brewery, name: input, search });

      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(bid);
    });

    test('matched: NoLo Hemperor passes the existing bilingual brewery gate (12082)', async () => {
      const search = fakeSearch(() => [
        {
          bid: 12082,
          beer_name: 'NoLo – Hemperor',
          brewery_name: 'Piwne Podziemie / Beer Underground',
          style: 'Non-Alcoholic Beer',
          abv: 0.5,
          global_rating: 3.5,
        },
      ]);

      const out = await lookupBeer({
        brewery: 'Piwne Podziemie Brewery',
        name: 'NoLo – Hemperor <0,5% alc <0,5%',
        search,
      });

      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(12082);
    });
  });

  describe('reviewed matcher near-misses (#234)', () => {
    test.each([
      {
        brewery: 'Umanpivo Brewery',
        name: 'Waissburg Blanche',
        candidate: { bid: 31202, beer_name: 'Waissburg Blanche', brewery_name: 'Уманьпиво', style: 'Witbier', abv: 5, global_rating: 3.5 },
      },
      {
        brewery: 'Grimbergen Brewery',
        name: 'Blanche',
        candidate: { bid: 31278, beer_name: 'Grimbergen Blanche', brewery_name: 'Brouwerij Alken-Maes', style: 'Witbier', abv: 6, global_rating: 3.5 },
      },
      {
        brewery: 'Wroclove Brewery',
        name: 'Dunkel',
        candidate: { bid: 31297, beer_name: 'Wroclove Dunkel 13.5', brewery_name: 'Browar Witnica', style: 'Dunkel', abv: 5.3, global_rating: 3.5 },
      },
      {
        brewery: 'NAPOMUCEN Brewery',
        name: 'LABIRYNT',
        candidate: { bid: 31262, beer_name: 'Labirynth', brewery_name: 'Nepo Brewing', style: 'IPA', abv: 6, global_rating: 3.5 },
      },
      {
        brewery: 'Pivovar Poutnik Brewery',
        name: 'Pilhrimov',
        candidate: { bid: 31271, beer_name: 'Poutník Světlý ležák Premium 12°', brewery_name: 'Pivovar Pelhřimov', style: 'Lager', abv: 5, global_rating: 3.5 },
      },
      {
        brewery: 'Brauerei Knoblach Brewery',
        name: 'Pfingstoffla',
        candidate: { bid: 30902, beer_name: 'Pfingststöffla', brewery_name: 'Brauerei Knoblach Schammelsdorf', style: 'Lager', abv: 5, global_rating: 3.5 },
      },
      {
        brewery: 'Brauerei Knoblach Schammelsdorf Brewery',
        name: 'Lagerbier ungespundet',
        candidate: { bid: 31165, beer_name: 'Schammelsdorfer Lagerbier', brewery_name: 'Brauerei Knoblach Schammelsdorf', style: 'Lager', abv: 5, global_rating: 3.5 },
      },
      {
        brewery: 'Cydr z Mazowsza Brewery',
        name: 'Cydr jabłkowy',
        candidate: { bid: 31347, beer_name: 'Jabłkowy cydr z Mazowsza', brewery_name: 'Cydr z Mazowsza', style: 'Cider', abv: 5, global_rating: 3.5 },
      },
      {
        brewery: 'NEPO Brewing Brewery',
        name: 'Tropical Wave',
        candidate: { bid: 31531, beer_name: 'TropiCool Wave Oaza Garden', brewery_name: 'Nepo Brewing', style: 'IPA', abv: 6.5, global_rating: 3.5 },
      },
      {
        brewery: 'Jeżek Kwaśnicowy Brewery',
        name: 'Jeżek kwasnicowy',
        candidate: { bid: 494, beer_name: 'Ježek Kvasnicový', brewery_name: 'Pivovar Jihlava', style: 'Lager', abv: 4.8, global_rating: 3.5 },
      },
    ])('matched: reviewed near candidate $candidate.bid', async ({ brewery, name, candidate }) => {
      const out = await lookupBeer({ brewery, name, search: fakeSearch(() => [candidate]) });
      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(candidate.bid);
    });
  });
});
