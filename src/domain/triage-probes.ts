import type { UntriagedFailure } from '../storage/enrich_failures';
import type { BeerSearch } from '../sources/untappd/search';
import { cleanSearchQuery } from './normalize';
import { summarizeCandidates } from './candidate-format';

export const PROBE_SEARCHES_PER_ORPHAN = 2;

export interface TriageProbe {
  brewery?: string;   // top-3 for the brewery-only query
  name?: string;      // top-3 for the name-only query
}

export interface CollectProbesArgs {
  orphans: UntriagedFailure[];
  search: BeerSearch;
  limit: number;                 // hard cap on searches for the whole run
  onError?: (query: string, error: unknown) => void;
}

// Deterministic evidence for zero-candidate orphans: what does Untappd hold for
// this brewery, and for this beer name under ANY brewery? Without it the triage
// model is asked to explain a negative with nothing but the query string, which
// is where its wrong hypotheses come from (see the 2026-07-28 design doc).
// Rows that already have candidates need no probe — their evidence is the
// candidate list itself.
export async function collectTriageProbes(
  args: CollectProbesArgs,
): Promise<Map<number, TriageProbe>> {
  const out = new Map<number, TriageProbe>();
  let spent = 0;

  const run = async (query: string): Promise<string | undefined> => {
    if (!query || spent >= args.limit) return undefined;
    spent += 1;
    try {
      return summarizeCandidates(await args.search.search(query));
    } catch (error) {
      args.onError?.(query, error);
      return undefined;   // evidence is best-effort; never fail the run
    }
  };

  for (const orphan of args.orphans) {
    if (orphan.candidates_count > 0) continue;
    if (spent >= args.limit) break;
    const probe: TriageProbe = {};
    const brewery = await run(cleanSearchQuery(orphan.brewery, ''));
    if (brewery !== undefined) probe.brewery = brewery;
    const name = await run(cleanSearchQuery('', orphan.name));
    if (name !== undefined) probe.name = name;
    if (probe.brewery !== undefined || probe.name !== undefined) out.set(orphan.beer_id, probe);
  }
  return out;
}
