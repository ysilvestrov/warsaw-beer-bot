import type { Verdict } from './triage-analysis';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';
import { normalizeName, normalizeBrewery } from './normalize';

export interface VerifyCausesArgs {
  verdicts: Verdict[];
  search: BeerSearch;
  limit: number;                 // hard cap on verification searches per run
  onError?: (query: string, error: unknown) => void;
}

// A verdict makes a causal claim when it routes the orphan to an issue.
export function isCausal(v: Verdict): boolean {
  return v.issue_number !== null || v.new_issue_key !== null;
}

// "<brewery> — <name>" comparison that tolerates case, diacritics and punctuation
// drift between what the model writes and what Untappd returns.
function targetKey(brewery: string, name: string): string {
  return `${normalizeBrewery(brewery)}|${normalizeName(name)}`;
}

// The model is asked for an em-dash separator, but en-dash/hyphen show up too. Split
// on the FIRST such separator only: beer names legitimately contain dashes.
function expectedKey(expected: string): string | null {
  const m = /\s+[—–-]\s+/.exec(expected);
  if (!m) return null;
  const brewery = expected.slice(0, m.index);
  const name = expected.slice(m.index + m[0].length);
  return brewery.trim() && name.trim() ? targetKey(brewery, name) : null;
}

function resultKeys(results: SearchResult[]): Set<string> {
  return new Set(results.map((r) => targetKey(r.brewery_name, r.beer_name)));
}

// Re-runs each causal verdict's proposed query and reports whether the expected
// target actually came back. Unverified is the safe default: a missing query, an
// unparseable target, an absent hit, an exhausted budget and a failing search all
// resolve to false, so an unprovable cause never reaches GitHub.
export async function verifyCauses(args: VerifyCausesArgs): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  let spent = 0;

  for (const verdict of args.verdicts) {
    if (!isCausal(verdict)) continue;
    const query = verdict.proposed_query?.trim();
    const expected = verdict.expected_target ? expectedKey(verdict.expected_target) : null;
    if (!query || !expected || spent >= args.limit) {
      out.set(verdict.beer_id, false);
      continue;
    }
    spent += 1;
    try {
      out.set(verdict.beer_id, resultKeys(await args.search.search(query)).has(expected));
    } catch (error) {
      args.onError?.(query, error);
      out.set(verdict.beer_id, false);
    }
  }
  return out;
}
