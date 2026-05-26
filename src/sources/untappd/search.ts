import * as cheerio from 'cheerio';

export interface SearchResult {
  bid: number;
  beer_name: string;
  brewery_name: string;
  style: string | null;
  abv: number | null;
  global_rating: number | null;
}

const MAX_ITEMS = 5;

function parseRating(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function parseAbv(raw: string): number | null {
  const m = raw.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Untappd search renders bid only in the `.name a` href as
// `/b/<slug>/<digits>` — extract from there.
function extractBidFromHref(href: string | undefined): number | null {
  if (!href) return null;
  const m = href.match(/\/b\/[^/]+\/(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function buildSearchUrl(query: string): string {
  const q = encodeURIComponent(query);
  return `https://untappd.com/search?q=${q}&type=beer`;
}

export function parseSearchPage(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];

  $('.beer-item').each((_, el) => {
    if (out.length >= MAX_ITEMS) return false;
    const row = $(el);

    const details = row.find('.beer-details').first();
    const nameAnchor = details.find('.name a').first();
    const bid = extractBidFromHref(nameAnchor.attr('href'));
    if (bid === null) return;

    const beer_name = nameAnchor.text().trim().replace(/\s+/g, ' ');
    const brewery_name = details.find('.brewery a').first().text().trim().replace(/\s+/g, ' ');
    const styleText = details.find('.style').first().text().trim().replace(/\s+/g, ' ');
    const style = styleText.length > 0 ? styleText : null;

    const detailsBeer = row.find('.details.beer').first();
    const abvText = detailsBeer.find('.abv').first().text().trim();
    const abv = abvText ? parseAbv(abvText) : null;

    const global_rating = parseRating(
      detailsBeer.find('.rating .caps[data-rating]').first().attr('data-rating'),
    );

    out.push({ bid, beer_name, brewery_name, style, abv, global_rating });
  });

  return out;
}
