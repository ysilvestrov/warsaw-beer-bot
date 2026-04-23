import * as cheerio from 'cheerio';

export interface ScrapedCheckin {
  checkin_id: string;
  beer_name: string;
  brewery_name: string;
  rating_score: number | null;
  checkin_at: string;
  bid: number | null;
}

export function parseUserBeerPage(html: string): ScrapedCheckin[] {
  const $ = cheerio.load(html);
  const out: ScrapedCheckin[] = [];

  $('.item[data-checkin-id]').each((_, el) => {
    const row = $(el);
    const checkin_id = row.attr('data-checkin-id') ?? '';
    if (!checkin_id) return;

    const text = row.find('.text').first();

    const beerAnchor = text.find('a[href^="/b/"]').first();
    const beer_name = beerAnchor.text().trim().replace(/\s+/g, ' ');

    const beerHref = beerAnchor.attr('href') ?? '';
    const bidMatch = beerHref.match(/\/b\/[^/]+\/(\d+)/);
    const bid = bidMatch ? parseInt(bidMatch[1], 10) : null;

    let brewery_name = '';
    text.find('a').each((_, a) => {
      if (brewery_name) return;
      const href = $(a).attr('href') ?? '';
      if (href.startsWith('/user/') || href.startsWith('/b/') || href.startsWith('/v/')) return;
      const t = $(a).text().trim().replace(/\s+/g, ' ');
      if (t) brewery_name = t;
    });

    const ratingAttr = row.find('.caps[data-rating]').first().attr('data-rating');
    const rating_score = ratingAttr && !Number.isNaN(parseFloat(ratingAttr))
      ? parseFloat(ratingAttr) : null;

    const checkin_at = row.find('a.time.timezoner').first().text().trim();

    if (!beer_name || !brewery_name) return;

    out.push({ checkin_id, beer_name, brewery_name, rating_score, checkin_at, bid });
    if (out.length >= 25) return false;
  });

  return out;
}
