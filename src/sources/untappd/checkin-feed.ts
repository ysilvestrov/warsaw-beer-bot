import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';

export interface FeedCheckin {
  checkin_id: string;
  bid: number;
  beer_name: string;
  brewery_name: string;
  user_rating: number | null;
  checkin_at: string;
  venue: string | null;
  /** Untappd username of whoever checked in; null when the row carries no /user/ link. */
  author: string | null;
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
function breweryNameFrom($: cheerio.CheerioAPI, row: cheerio.Cheerio<Element>): string {
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

const USER_RE = /^\/user\/([^/?#]+)/;

// The author is the p.text anchor marked a.user; fall back to the first /user/ link there.
function authorFrom($: cheerio.CheerioAPI, row: cheerio.Cheerio<Element>): string | null {
  const anchor = row.find('p.text a.user[href^="/user/"]').first();
  const href = (anchor.length ? anchor : row.find('p.text a[href^="/user/"]').first()).attr('href') ?? '';
  const m = href.match(USER_RE);
  return m ? decodeURIComponent(m[1]) : null;
}

const DATE_ONLY_RE = /^\d{1,2} [A-Za-z]{3} \d{2}$/;

/**
 * A check-in time with second precision as ISO UTC, or null when `raw` does not carry one.
 * The browser-collapsed "11 Sep 26" is a date without a time and is rejected on purpose: the
 * festival "checked in within 60 min" rule cannot use it (spec §10, "time").
 */
export function feedCheckinTime(raw: string): string | null {
  const s = raw.trim();
  if (!s || DATE_ONLY_RE.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
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

    // checkin_at — data-gregtime first: in a browser DOM the script collapses the a.time text to
    // a bare date ("11 Sep 26") but keeps the full RFC time in the attribute. Raw HTML (server
    // fetch, more_feed fragments) has the RFC time in the text and may lack the attribute.
    const timeEl = row.find('a.time').first();
    const checkin_at = ((timeEl.attr('data-gregtime') ?? '').trim() || timeEl.text().trim());
    if (!checkin_at) return;

    // venue — scoped to p.text (NOT .checkin-comment)
    const venueText = row.find('p.text a[href^="/v/"]').first().text().trim();
    const venue = venueText.length > 0 ? venueText : null;

    checkins.push({ checkin_id, bid, beer_name, brewery_name, user_rating, checkin_at, venue, author: authorFrom($, row) });
  });

  const profileTotal = parseProfileTotal($);

  // Cursor for the next (older) page = the oldest check-in id on this page. Pages
  // are newest→oldest, so the last item is the oldest. We deliberately do NOT gate
  // on the `.more_checkins` button: the full profile page has it, but the
  // `/profile/more_feed/<user>/<offset>` fragments (which serve every page after the
  // first) do not — yet they still have older check-ins. The walk instead stops when
  // a page yields zero check-ins (handled by the caller treating null as feed bottom).
  const nextMaxId = checkins.length > 0 ? checkins[checkins.length - 1].checkin_id : null;

  return { checkins, nextMaxId, profileTotal };
}
