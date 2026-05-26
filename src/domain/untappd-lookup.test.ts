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
});
