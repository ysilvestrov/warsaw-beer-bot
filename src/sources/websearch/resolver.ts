// src/sources/websearch/resolver.ts
export interface ResolvedBeer {
  bid: number;
  beer_name: string;
  brewery_name: string;
  abv: number | null; // always null from Brave; hydrated later via Algolia
}

export interface WebResolver {
  resolve(brewery: string, name: string): Promise<ResolvedBeer[]>;
}

interface BraveResult {
  title?: unknown;
  url?: unknown;
}
export interface BraveResponse {
  web?: { results?: BraveResult[] };
}

// Untappd beer pages are `/b/<slug>/<digits>` — same shape parsed in search.ts.
function bidFromLink(link: unknown): number | null {
  if (typeof link !== 'string') return null;
  const m = link.match(/\/b\/[^/]+\/(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// Result titles are "<Beer Name> - <Brewery> - Untappd". Split from the right so
// beer names containing " - " survive: the last two segments are brewery and the
// "Untappd" suffix.
function splitTitle(title: unknown): { beer_name: string; brewery_name: string } | null {
  if (typeof title !== 'string') return null;
  const parts = title.split(' - ').map((s) => s.trim());
  if (parts.length < 3) return null;
  const suffix = parts[parts.length - 1];
  if (!/untappd/i.test(suffix)) return null;
  const brewery_name = parts[parts.length - 2];
  const beer_name = parts.slice(0, parts.length - 2).join(' - ');
  if (!beer_name || !brewery_name) return null;
  return { beer_name, brewery_name };
}

// Brave surfaces `/photos` (and similar) sub-pages as separate results carrying
// the SAME bid as the canonical page, with a garbled brewery segment
// ("Trzech Kumpli | Photos"). Keep the first occurrence: Brave ranks the
// canonical page above its sub-pages.
export function parseBraveResponse(json: BraveResponse): ResolvedBeer[] {
  const results = Array.isArray(json.web?.results) ? json.web!.results! : [];
  const out: ResolvedBeer[] = [];
  const seen = new Set<number>();
  for (const item of results) {
    const bid = bidFromLink(item.url);
    if (bid === null || seen.has(bid)) continue;
    const names = splitTitle(item.title);
    if (!names) continue;
    seen.add(bid);
    out.push({ bid, beer_name: names.beer_name, brewery_name: names.brewery_name, abv: null });
  }
  return out;
}
