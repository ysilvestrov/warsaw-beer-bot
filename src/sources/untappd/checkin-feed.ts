import * as cheerio from 'cheerio';

export interface FeedCheckin {
  checkin_id: string;
  bid: number;
  beer_name: string;
  brewery_name: string;
  user_rating: number | null;
  checkin_at: string;
  venue: string | null;
}

export interface CheckinFeedPage {
  checkins: FeedCheckin[];
  nextMaxId: string | null;
  profileTotal: number | null;
}

const BID_RE = /\/b\/[^/]+\/(\d+)/;

function parseRating(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// The brewery is the one anchor inside p.text that isn't the user, the beer (/b/),
// or the venue (/v/) — Untappd renders breweries with varied hrefs (vanity like
// /Pohjala or canonical /w/<slug>/<id>), so we identify it by exclusion.
function breweryNameFrom($: cheerio.CheerioAPI, row: cheerio.Cheerio<cheerio.Element>): string {
  let name = '';
  row.find('p.text a').each((_, a) => {
    if (name) return false;
    const el = $(a);
    const href = el.attr('href') ?? '';
    if (href.startsWith('/user/') || href.startsWith('/b/') || href.startsWith('/v/')) return;
    if (el.hasClass('user')) return;
    name = el.text().replace(/\s+/g, ' ').trim();
  });
  return name;
}

function parseProfileTotal($: cheerio.CheerioAPI): number | null {
  let profileTotal: number | null = null;
  $('div.stats a').each((_, a) => {
    if (profileTotal !== null) return false;
    const el = $(a);
    if (el.find('.title').text().trim() === 'Total') {
      const statText = el.find('.stat').text().replace(/[,\s]/g, '');
      const n = parseInt(statText, 10);
      if (Number.isFinite(n)) profileTotal = n;
    }
  });
  return profileTotal;
}

export function parseCheckinFeedPage(html: string): CheckinFeedPage {
  const $ = cheerio.load(html);
  const checkins: FeedCheckin[] = [];

  $('div.item[data-checkin-id]').each((_, el) => {
    const row = $(el);

    // checkin_id
    const checkin_id = (row.attr('data-checkin-id') ?? '').trim();
    if (!/^\d+$/.test(checkin_id)) return;

    // bid — first a[href^="/b/"] in the whole item
    let bid: number | null = null;
    row.find('a[href^="/b/"]').each((_, a) => {
      if (bid !== null) return false; // already found
      const href = $(a).attr('href') ?? '';
      const m = href.match(BID_RE);
      if (m) bid = parseInt(m[1], 10);
    });
    if (bid === null) return; // skip if no valid bid found

    // beer_name — scoped to p.text
    const beer_name = row
      .find('p.text a[href^="/b/"]')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    if (!beer_name) return;

    // brewery_name — first anchor in p.text that is not user/beer/venue
    const brewery_name = breweryNameFrom($, row);
    if (!brewery_name) return;

    // user_rating
    const user_rating = parseRating(row.find('.caps[data-rating]').first().attr('data-rating'));

    // checkin_at
    const checkin_at = row.find('a.time').first().text().trim();
    if (!checkin_at) return;

    // venue — scoped to p.text (NOT .checkin-comment)
    const venueText = row.find('p.text a[href^="/v/"]').first().text().trim();
    const venue = venueText.length > 0 ? venueText : null;

    checkins.push({ checkin_id, bid, beer_name, brewery_name, user_rating, checkin_at, venue });
  });

  const profileTotal = parseProfileTotal($);

  // Untappd renders an .more_checkins button only when older pages exist.
  let nextMaxId: string | null = null;
  if (checkins.length > 0 && $('.more_checkins').length > 0) {
    nextMaxId = checkins[checkins.length - 1].checkin_id;
  }

  return { checkins, nextMaxId, profileTotal };
}
