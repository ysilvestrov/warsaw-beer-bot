import * as cheerio from 'cheerio';

export interface ScrapedBeer {
  bid: number;
  beer_name: string;
  brewery_name: string;
  style: string | null;
  their_rating: number | null;
  global_rating: number | null;
}

const MAX_ITEMS = 25;

function parseRating(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseUserBeersPage(html: string): ScrapedBeer[] {
  const $ = cheerio.load(html);
  const out: ScrapedBeer[] = [];

  $('.beer-item[data-bid]').each((_, el) => {
    if (out.length >= MAX_ITEMS) return false;
    const row = $(el);

    const bidRaw = (row.attr('data-bid') ?? '').trim();
    const bid = parseInt(bidRaw, 10);
    if (!Number.isFinite(bid) || String(bid) !== bidRaw) return;

    const details = row.find('.beer-details').first();
    const beer_name = details.find('.name a').first().text().trim().replace(/\s+/g, ' ');
    const brewery_name = details.find('.brewery a').first().text().trim().replace(/\s+/g, ' ');
    const styleText = details.find('.style').first().text().trim().replace(/\s+/g, ' ');
    const style = styleText.length > 0 ? styleText : null;

    let their_rating: number | null = null;
    let global_rating: number | null = null;
    details.find('.ratings .you').each((_, you) => {
      const label = $(you).find('p').first().text().trim();
      const value = parseRating($(you).find('.caps[data-rating]').first().attr('data-rating'));
      if (/^Their Rating/i.test(label)) their_rating = value;
      else if (/^Global Rating/i.test(label)) global_rating = value;
    });

    out.push({ bid, beer_name, brewery_name, style, their_rating, global_rating });
  });

  return out;
}
