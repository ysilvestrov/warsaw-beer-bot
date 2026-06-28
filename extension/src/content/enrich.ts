import type { AlgoliaQuery, AlgoliaResponse, EnrichResult } from '../api/types';

export const MAX_SEARCHES_PER_PAGE = 20;
export const DEFAULT_DELAY_MS = 4000;

export interface OrphanBeer {
  key: string;
  brewery: string;
  name: string;
}

export interface EnrichDeps {
  getCandidates: (
    beers: { brewery: string; name: string }[],
  ) => Promise<{ brewery: string; name: string; eligible: boolean; algolia: AlgoliaQuery }[]>;
  fetchSearch: (algolia: AlgoliaQuery) => Promise<AlgoliaResponse | null>;
  submitResult: (brewery: string, name: string, algolia: AlgoliaResponse) => Promise<EnrichResult>;
  setSearching: (key: string) => void;
  setEnriched: (key: string, untappdId: number, ratingGlobal: number | null) => void;
  setOrphan: (key: string, brewery: string, name: string) => void;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const pairKey = (brewery: string, name: string) => `${brewery} ${name}`;

// Registers every page orphan, then searches Untappd one at a time, throttled — but at
// most MAX_SEARCHES_PER_PAGE per page so a big shop page doesn't drain the user's session.
// The rest stay ⚪ for a later load / the server cron (same orphan pool + backoff).
export async function runEnrichment(orphans: OrphanBeer[], deps: EnrichDeps): Promise<void> {
  if (orphans.length === 0) return;

  const candidates = await deps.getCandidates(
    orphans.map((o) => ({ brewery: o.brewery, name: o.name })),
  );
  const byPair = new Map(orphans.map((o) => [pairKey(o.brewery, o.name), o]));
  const eligible = candidates.filter((c) => c.eligible).slice(0, MAX_SEARCHES_PER_PAGE);

  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 0; i < eligible.length; i++) {
    const cand = eligible[i];
    const beer = byPair.get(pairKey(cand.brewery, cand.name));
    if (!beer) continue;

    deps.setSearching(beer.key);
    try {
      const algolia = await deps.fetchSearch(cand.algolia);
      const res = algolia ? await deps.submitResult(cand.brewery, cand.name, algolia) : null;
      if (res && res.status === 'matched' && res.untappd_id != null) {
        deps.setEnriched(beer.key, res.untappd_id, res.rating_global ?? null);
      } else {
        deps.setOrphan(beer.key, cand.brewery, cand.name);
      }
    } catch {
      deps.setOrphan(beer.key, cand.brewery, cand.name);
    }

    if (i < eligible.length - 1) await sleep(delayMs);
  }
}
