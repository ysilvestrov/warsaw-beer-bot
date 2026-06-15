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

export function parseCheckinFeedPage(html: string): CheckinFeedPage {
  const $ = cheerio.load(html);
  const checkins: FeedCheckin[] = [];

  $('div.item[data-checkin-id]').each((_, el) => {
    const row = $(el);

    // checkin_id
    const checkin_id = (row.attr('data-checkin-id') ?? '').trim();
    if (!/^\d+$/.test(checkin_id)) return;

    // bid — first a[href^="/b/"] in the whole item
    let bid = 0;
    row.find('a[href^="/b/"]').each((_, a) => {
      if (bid) return false; // already found
      const href = $(a).attr('href') ?? '';
      const m = href.match(BID_RE);
      if (m) bid = parseInt(m[1], 10);
    });
    if (!bid) return; // skip if no valid bid found

    // beer_name — scoped to p.text
    const beer_name = row
      .find('p.text a[href^="/b/"]')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    if (!beer_name) return;

    // brewery_name — first anchor in p.text that is not user/beer/venue
    let brewery_name = '';
    row.find('p.text a').each((_, a) => {
      if (brewery_name) return false;
      const el = $(a);
      const href = el.attr('href') ?? '';
      if (href.startsWith('/user/') || href.startsWith('/b/') || href.startsWith('/v/')) return;
      if (el.hasClass('user')) return;
      brewery_name = el.text().replace(/\s+/g, ' ').trim();
    });
    if (!brewery_name) return;

    // user_rating
    const ratingRaw = row.find('.caps[data-rating]').first().attr('data-rating');
    const user_rating = ratingRaw !== undefined ? (parseFloat(ratingRaw) || null) : null;

    // checkin_at
    const checkin_at = row.find('a.time').first().text().trim();
    if (!checkin_at) return;

    // venue — scoped to p.text (NOT .checkin-comment)
    const venueText = row.find('p.text a[href^="/v/"]').first().text().trim();
    const venue = venueText.length > 0 ? venueText : null;

    checkins.push({ checkin_id, bid, beer_name, brewery_name, user_rating, checkin_at, venue });
  });

  // profileTotal
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

  // nextMaxId
  let nextMaxId: string | null = null;
  if (checkins.length > 0 && $('.more_checkins').length > 0) {
    nextMaxId = checkins[checkins.length - 1].checkin_id;
  }

  return { checkins, nextMaxId, profileTotal };
}
