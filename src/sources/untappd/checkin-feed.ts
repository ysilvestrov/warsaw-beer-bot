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
  /** Untappd venue id from the row's /v/<slug>/<id> link; null when the row names no venue. */
  venue_id: number | null;
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
const VENUE_ID_RE = /^\/v\/[^/]+\/(\d+)/;

// The author is the p.text anchor marked a.user; fall back to the first /user/ link there.
function authorFrom($: cheerio.CheerioAPI, row: cheerio.Cheerio<Element>): string | null {
  const anchor = row.find('p.text a.user[href^="/user/"]').first();
  const href = (anchor.length ? anchor : row.find('p.text a[href^="/user/"]').first()).attr('href') ?? '';
  const m = href.match(USER_RE);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    // A malformed escape ("%zz") must not abort the whole page; the raw segment is still the name.
    return m[1];
  }
}

// Only formats that carry a time to the second are accepted: Untappd's RFC 2822 ("Tue, 31 Mar 2026
// 12:13:15 +0000", HTML text / data-gregtime / API created_at) and ISO 8601 with seconds and an
// offset. Anything else — the browser-collapsed "11 Sep 26", an ISO date, a minute-precision time —
// would be completed by Date.parse with invented components, so it is rejected (spec §10, "time").
const RFC2822_SECONDS_RE = /^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/;
const ISO_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** A check-in time with second precision as ISO UTC, or null when `raw` does not carry one. */
export function feedCheckinTime(raw: string): string | null {
  const s = raw.trim();
  if (!RFC2822_SECONDS_RE.test(s) && !ISO_SECONDS_RE.test(s)) return null;
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
    const venueLink = row.find('p.text a[href^="/v/"]').first();
    const venueText = venueLink.text().trim();
    const venue = venueText.length > 0 ? venueText : null;
    const venueIdMatch = (venueLink.attr('href') ?? '').match(VENUE_ID_RE);
    const venue_id = venueIdMatch ? parseInt(venueIdMatch[1], 10) : null;

    checkins.push({ checkin_id, bid, beer_name, brewery_name, user_rating, checkin_at, venue, venue_id, author: authorFrom($, row) });
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
