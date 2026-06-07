import { matchBeerList, type CatalogBeerWithRating } from './match-list';

const catalog: CatalogBeerWithRating[] = [
  { id: 105, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85 },
  { id: 200, brewery: 'PINTA', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7 },
];

describe('matchBeerList', () => {
  it('marks a matched, drunk beer with its personal rating', () => {
    const res = matchBeerList(
      catalog,
      new Set([105]),
      new Map([[105, 4.0]]),
      [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }],
    );
    expect(res).toEqual([
      {
        raw: { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
        matched_beer: { id: 105, name: 'Pan IPAni', brewery: 'Trzech Kumpli', rating_global: 3.85 },
        is_drunk: true,
        user_rating: 4.0,
      },
    ]);
  });

  it('drunk via had-list only → is_drunk true, user_rating null', () => {
    const res = matchBeerList(catalog, new Set([200]), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmielu' },
    ]);
    expect(res[0].is_drunk).toBe(true);
    expect(res[0].user_rating).toBeNull();
  });

  it('no catalog match → matched_beer null, not drunk', () => {
    const res = matchBeerList(catalog, new Set(), new Map(), [
      { brewery: 'Nowhere', name: 'Unknown Stout' },
    ]);
    expect(res[0]).toEqual({
      raw: { brewery: 'Nowhere', name: 'Unknown Stout' },
      matched_beer: null,
      is_drunk: false,
      user_rating: null,
    });
  });

  it('preserves input order', () => {
    const res = matchBeerList(catalog, new Set(), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmielu' },
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(res.map((r) => r.matched_beer?.id)).toEqual([200, 105]);
  });
});
