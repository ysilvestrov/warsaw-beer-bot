import * as cheerio from 'cheerio';

export interface BeerPageData {
  global_rating: number | null;
}

function parseRating(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export function buildBeerPageUrl(bid: number): string {
  return `https://untappd.com/beer/${bid}`;
}

export function parseBeerPage(html: string): BeerPageData {
  const $ = cheerio.load(html);

  // Untappd renders the global rating as <div class="caps" data-rating="X">
  // at the top of the beer page. The fixture (bid 6645513) has the global
  // rating as the FIRST occurrence in document order (class is exactly "caps"
  // — no trailing space). Subsequent .caps[data-rating] elements are checkin
  // sub-cards (class "caps " with trailing space). .first() correctly picks
  // the canonical global one.
  const global_rating = parseRating(
    $('.caps[data-rating]').first().attr('data-rating'),
  );

  return { global_rating };
}
