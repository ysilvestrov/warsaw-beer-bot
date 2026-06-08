export interface RawBeer {
  brewery: string;
  name: string;
  abv?: number;
}

export interface MatchedBeer {
  id: number;
  name: string;
  brewery: string;
  rating_global: number | null;
}

export interface MatchResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;
  user_rating: number | null;
}

export interface MatchResponse {
  results: MatchResult[];
}
