import * as cheerio from 'cheerio';
import { untappdRating } from './rating';

export interface ScrapedBeer {
  bid: number;
  beer_name: string;
  brewery_name: string;
  style: string | null;
  abv: number | null;
  their_rating: number | null;
  global_rating: number | null;
  /** #616: блок «Global Rating» на картці знайдено — з числом або «N/A». Без блоку сторінка про рейтинг нічого не каже. */
  global_rating_shown: boolean;
}

const MAX_ITEMS = 25;

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

    // .abv lives in the beer-item row but outside .beer-details, so scope to row.
    const abvText = row.find('.abv').first().text().trim();
    const abv = abvText ? parseAbv(abvText) : null;

    let their_rating: number | null = null;
    let global_rating: number | null = null;
    let global_rating_shown = false;
    details.find('.ratings .you').each((_, you) => {
      const label = $(you).find('p').first().text().trim();
      const raw = $(you).find('.caps[data-rating]').first().attr('data-rating');
      if (/^Their Rating/i.test(label)) their_rating = parseRating(raw);
      // #616: глобальний рейтинг Untappd — «0/N/A = менш ніж 10 оцінок», округлення до 2 знаків.
      else if (/^Global Rating/i.test(label)) {
        global_rating = untappdRating(raw);
        global_rating_shown = true;
      }
    });

    out.push({ bid, beer_name, brewery_name, style, abv, their_rating, global_rating, global_rating_shown });
  });

  return out;
}
