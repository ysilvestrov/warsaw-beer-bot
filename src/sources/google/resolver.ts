// src/sources/google/resolver.ts
export interface ResolvedBeer {
  bid: number;
  beer_name: string;
  brewery_name: string;
  abv: number | null; // best-effort from CSE pagemap; null if absent
}

export interface WebResolver {
  resolve(brewery: string, name: string): Promise<ResolvedBeer[]>;
}

interface CseItem {
  title?: unknown;
  link?: unknown;
  pagemap?: { metatags?: Array<Record<string, unknown>> };
}
export interface CseResponse {
  items?: CseItem[];
}

// Untappd beer pages are `/b/<slug>/<digits>` — same shape parsed in search.ts.
function bidFromLink(link: unknown): number | null {
  if (typeof link !== 'string') return null;
  const m = link.match(/\/b\/[^/]+\/(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// CSE title is "<Beer Name> - <Brewery> - Untappd". Split from the right so beer
// names containing " - " survive: the last two segments are brewery and the
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

function abvFromPagemap(item: CseItem): number | null {
  const tags = item.pagemap?.metatags;
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    for (const v of Object.values(tag)) {
      if (typeof v !== 'string') continue;
      const m = v.match(/(\d+(?:[.,]\d+)?)\s*%/);
      if (m) {
        const n = parseFloat(m[1].replace(',', '.'));
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}

export function parseCseResponse(json: CseResponse): ResolvedBeer[] {
  const items = Array.isArray(json.items) ? json.items : [];
  const out: ResolvedBeer[] = [];
  for (const item of items) {
    const bid = bidFromLink(item.link);
    if (bid === null) continue;
    const names = splitTitle(item.title);
    if (!names) continue;
    out.push({ bid, beer_name: names.beer_name, brewery_name: names.brewery_name, abv: abvFromPagemap(item) });
  }
  return out;
}

export interface GoogleResolverOpts {
  key: string;
  cx: string;
  num?: number;              // results to request (default 3)
  fetchImpl?: typeof fetch;
}

export function createGoogleResolver(opts: GoogleResolverOpts): WebResolver {
  const f = opts.fetchImpl ?? fetch;
  const num = opts.num ?? 3;
  return {
    async resolve(brewery: string, name: string): Promise<ResolvedBeer[]> {
      const q = encodeURIComponent(`${brewery} ${name}`.trim());
      const url =
        `https://www.googleapis.com/customsearch/v1` +
        `?key=${encodeURIComponent(opts.key)}&cx=${encodeURIComponent(opts.cx)}&q=${q}&num=${num}`;
      try {
        const res = await f(url);
        if (!res.ok) return []; // 429 quota / any error → "no resolution"
        return parseCseResponse((await res.json()) as CseResponse);
      } catch {
        return [];
      }
    },
  };
}
