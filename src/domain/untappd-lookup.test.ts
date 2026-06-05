import { lookupBeer } from './untappd-lookup';

function htmlFor(items: Array<{ bid: number; name: string; brewery: string; rating?: string }>): string {
  const cards = items
    .map((it) => `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/x/${it.bid}">${it.name}</a></p>
          <p class="brewery"><a>${it.brewery}</a></p>
          <p class="style">IPA</p>
        </div>
        <div class="details beer">
          <p class="abv">5% ABV</p>
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
});
