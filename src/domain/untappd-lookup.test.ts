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

  test('#271 head-retry: zero candidates + comma/#N tail retries with the head and matches', async () => {
    const search = fakeSearch((q) =>
      q === 'Pinta Fantazja'
        ? [{ bid: 7000, beer_name: 'Fantazja', brewery_name: 'Pinta', style: 'Sour', abv: 5, global_rating: 3.7 }]
        : [],
    );
    const out = await lookupBeer({ brewery: 'Pinta', name: 'Fantazja #1, Pastry Sour z Guavą, Mango', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(7000);
  });

  test('#271: no head-retry when the full query already returned candidates (even if unmatched)', async () => {
    let calls = 0;
    const search = fakeSearch(() => {
      calls++;
      return [{ bid: 9, beer_name: 'Whatever', brewery_name: 'Other Brewery', style: 'IPA', abv: 5, global_rating: 3 }];
    });
    const out = await lookupBeer({ brewery: 'Pinta', name: 'Fantazja #1, Mango', search });
    expect(out.kind).toBe('not_found');
    expect(calls).toBe(1); // brewery gate rejected the candidate; retry must NOT fire
  });

  test('#271: no head-retry for a dash-only tail (excluded delimiter)', async () => {
    let calls = 0;
    const search = fakeSearch(() => { calls++; return []; });
    const out = await lookupBeer({ brewery: 'Pinta', name: 'Imperial Stout - Barrel Aged', search });
    expect(out.kind).toBe('not_found');
    expect(calls).toBe(1); // no comma/#N delimiter → no head-retry
  });

  test('#271: single-retry guard — head-retry does not recurse forever', async () => {
    let calls = 0;
    const search = fakeSearch(() => { calls++; return []; });
    const out = await lookupBeer({ brewery: 'Pinta', name: 'Fantazja, Mango, Guava', search });
    expect(out.kind).toBe('not_found');
    expect(calls).toBe(2); // original pass + exactly one head-retry pass
  });

  test('#321 grade: single same-grade lager candidate (Desitka → Kamenická 10)', async () => {
    const search = fakeSearch(() => [
      { bid: 12141, beer_name: 'Kamenická 10', brewery_name: 'Pivovar Kamenice nad Lipou', style: 'Czech Pale Lager', abv: 4.2, global_rating: 3.3 },
    ]);
    const out = await lookupBeer({ brewery: 'Kamenice nad Lipou Brewery', name: 'Desitka', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(12141);
  });

  test('#321 grade: bare number excludes ale styles (11 → Ležák, not Gose/IPA)', async () => {
    const search = fakeSearch(() => [
      { bid: 1, beer_name: 'Ležák 11%', brewery_name: 'Nachmelená Opice', style: 'Czech Pale Lager', abv: 4.6, global_rating: 3.5 },
      { bid: 2, beer_name: 'Góséčko mango+calamansi 11%', brewery_name: 'Nachmelená Opice', style: 'Gose', abv: 4.6, global_rating: 3.5 },
      { bid: 3, beer_name: 'Session IPA 11%', brewery_name: 'Nachmelená Opice', style: 'IPA - Session', abv: 4.6, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Nachmelená Opice Brewery', name: '11', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1);
  });

  test('#321 grade: fewest-descriptor lager wins over seasonals (Trutnov 11 → plain)', async () => {
    const search = fakeSearch(() => [
      { bid: 30, beer_name: 'Vánoční světlý ležák 11°', brewery_name: 'Krakonoš', style: 'Czech Pale Lager', abv: 4.8, global_rating: 3.5 },
      { bid: 31, beer_name: 'Světlý ležák 11°', brewery_name: 'Krakonoš', style: 'Czech Pale Lager', abv: 4.8, global_rating: 3.6 },
      { bid: 32, beer_name: 'Velikonoční světlý ležák 11°', brewery_name: 'Krakonoš', style: 'Czech Pale Lager', abv: 4.8, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Pivovar Krakonoš Brewery', name: 'Trutnov 11', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(31);
  });

  test('#321 grade: spelled word matches same-grade candidates (Dvanastka → 12°)', async () => {
    // NB: uses a strict-matching brewery to isolate the grade logic. The real orphans
    // 29429/29556 ('Kamenica' vs 'Pivovar Kamenice nad Lipou') additionally need a
    // kamenica↔kamenice curated brewery alias to pass the strict gate — that is a separate
    // brewery-alias concern, out of scope for #321 (grade reconciliation).
    const search = fakeSearch(() => [
      { bid: 40, beer_name: 'Kamenická 12', brewery_name: 'Pivovar Kamenice nad Lipou', style: 'Czech Amber Lager', abv: 5, global_rating: 3.5 },
      { bid: 41, beer_name: 'Spílková Dvanáctka', brewery_name: 'Pivovar Kamenice nad Lipou', style: 'Czech Pale Lager', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Kamenice nad Lipou Brewery', name: 'Dvanastka', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect([40, 41]).toContain(out.result.bid);
  });

  test('#321 grade: no same-grade non-ale candidate → not_found (does not force a match)', async () => {
    const search = fakeSearch(() => [
      { bid: 50, beer_name: 'Hazy IPA 11%', brewery_name: 'Nachmelená Opice', style: 'IPA', abv: 6.5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Nachmelená Opice Brewery', name: '11', search });
    expect(out.kind).toBe('not_found');
  });

  test('#321 grade: dark candidate excluded for a plain (pale-default) bare-number grade', async () => {
    // Bare "10" normalizes to empty, so no earlier name stage fires — this routes purely
    // through the grade stage, where the dark candidate must be excluded (pale is default).
    const search = fakeSearch(() => [
      { bid: 60, beer_name: 'Tmavá desítka', brewery_name: 'Nachmelená Opice', style: 'Czech Dark Lager', abv: 4.2, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Nachmelená Opice Brewery', name: '10', search });
    expect(out.kind).toBe('not_found');
  });

  test('Měšťanský: nominative gate opens, name resolves (Kutná Hora Zlata 12)', async () => {
    const search = fakeSearch(() => [
      { bid: 70, beer_name: 'Kutnohorská Zlatá 12', brewery_name: 'Měšťanský pivovar Kutná Hora', style: 'Czech Pale Lager', abv: 5, global_rating: 3.5 },
      { bid: 71, beer_name: 'Kutnohorská Zlatá 12 Chmelená za studena', brewery_name: 'Měšťanský pivovar Kutná Hora', style: 'Czech Pale Lager', abv: 5, global_rating: 3.5 },
      { bid: 72, beer_name: 'Zlatá 12 nefiltrovaná', brewery_name: 'Měšťanský pivovar Kutná Hora', style: 'Czech Pale Lager', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Kutna Hora Brewery', name: 'Zlata 12', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect([70, 71, 72]).toContain(out.result.bid);
  });
});

// #369/#322: the shop publishes "Moc 0.0%" for AleBrowar KWAS CHLEBOWY JASNY.
// Bright (0.0%) and Light (0.5%) share brewery, style and name — the ABV is the
// only thing that separates them. A truthiness check anywhere on the relay path
// would discard the 0 and re-create the ambiguity this test exists to prevent.
describe('#369/#322 — a relayed 0.0% ABV disambiguates same-brewery twins', () => {
  const twins: SearchResult[] = [
    { bid: 5489374, beer_name: 'Kwas Chlebowy Bright', brewery_name: 'AleBrowar', style: 'Kwas Chlebowy', abv: 0, global_rating: 3.4 },
    { bid: 5489375, beer_name: 'Kwas Chlebowy Light', brewery_name: 'AleBrowar', style: 'Kwas Chlebowy', abv: 0.5, global_rating: 3.3 },
  ];

  test('picks Bright when abv is 0', async () => {
    const out = await lookupBeer({
      brewery: 'AleBrowar', name: 'Kwas Chlebowy', abv: 0, search: fakeSearch(() => twins),
    });
    expect(out.kind).toBe('matched');
    expect(out.kind === 'matched' && out.result.bid).toBe(5489374);
  });

  test('picks Light when abv is 0.5', async () => {
    const out = await lookupBeer({
      brewery: 'AleBrowar', name: 'Kwas Chlebowy', abv: 0.5, search: fakeSearch(() => twins),
    });
    expect(out.kind).toBe('matched');
    expect(out.kind === 'matched' && out.result.bid).toBe(5489375);
  });
});

describe('#382 query ladder', () => {
  function recordingSearch(fn: (q: string) => SearchResult[]) {
    const queries: string[] = [];
    return {
      queries,
      search: { search: async (q: string) => { queries.push(q); return fn(q); } } as BeerSearch,
    };
  }

  test('widens to the reduced rung when the narrow rung returns nothing', async () => {
    const { queries, search } = recordingSearch((q) =>
      q === 'Ципа Сидр Грушевий PERRY'
        ? []
        : [{ bid: 7001, beer_name: 'Сидр Грушевий PERRY', brewery_name: 'Ципа', style: 'Cider', abv: 5, global_rating: 3.5 }],
    );
    const out = await lookupBeer({ brewery: 'Ципа', name: 'Сидр Грушевий PERRY', search });
    expect(queries).toEqual(['Ципа Сидр Грушевий PERRY', 'PERRY']);
    expect(out.kind).toBe('matched');
  });

  test('never widens when the narrow rung returned candidates, even if none match', async () => {
    // The wide rung's extra candidates are a superset the narrow rung already excluded;
    // re-searching would only re-offer rows the same stages just rejected.
    const { queries, search } = recordingSearch((q) =>
      q === 'Ципа Сидр Грушевий PERRY'
        ? [{ bid: 7002, beer_name: 'Something Else', brewery_name: 'Other Brewery', style: 'IPA', abv: 5, global_rating: 3.5 }]
        : [{ bid: 7003, beer_name: 'Сидр Грушевий PERRY', brewery_name: 'Ципа', style: 'Cider', abv: 5, global_rating: 3.5 }],
    );
    const out = await lookupBeer({ brewery: 'Ципа', name: 'Сидр Грушевий PERRY', search });
    expect(queries).toEqual(['Ципа Сидр Грушевий PERRY']);
    expect(out.kind).toBe('not_found');
  });

  test('all-Latin input issues exactly one query per brewery part', async () => {
    const { queries, search } = recordingSearch(() => []);
    await lookupBeer({ brewery: 'Pinta', name: 'Atak Chmielu', search });
    expect(queries).toEqual(['Pinta Atak Chmielu']);
  });

  test('every attempted rung is reported in searchUrls', async () => {
    const { search } = recordingSearch(() => []);
    const out = await lookupBeer({ brewery: 'Ципа', name: 'Сидр Грушевий PERRY', search });
    expect(out.kind).toBe('not_found');
    if (out.kind !== 'not_found') return;
    expect(out.searchUrls).toHaveLength(2);
    expect(decodeURIComponent(out.searchUrls[0])).toContain('Ципа Сидр Грушевий PERRY');
    expect(decodeURIComponent(out.searchUrls[1])).toContain('PERRY');
  });

  test('a block on the narrow rung returns blocked without trying the wide rung', async () => {
    const { queries, search } = recordingSearch(() => { throw new HttpError(403, 'https://untappd.com'); });
    const out = await lookupBeer({ brewery: 'Ципа', name: 'Сидр Грушевий PERRY', search });
    expect(out.kind).toBe('blocked');
    expect(queries).toEqual(['Ципа Сидр Грушевий PERRY']);
  });

  test('#271 head-retry still fires when every rung of every part is empty', async () => {
    const queries: string[] = [];
    const search: BeerSearch = { search: async (q) => { queries.push(q); return []; } };
    const out = await lookupBeer({ brewery: 'Ципа', name: 'Орєнтал, Лохина, Чорна Смородина', search });
    expect(out.kind).toBe('not_found');
    // the head-only retry ran in addition to the ladder rungs
    expect(queries.length).toBeGreaterThan(2);
  });

  test('a collab part whose candidates all fail the brewery gate falls through to the next part', async () => {
    const queries: string[] = [];
    const search: BeerSearch = {
      search: async (q) => {
        queries.push(q);
        // First collab part returns a candidate from an unrelated brewery (fails the gate);
        // the second part returns the real match.
        return q.includes('Alpha')
          ? [{ bid: 8001, beer_name: 'Some Beer', brewery_name: 'Unrelated Brewery', style: 'IPA', abv: 5, global_rating: 3.5 }]
          : [{ bid: 8002, beer_name: 'Some Beer', brewery_name: 'Beta', style: 'IPA', abv: 5, global_rating: 4.1 }];
      },
    };
    const out = await lookupBeer({ brewery: 'Alpha x Beta', name: 'Some Beer', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(8002);
    expect(queries.length).toBeGreaterThan(1);
  });
});

describe('#347 curated alias batch', () => {
  test('33544: parent-company prefix, ABV separates the decoy siblings', async () => {
    const search = fakeSearch(() => [
      { bid: 323265, beer_name: 'Książęce Złote Pszeniczne', brewery_name: 'Tyskie Browary Książęce', style: 'Wheat Beer - Other', abv: 4.9, global_rating: 3.4 },
      { bid: 4732673, beer_name: 'Książęce Złote Pszeniczne 0,0%', brewery_name: 'Tyskie Browary Książęce', style: 'Non-Alcoholic - Wheat', abv: 0, global_rating: 3.1 },
      { bid: 6743380, beer_name: 'Złote Pszeniczne Z Nutą Mango', brewery_name: 'Tyskie Browary Książęce', style: 'Wheat Beer - Fruited', abv: 4.8, global_rating: 3.2 },
    ]);
    const out = await lookupBeer({ brewery: 'Browary Książęce Brewery', name: 'Złote Pszeniczne', abv: 4.9, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(323265);

    // The decoys only separate on ABV when they come first: reversed and without an ABV
    // the 0,0% sibling wins, so this second lookup is what makes the tiebreak load-bearing.
    const reversed = fakeSearch(() => [
      { bid: 6743380, beer_name: 'Złote Pszeniczne Z Nutą Mango', brewery_name: 'Tyskie Browary Książęce', style: 'Wheat Beer - Fruited', abv: 4.8, global_rating: 3.2 },
      { bid: 4732673, beer_name: 'Książęce Złote Pszeniczne 0,0%', brewery_name: 'Tyskie Browary Książęce', style: 'Non-Alcoholic - Wheat', abv: 0, global_rating: 3.1 },
      { bid: 323265, beer_name: 'Książęce Złote Pszeniczne', brewery_name: 'Tyskie Browary Książęce', style: 'Wheat Beer - Other', abv: 4.9, global_rating: 3.4 },
    ]);
    const outReversed = await lookupBeer({ brewery: 'Browary Książęce Brewery', name: 'Złote Pszeniczne', abv: 4.9, search: reversed });
    expect(outReversed.kind).toBe('matched');
    if (outReversed.kind !== 'matched') return;
    expect(outReversed.result.bid).toBe(323265);
  });

  test('11995: portfolio label reaches the group brewery', async () => {
    const search = fakeSearch(() => [
      { bid: 71011, beer_name: 'Ježek Kvasnicový', brewery_name: 'Pivovar Jihlava', style: 'Pilsner - Czech / Bohemian', abv: 4.9, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Lobkowicz Brewery', name: 'Ježek Kvasnicovy', abv: 4.9, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(71011);
  });

  test('34336: picks the group brewery over the same-named house beer', async () => {
    const search = fakeSearch(() => [
      { bid: 215285, beer_name: 'Lobkowicz Premium ležák', brewery_name: 'Pivovary Lobkowicz', style: 'Pilsner - Czech / Bohemian', abv: 4.7, global_rating: 3.4 },
      { bid: 301434, beer_name: 'Rychtář Premium', brewery_name: 'Pivovar Rychtář', style: 'Pilsner - Czech / Bohemian', abv: 5.0, global_rating: 3.5 },
      { bid: 897066, beer_name: 'Lobkowicz Premium Černý', brewery_name: 'Pivovary Lobkowicz', style: 'Lager - Tmavé (Czech Dark)', abv: 4.7, global_rating: 3.3 },
    ]);
    const out = await lookupBeer({ brewery: 'Pivovar Lobkowicz Brewery', name: 'Rychtář Premium 12°', abv: 5.0, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(301434);
  });

  test('the widened gate does not let a Rychtář row take a Lobkowicz beer', async () => {
    const search = fakeSearch(() => [
      { bid: 215285, beer_name: 'Lobkowicz Premium ležák', brewery_name: 'Pivovary Lobkowicz', style: 'Pilsner - Czech / Bohemian', abv: 4.7, global_rating: 3.4 },
      { bid: 301434, beer_name: 'Rychtář Premium', brewery_name: 'Pivovar Rychtář', style: 'Pilsner - Czech / Bohemian', abv: 5.0, global_rating: 3.5 },
    ]);
    // No ABV on purpose: the name stage alone must discriminate.
    const out = await lookupBeer({ brewery: 'Pivovar Rychtář', name: 'Premium', search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(301434);
  });

  test('34371: bare-town shop label reaches the full brewery name', async () => {
    const search = fakeSearch(() => [
      { bid: 1036654, beer_name: 'Pszeniczne Cieszyńskie', brewery_name: 'Arcyksiążęcy Browar Zamkowy Cieszyn', style: 'Wheat Beer - Hefeweizen', abv: 5.4, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Cieszyn Brewery', name: 'Pszeniczne 12,5°', abv: 5.4, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1036654);
  });

  test('34352: series-as-brewery reaches Mad Brew, not the other tomato goses', async () => {
    const search = fakeSearch(() => [
      { bid: 6819716, beer_name: 'Tomatol Wasabi', brewery_name: 'Mad Brew', style: 'Sour - Tomato / Vegetable Gose', abv: 3.8, global_rating: 3.6 },
      { bid: 6689682, beer_name: 'KOTOMATO WASABI TOMATO GOSE', brewery_name: 'Rebrew', style: 'Sour - Tomato / Vegetable Gose', abv: 5, global_rating: 3.5 },
      { bid: 5970182, beer_name: 'WASABI TOMATO GOSE', brewery_name: 'LiS Brew', style: 'Sour - Tomato / Vegetable Gose', abv: 6, global_rating: 3.4 },
    ]);
    const out = await lookupBeer({ brewery: 'Tomatol', name: 'Wasabi', abv: 3.8, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6819716);
  });

  test('34351: a contradicting shop ABV must not veto the published beer (sibling separated only by result order)', async () => {
    // flasker prints 3.8% in the title while the linked Untappd record says 4.2%.
    // Both candidates tie: each normalizes to three tokens against the one-token target
    // `bulgogi`, so both score the same near-name value, and both fall outside the ABV
    // window. The winner is whichever Algolia returned first — this test pins the observed
    // live order (2026-08-14), NOT a discriminator. A deterministic tie-break needs the bid
    // flasker publishes (#384); see the follow-up issue linked from the PR.
    const search = fakeSearch(() => [
      { bid: 6648348, beer_name: 'Tomatøl:BULDAK BULGOGI', brewery_name: 'Mad Brew', style: 'Sour - Tomato / Vegetable Gose', abv: 4.2, global_rating: 3.6 },
      { bid: 6708599, beer_name: 'Tomatol: Bulgogi Sriracha', brewery_name: 'Mad Brew', style: 'Sour - Tomato / Vegetable Gose', abv: 4.2, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Tomatol', name: 'Bulgogi', abv: 3.8, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6648348);
  });
});

describe('#427 upstream identity evidence', () => {
  test('identity alias: a complete collaboration label admits Dżemer', async () => {
    const search = fakeSearch(() => [
      { bid: 6603979, beer_name: 'Dżemer', brewery_name: 'Sadyba', style: 'Fruit Beer', abv: 5, global_rating: 3.7,
        alias_alt: ['Sadyba Dżemer', 'Magic Road Dżemer'] },
    ]);

    const out = await lookupBeer({ brewery: 'Magic Road Brewery', name: 'Dżemer', abv: 5, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6603979);
  });

  test('identity alias: a brewery repeated in the shop name is not duplicated', async () => {
    const search = fakeSearch(() => [
      { bid: 6603979, beer_name: 'Dżemer', brewery_name: 'Sadyba', style: 'Fruit Beer', abv: 5, global_rating: 3.7,
        alias_alt: ['Sadyba Dżemer', 'Magic Road Dżemer'] },
    ]);

    const out = await lookupBeer({ brewery: 'Magic Road Brewery', name: 'Magic Road Dżemer', abv: 5, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6603979);
  });

  test('identity alias: a bare beer alias cannot bypass the brewery gate', async () => {
    const search = fakeSearch(() => [
      { bid: 6603979, beer_name: 'Dżemer', brewery_name: 'Sadyba', style: 'Fruit Beer', abv: 5, global_rating: 3.7,
        alias_alt: ['Dżemer'] },
    ]);

    const out = await lookupBeer({ brewery: 'Magic Road Brewery', name: 'Dżemer', abv: 5, search });

    expect(out.kind).toBe('not_found');
  });

  test('identity alias: a canonical brewery match keeps precedence over rescue evidence', async () => {
    const search = fakeSearch(() => [
      { bid: 1, beer_name: 'Dżemer', brewery_name: 'Magic Road', style: 'Fruit Beer', abv: 5, global_rating: 3.8 },
      { bid: 2, beer_name: 'Dżemer', brewery_name: 'Sadyba', style: 'Fruit Beer', abv: 5, global_rating: 3.7,
        alias_alt: ['Magic Road Dżemer'] },
    ]);

    const out = await lookupBeer({ brewery: 'Magic Road Brewery', name: 'Dżemer', abv: 5, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1);
  });

  test('native brewery alias: Carlsberg ownership admits the unique Okocim beer', async () => {
    const search = fakeSearch(() => [
      { bid: 9055, beer_name: 'Okocim Jasne Okocimskie / Jasne Pełne', brewery_name: 'Browar Okocim', style: 'Pilsner', abv: 5, global_rating: 3.1,
        brewery_alias: ['Carlsberg Polska'], alias_alt: ['Okocim Jasne Pełne'] },
      { bid: 1768290, beer_name: 'Okocim Jasne Pełne 3,4%', brewery_name: 'Browar Okocim', style: 'Lager', abv: 3.4, global_rating: 2.7,
        brewery_alias: ['Carlsberg Polska'] },
      { bid: 4555473, beer_name: 'Okocim Jasne Lekkie', brewery_name: 'Browar Okocim', style: 'Lager', abv: 3.5, global_rating: 0,
        brewery_alias: ['Carlsberg Polska'] },
    ]);

    const out = await lookupBeer({ brewery: 'Carlsberg Brewery', name: 'okocim jasne', abv: 5, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(9055);
  });

  test('native brewery alias: Stu Mostów admits the unique WRCLW beer', async () => {
    const search = fakeSearch(() => [
      { bid: 1741395, beer_name: 'WRCLW Schöps', brewery_name: 'WRCLW', style: 'Wheat Beer', abv: 5, global_rating: 3.4,
        brewery_alias: ['Browar Stu Mostów', 'Stu Mostów'] },
    ]);

    const out = await lookupBeer({ brewery: 'Stu Mostów Brewery', name: 'WRCLW Schöps', abv: 4.8, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1741395);
  });

  test('native brewery alias: a sole candidate with contradictory ABV is rejected', async () => {
    const search = fakeSearch(() => [
      { bid: 1, beer_name: 'Okocim Jasne', brewery_name: 'Browar Okocim', style: 'Lager', abv: 9, global_rating: 3,
        brewery_alias: ['Carlsberg Polska'] },
    ]);

    const out = await lookupBeer({ brewery: 'Carlsberg Brewery', name: 'Okocim Jasne', abv: 5, search });

    expect(out.kind).toBe('not_found');
  });

  test('native brewery alias: structured evidence still applies when the canonical label is only relaxed-contained', async () => {
    const search = fakeSearch(() => [
      { bid: 1, beer_name: 'Okocim Jasne Pełne', brewery_name: 'Group Carlsberg Holdings', style: 'Lager', abv: 5, global_rating: 3,
        brewery_alias: ['Carlsberg Polska'] },
    ]);

    const out = await lookupBeer({ brewery: 'Carlsberg Brewery', name: 'Okocim Jasne', abv: 5, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1);
  });

  test.each([false, true])('native brewery alias: ambiguous PLATAN stays unresolved (reversed=%s)', async (reversed) => {
    const candidates: SearchResult[] = [
      { bid: 1, beer_name: 'Platan Jedenáctka', brewery_name: 'Pivovar Protivín', style: 'Pilsner', abv: 4.6, global_rating: 3.2,
        brewery_alias: ['Pivovary Lobkowicz'] },
      { bid: 2, beer_name: 'Platan Granát', brewery_name: 'Pivovar Protivín', style: 'Lager', abv: 4.6, global_rating: 3.2,
        brewery_alias: ['Pivovary Lobkowicz'] },
    ];
    const search = fakeSearch(() => reversed ? [...candidates].reverse() : candidates);

    const out = await lookupBeer({ brewery: 'Lobkowicz Brewery', name: 'PLATAN', abv: 4.6, search });

    expect(out.kind).toBe('not_found');
  });

  test.each([
    ['Ruby', 5944, [
      { bid: 5944, beer_name: 'Leffe Ruby', brewery_name: 'Abbaye de Leffe', style: 'Fruit Beer', abv: 5, global_rating: 3.3 },
      { bid: 4264020, beer_name: 'Leffe Ruby 0,0%', brewery_name: 'Abbaye de Leffe', style: 'Non-Alcoholic', abv: 0, global_rating: 2.8,
        alias_alt: ['Leffe Ruby 0% Alc.'] },
    ]],
    ['Blonde', 5940, [
      { bid: 5940, beer_name: 'Leffe Blonde / Blond', brewery_name: 'Abbaye de Leffe', style: 'Belgian Blonde', abv: 6.6, global_rating: 3.5 },
      { bid: 5943, beer_name: 'Leffe Triple / Tripel', brewery_name: 'Abbaye de Leffe', style: 'Belgian Tripel', abv: 8.5, global_rating: 3.6,
        alias_alt: ['leffe triple blonde'] },
      { bid: 2948556, beer_name: 'Leffe Blonde / Blond 0,0%', brewery_name: 'Abbaye de Leffe', style: 'Non-Alcoholic', abv: 0, global_rating: 2.8 },
    ]],
  ] satisfies Array<[string, number, SearchResult[]]>)('brand remainder: Leffe / %s matches the exact branded beer name', async (name, bid, candidates) => {
    const search = fakeSearch(() => candidates);

    const out = await lookupBeer({ brewery: 'Leffe', name, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(bid);
  });

  test('brand remainder: CRAFT is removed from the complete candidate beer name', async () => {
    const search = fakeSearch(() => [
      { bid: 6518418, beer_name: 'Craft Star - Double Stout', brewery_name: 'Mad Brew', style: 'Stout', abv: 8.4, global_rating: 3.5 },
    ]);

    const out = await lookupBeer({ brewery: 'CRAFT', name: 'STAR Double Stout', abv: 6, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6518418);
  });

  test('brand remainder: a fuzzy remainder is rejected', async () => {
    const search = fakeSearch(() => [
      { bid: 1, beer_name: 'Leffe Ruby Cherry', brewery_name: 'Abbaye de Leffe', style: 'Belgian Ale', abv: 5, global_rating: 3.3 },
    ]);

    const out = await lookupBeer({ brewery: 'Leffe', name: 'Ruby', search });

    expect(out.kind).toBe('not_found');
  });

  test('brand remainder: an ampersand flavour suffix is part of the name, not an alternate label', async () => {
    const search = fakeSearch(() => [
      { bid: 1, beer_name: 'Leffe Ruby & Cherry', brewery_name: 'Abbaye de Leffe', style: 'Fruit Beer', abv: 5, global_rating: 3.3 },
    ]);

    const out = await lookupBeer({ brewery: 'Leffe', name: 'Ruby', search });

    expect(out.kind).toBe('not_found');
  });

  test('brand remainder: two exact candidates without unique ABV evidence stay unresolved', async () => {
    const search = fakeSearch(() => [
      { bid: 1, beer_name: 'Leffe Ruby', brewery_name: 'Abbaye de Leffe', style: 'Belgian Ale', abv: 5, global_rating: 3.3 },
      { bid: 2, beer_name: 'Leffe Ruby', brewery_name: 'Abbaye de Leffe', style: 'Fruit Beer', abv: 5, global_rating: 3.1 },
    ]);

    const out = await lookupBeer({ brewery: 'Leffe', name: 'Ruby', search });

    expect(out.kind).toBe('not_found');
  });
});

describe('lookupBeer — name identity floor (#505)', () => {
  test('matched: a bare style-word candidate is reachable', async () => {
    const search = fakeSearch(() => [
      { bid: 30947, beer_name: 'Weizen', brewery_name: 'Primátor', style: 'Hefeweizen', abv: 4.8, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Primator Brewery', name: 'Weizenbier', abv: 4.8, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(30947);
  });

  test('matched: the digit that IS the name beats the ABV coincidence', async () => {
    // The shop says 5.0, which points at 1664 Blanc. The name says 1664.
    const search = fakeSearch(() => [
      { bid: 5939, beer_name: '1664', brewery_name: 'Brasseries Kronenbourg', style: 'Lager', abv: 5.5, global_rating: 3.4 },
      { bid: 5999, beer_name: '1664 Blanc', brewery_name: 'Brasseries Kronenbourg', style: 'Witbier', abv: 5, global_rating: 3.6 },
    ]);
    const out = await lookupBeer({ brewery: 'Kronenbourg Brewery', name: 'Kronenbourg 1664', abv: 5, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(5939);
  });

  test('BOTH sides must apply the rule: input-only would break this row', async () => {
    // Guards the measured regression: with the rule on the input side only, the target
    // becomes "weizen" while the candidate stays "", and this row stops matching.
    const search = fakeSearch(() => [
      { bid: 30947, beer_name: 'Weizen', brewery_name: 'Primátor', style: 'Hefeweizen', abv: 4.8, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Primator Brewery', name: 'Primator Weizen', abv: 4.8, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(30947);
  });

  test('not_found: restored evidence never fuzzy-reaches a different beer', async () => {
    // "IPA" must not become "IPALIT".
    const search = fakeSearch(() => [
      { bid: 4463769, beer_name: 'IPALIT (ИПАЛИТ)', brewery_name: 'Augustine (Августин)', style: 'IPA', abv: 7.5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Августин', name: 'IPA', abv: 7, search });
    expect(out.kind).toBe('not_found');
  });

  test('not_found: a bare brand plus a style word stays an honest orphan', async () => {
    // "Tyskie Lager" carries no identity beyond the brand; guessing is worse than refusing.
    const search = fakeSearch(() => [
      { bid: 5334255, beer_name: 'Tyskie Sport Lager', brewery_name: 'Tyskie Browary Książęce', style: 'Lager', abv: 4.6, global_rating: 3.2 },
      { bid: 5099975, beer_name: 'Książęce Lager', brewery_name: 'Tyskie Browary Książęce', style: 'Lager', abv: 5, global_rating: 3.3 },
    ]);
    const out = await lookupBeer({ brewery: 'Tyskie Brewery', name: 'Tyskie Lager', abv: 4.6, search });
    expect(out.kind).toBe('not_found');
  });

  test('unchanged: a name the filter leaves intact still matches as before', async () => {
    const search = fakeSearch(() => [
      { bid: 6620595, beer_name: 'Buzdygan Rozkoszy', brewery_name: 'Harpagan Craft Beer', style: 'IPA', abv: 5, global_rating: 3.5 },
    ]);
    const out = await lookupBeer({ brewery: 'Harpagan', name: 'Buzdygan Rozkoszy IPA', abv: 5, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6620595);
  });

  test('not_found: the identity-alias rescue refuses an ABV contradiction on restored evidence', async () => {
    // "Lambic Boon" restores to "lambic"; the rescue must not hand back a 7% beer for a 4% tap.
    // The alias "boon lambic" (brewery + name) is the identity path that opens the identityHits pool.
    const search = fakeSearch(() => [
      { bid: 756972, beer_name: 'Unblended Oude Lambiek', brewery_name: 'Brouwerij Boon',
        style: 'Lambic - Traditional', abv: 7, global_rating: 3.7,
        brewery_alias: ['boon brewery', 'frank boon'],
        alias_alt: ['lambic', 'lambik', 'boon lambic', 'unblended lambic'],
        rating_count: 5000 },
    ]);
    const out = await lookupBeer({ brewery: 'Brouwerij Boon Brewery', name: 'Lambic Boon', abv: 4, search });
    expect(out.kind).toBe('not_found');
  });

  test('matched: the identity-alias rescue accepts when ABV agrees on restored evidence', async () => {
    // When ABV matches, the identity-alias rescue correctly accepts the candidate.
    const search = fakeSearch(() => [
      { bid: 756972, beer_name: 'Unblended Oude Lambiek', brewery_name: 'Brouwerij Boon',
        style: 'Lambic - Traditional', abv: 7, global_rating: 3.7,
        brewery_alias: ['boon brewery', 'frank boon'],
        alias_alt: ['lambic', 'lambik', 'boon lambic', 'unblended lambic'],
        rating_count: 5000 },
    ]);
    const out = await lookupBeer({ brewery: 'Brouwerij Boon Brewery', name: 'Lambic Boon', abv: 7, search });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(756972);
  });
});
