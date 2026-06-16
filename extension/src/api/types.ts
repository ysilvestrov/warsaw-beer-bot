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
  untappd_id: number | null;
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

export interface EnrichCandidate {
  brewery: string;
  name: string;
  eligible: boolean;
  searchUrl: string;
}

export interface EnrichResult {
  status: 'matched' | 'not_found' | 'blocked' | 'transient' | 'skipped';
  untappd_id?: number;
  rating_global?: number | null;
}

export interface CheckinSyncState {
  username: string;
  deepest_max_id: string | null;
  complete: boolean;
  serverCount: number;
  profileTotal: number | null;
}

export interface CheckinSyncPageResult {
  merged: number;
  alreadyKnown: number;
  pageSize: number;
  nextMaxId: string | null;
  profileTotal: number | null;
  serverCount: number;
  complete: boolean;
}
