import { matchBeer, type CatalogBeer } from './matcher';

export interface CatalogBeerWithRating extends CatalogBeer {
  rating_global: number | null;
}

export interface MatchInput {
  brewery: string;
  name: string;
  abv?: number | null;
}

export interface MatchedBeer {
  id: number;
  name: string;
  brewery: string;
  rating_global: number | null;
}

export interface MatchListResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;
  user_rating: number | null;
}

export function matchBeerList(
  catalog: CatalogBeerWithRating[],
  drunkSet: Set<number>,
  ratingByBeerId: Map<number, number>,
  items: MatchInput[],
): MatchListResult[] {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  return items.map((item) => {
    const raw = { brewery: item.brewery, name: item.name };
    const m = matchBeer(item, catalog);
    if (!m) {
      return { raw, matched_beer: null, is_drunk: false, user_rating: null };
    }
    const beer = byId.get(m.id)!;
    return {
      raw,
      matched_beer: {
        id: beer.id,
        name: beer.name,
        brewery: beer.brewery,
        rating_global: beer.rating_global,
      },
      is_drunk: drunkSet.has(m.id),
      user_rating: ratingByBeerId.get(m.id) ?? null,
    };
  });
}
