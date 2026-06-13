import { lookupBeer } from './untappd-lookup';

function htmlFor(
  items: Array<{ bid: number; name: string; brewery: string; rating?: string; abv?: string }>,
): string {
  const cards = items
    .map((it) => `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/x/${it.bid}">${it.name}</a></p>
          <p class="brewery"><a>${it.brewery}</a></p>
          <p class="style">IPA</p>
        </div>
        <div class="details beer">
          <p class="abv">${it.abv ?? '5'}% ABV</p>
          <div class="rating">
            <div class="caps" data-rating="${it.rating ?? '3.5'}"></div>
          </div>
        </div>
      </div>`)
    .join('');
  return `<html><body>${cards}</body></html>`;
}

describe('lookupBeer', () => {
  test('matched: brewery overlaps + name fuzzy >= 0.85 returns best result', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 5000, name: 'Fifty / Fifty - Pineapple', brewery: 'Magic Road' },
        { bid: 5001, name: 'Fifty / Fifty Clementine & Passionfruit', brewery: 'Magic Road', rating: '3.98' },
      ]),
    );
    const out = await lookupBeer({
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      fetch,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(5001);
    expect(out.result.global_rating).toBe(3.98);
  });

  test('not_found: brewery hard-gate filters every candidate', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 9000, name: 'Fifty/Fifty Clementine & Passionfruit', brewery: 'Some Other Brewery' },
      ]),
    );
    const out = await lookupBeer({
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      fetch,
    });
    expect(out.kind).toBe('not_found');
  });

  test('matched: token-prefix gate accepts official-suffix brewery', async () => {
    // Candidate brewery has extra non-noise tokens ("craft beer") that the
    // old exact-equality gate would reject; only the token-prefix gate passes.
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 6620595, name: 'Buzdygan Rozkoszy', brewery: 'Harpagan Craft Beer' },
        { bid: 3240662, name: 'Buzdygan Rozkoszy Rum BA', brewery: 'Harpagan Craft Beer' },
      ]),
    );
    const out = await lookupBeer({
      brewery: 'Harpagan Brewery',
      name: 'Buzdygan Rozkoszy',
      fetch,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6620595);
  });

  test('matched: ABV breaks name-fuzzy ties between same-brand vintages', async () => {
    // normalizeName strips the year, so both names collapse to "buzdygan
    // rozkoszy" and tie at score 1.0. Untappd returns the 9.8% 2026 vintage
    // first; only the ABV tiebreak should pull the 8.5% entry the tap shows.
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 6620595, name: 'Buzdygan Rozkoszy 2026', brewery: 'Harpagan Craft Beer', abv: '9.8' },
        { bid: 2388534, name: 'Buzdygan Rozkoszy', brewery: 'Harpagan Contracts', abv: '8.5' },
      ]),
    );
    const out = await lookupBeer({
      brewery: 'Harpagan Brewery',
      name: 'Buzdygan Rozkoszy',
      abv: 8.5,
      fetch,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(2388534);
  });

  test('not_found: brewery passes hard-gate but every name is below 0.85 fuzzy', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([
        { bid: 9000, name: 'Atak Chmielu IPA', brewery: 'Magic Road' },
        { bid: 9001, name: 'Buty Skejta Pils', brewery: 'Magic Road' },
      ]),
    );
    const out = await lookupBeer({
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      fetch,
    });
    expect(out.kind).toBe('not_found');
  });

  test('transient: fetch throws → kind=transient with the error captured', async () => {
    const boom = new Error('ETIMEDOUT');
    const fetch = jest.fn(async () => {
      throw boom;
    });
    const out = await lookupBeer({
      brewery: 'Magic Road',
      name: 'Fifty/Fifty',
      fetch,
    });
    expect(out.kind).toBe('transient');
    if (out.kind !== 'transient') return;
    expect(out.error).toBe(boom);
  });

  test('empty search results return not_found', async () => {
    const fetch = jest.fn(async () => '<html><body></body></html>');
    const out = await lookupBeer({
      brewery: 'Magic Road',
      name: 'Fifty/Fifty',
      fetch,
    });
    expect(out.kind).toBe('not_found');
  });

  test('strips brewery noise word from the search query', async () => {
    const fetch = jest.fn(async (_url: string) =>
      htmlFor([{ bid: 6172039, name: 'WOCKY TALKY', brewery: 'JBW Browar', rating: '3.18' }]),
    );
    const out = await lookupBeer({ brewery: 'JBW Brewery', name: 'Wocky Talky', fetch });

    const calledUrl = fetch.mock.calls[0][0];
    expect(calledUrl).toContain('JBW%20Wocky%20Talky');
    expect(calledUrl).not.toContain('Brewery');

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6172039);
  });

  test('non-collab brewery: single fetch call (behaviour unchanged)', async () => {
    const fetch = jest.fn(async (_url: string) =>
      htmlFor([{ bid: 1, name: 'Fifty/Fifty', brewery: 'Magic Road' }]),
    );
    await lookupBeer({ brewery: 'Magic Road Brewery', name: 'Fifty/Fifty', fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = fetch.mock.calls[0][0];
    expect(url).toContain('Magic%20Road');
    expect(url).not.toContain('Brewery');
  });

  test('slash collab: first part returns 0 results, second part matches', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce('<html><body></body></html>')
      .mockResolvedValueOnce(
        htmlFor([{ bid: 7777, name: 'S.M.O.K.E.', brewery: 'TankBusters / Blech.Brut' }]),
      );
    const out = await lookupBeer({
      brewery: 'TankBusters/Blech.Brut/Yeast Side Labs Brewery',
      name: 'S.M.O.K.E.',
      fetch,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(7777);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining('TankBusters'));
    expect(fetch).toHaveBeenNthCalledWith(2, expect.stringContaining('Blech.Brut'));
  });

  test('x-connector collab: first part finds the beer', async () => {
    const fetch = jest.fn(async () =>
      htmlFor([{ bid: 8888, name: 'NOT YOUR MILKSHAKE', brewery: 'Ziemia Obiecana' }]),
    );
    const out = await lookupBeer({
      brewery: 'ZIEMIA OBIECANA x Weźże Krafta Brewery',
      name: 'NOT YOUR MILKSHAKE',
      fetch,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(8888);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('ZIEMIA%20OBIECANA'));
  });

  test('collab: transient on any part short-circuits immediately', async () => {
    const boom = new Error('ETIMEDOUT');
    const fetch = jest.fn(async () => { throw boom; });
    const out = await lookupBeer({
      brewery: 'TankBusters/Blech.Brut Brewery',
      name: 'S.M.O.K.E.',
      fetch,
    });
    expect(out.kind).toBe('transient');
    if (out.kind !== 'transient') return;
    expect(out.error).toBe(boom);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('blocked: HttpError 403 → blocked (not transient)', async () => {
    const { HttpError } = await import('../sources/http');
    const fetch = jest.fn(async () => { throw new HttpError(403, 'u'); });
    const out = await lookupBeer({ brewery: 'X', name: 'Y', fetch });
    expect(out.kind).toBe('blocked');
  });

  test('blocked: captcha page → blocked (not not_found)', async () => {
    const fetch = jest.fn(async () => '<title>Just a moment...</title>');
    const out = await lookupBeer({ brewery: 'X', name: 'Y', fetch });
    expect(out.kind).toBe('blocked');
  });

  describe('diagnostics (orphan logging)', () => {
    test('not_found returns the tried search URL(s) and parsed candidates', async () => {
      const fetch = jest.fn(async () =>
        htmlFor([{ bid: 1, name: 'Atak Chmielu', brewery: 'Magic Road' }]),
      );
      const out = await lookupBeer({ brewery: 'Magic Road', name: 'Totally Different Beer', fetch });
      expect(out.kind).toBe('not_found');
      if (out.kind !== 'not_found') return;
      expect(out.searchUrls[0]).toContain('Magic%20Road');
      expect(out.candidates.map((c) => c.beer_name)).toContain('Atak Chmielu');
    });

    test('not_found with zero results returns empty candidates', async () => {
      const fetch = jest.fn(async () => '<html><body></body></html>');
      const out = await lookupBeer({ brewery: 'Magic Road', name: 'Whatever', fetch });
      expect(out.kind).toBe('not_found');
      if (out.kind !== 'not_found') return;
      expect(out.candidates).toEqual([]);
      expect(out.searchUrls.length).toBeGreaterThan(0);
    });

    test('blocked returns the search URL that tripped the block', async () => {
      const fetch = jest.fn(async () => '<title>Just a moment...</title>');
      const out = await lookupBeer({ brewery: 'Magic Road', name: 'X', fetch });
      expect(out.kind).toBe('blocked');
      if (out.kind !== 'blocked') return;
      expect(out.searchUrl).toContain('Magic%20Road');
    });
  });

  describe('name-keys stage (#117)', () => {
    test('matched: reordered name (below fuzzy 0.85) via key intersection', async () => {
      const fetch = jest.fn(async () =>
        htmlFor([{ bid: 11827, name: 'Festweisse (TAP04)', brewery: 'Schneider Weisse G. Schneider & Sohn' }]),
      );
      const out = await lookupBeer({ brewery: 'Schneider', name: 'TAP04 FESTWEISSE', fetch });
      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(11827);
    });

    test('matched: collab partner in input name → base-beer key hit', async () => {
      const fetch = jest.fn(async () =>
        htmlFor([{ bid: 6683161, name: 'Fast Talking', brewery: 'Root + Branch Brewing' }]),
      );
      const out = await lookupBeer({ brewery: 'Root + Branch', name: 'Fast Talking / North Park', fetch });
      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(6683161);
    });

    test('not_found: single-token name with no fuzzy hit stays not_found', async () => {
      const fetch = jest.fn(async () =>
        htmlFor([{ bid: 1, name: 'Totally Different', brewery: 'Root + Branch' }]),
      );
      const out = await lookupBeer({ brewery: 'Root + Branch', name: 'Hazy', fetch });
      expect(out.kind).toBe('not_found');
    });
  });

  describe('fuzzy target normalization (#137)', () => {
    test('matched: strips duplicated brewery before fuzzy matching candidate names', async () => {
      const fetch = jest.fn(async () =>
        htmlFor([{ bid: 7201, name: 'Nealko', brewery: 'Rohozec' }]),
      );

      const out = await lookupBeer({
        brewery: 'Rohozec Brewery',
        name: 'Rohozec Nealko',
        fetch,
      });

      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(7201);
    });

    test('matched: fuzzy-checks each single-token collab side when name keys are weak', async () => {
      const fetch = jest.fn(async () =>
        htmlFor([{ bid: 7202, name: 'Lièvre', brewery: 'Nano Cinco' }]),
      );

      const out = await lookupBeer({
        brewery: 'Nano Cinco',
        name: 'Lièvre / Slake',
        fetch,
      });

      expect(out.kind).toBe('matched');
      if (out.kind !== 'matched') return;
      expect(out.result.bid).toBe(7202);
    });

    test('not_found: single-token collab side does not fuzzy-match a longer variant', async () => {
      const fetch = jest.fn(async () =>
        htmlFor([{ bid: 7203, name: 'Lièvre Rouge', brewery: 'Nano Cinco' }]),
      );

      const out = await lookupBeer({
        brewery: 'Nano Cinco',
        name: 'Lièvre / Slake',
        fetch,
      });

      expect(out.kind).toBe('not_found');
    });
  });
});
