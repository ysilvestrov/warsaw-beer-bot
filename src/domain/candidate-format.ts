import type { SearchResult } from '../sources/untappd/search';

const MAX_SUMMARY_ITEMS = 3;

// One evidence line for a search hit. bid/ABV/style are what let a reader (the
// triage LLM, or a human debugging enrich_failures) tell sibling variants apart:
// ABV separates a 0.5% non-alcoholic twin from its 4.5% original, and the bid
// makes the claim checkable. Absent fields are omitted rather than rendered as
// "null" so the line stays readable.
export function formatCandidate(r: SearchResult): string {
  const facts = [`bid ${r.bid}`];
  if (r.abv != null) facts.push(`${r.abv.toFixed(1)}%`);
  if (r.style) facts.push(r.style);
  return `${r.brewery_name} — ${r.beer_name} (${facts.join(', ')})`;
}

// Compact, human-readable summary of what a search returned — top 3 lines.
// Empty string when the search returned nothing (a noisy query).
export function summarizeCandidates(candidates: SearchResult[]): string {
  return candidates.slice(0, MAX_SUMMARY_ITEMS).map(formatCandidate).join('; ');
}
