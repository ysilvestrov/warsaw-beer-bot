import type { EnrichResult } from '../api/types';

export const PAGE_NO_ID_CAP = 20;
export const DEFAULT_DELAY_MS = 4000;

export interface OrphanBeer {
  key: string;
  brewery: string;
  name: string;
}

export interface EnrichDeps {
  getCandidates: (
    beers: { brewery: string; name: string }[],
  ) => Promise<{ brewery: string; name: string; eligible: boolean; searchUrl: string }[]>;
  fetchSearch: (searchUrl: string) => Promise<string | null>;
  trim: (rawHtml: string) => string;
  submitResult: (brewery: string, name: string, html: string) => Promise<EnrichResult>;
  setSearching: (key: string) => void;
  setEnriched: (key: string, untappdId: number, ratingGlobal: number | null) => void;
  setOrphan: (key: string) => void;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const pairKey = (brewery: string, name: string) => `${brewery} ${name}`;

// Searches the page's orphan beers on Untappd (via deps) one at a time, throttled. Gated:
// if the page has >= PAGE_NO_ID_CAP orphans, abstains entirely (leave it to the server).
export async function runEnrichment(orphans: OrphanBeer[], deps: EnrichDeps): Promise<void> {
  if (orphans.length === 0 || orphans.length >= PAGE_NO_ID_CAP) return;

  const candidates = await deps.getCandidates(
    orphans.map((o) => ({ brewery: o.brewery, name: o.name })),
  );
  const byPair = new Map(orphans.map((o) => [pairKey(o.brewery, o.name), o]));
  const eligible = candidates.filter((c) => c.eligible);

  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 0; i < eligible.length; i++) {
    const cand = eligible[i];
    const beer = byPair.get(pairKey(cand.brewery, cand.name));
    if (!beer) continue;

    deps.setSearching(beer.key);
    try {
      const raw = await deps.fetchSearch(cand.searchUrl);
      const res = raw ? await deps.submitResult(cand.brewery, cand.name, deps.trim(raw)) : null;
      if (res && res.status === 'matched' && res.untappd_id != null) {
        deps.setEnriched(beer.key, res.untappd_id, res.rating_global ?? null);
      } else {
        deps.setOrphan(beer.key);
      }
    } catch {
      deps.setOrphan(beer.key);
    }

    if (i < eligible.length - 1) await sleep(delayMs);
  }
}
