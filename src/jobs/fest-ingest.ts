import type { DB } from '../storage/db';
import { parseCheckinFeedPage, feedCheckinTime } from '../sources/untappd/checkin-feed';
import { parseVenueMenu } from '../sources/untappd/venue-menu';
import { isBlockPage } from '../sources/untappd/block';
import { upsertBeerByBid } from '../storage/beers';
import { normalizeBrewery, normalizeName } from '../domain/normalize';
import { insertVenueCheckins, venueCheckinAt, type Eye } from '../storage/venue_checkins';
import { addCoverage, coverageSince } from '../storage/fest_coverage';
import { upsertMenuItem } from '../storage/fest_menu';
import { pageSpan, touches } from '../domain/fest/coverage';

export class BlockedPageError extends Error {
  constructor() {
    super('untappd block page');
    this.name = 'BlockedPageError';
  }
}

export interface FeedPageInput {
  venueId: number;
  html: string;
  /** checkin_id the page was requested below (more_feed); null for the head page. */
  cursor: string | null;
  fetchedAt: string;
  eye: Eye;
  now: string;
}

export interface FeedPageResult {
  /** Check-ins new to the database. */
  inserted: number;
  /** Check-ins on the page with a usable time. */
  seen: number;
  /** Check-ins on the page without a second-precision time (not stored). */
  dropped: number;
  /** Whether the page's proven span overlaps or touches existing coverage of this venue. */
  stitched: boolean;
  /** Cursor for the next (older) page; null on an empty page. */
  nextCursor: string | null;
}

// The single write path for every eye (spec §4.2): laptop relay, server poller, friend feed.
export function ingestFeedPage(db: DB, p: FeedPageInput): FeedPageResult {
  if (isBlockPage(p.html)) throw new BlockedPageError();
  const page = parseCheckinFeedPage(p.html);

  const rows = page.checkins.flatMap((c) => {
    const at = feedCheckinTime(c.checkin_at);
    return at === null
      ? []
      : [{ checkin_id: Number(c.checkin_id), venue_id: p.venueId, bid: c.bid, untappd_user: c.author, checkin_at: at }];
  });
  const dropped = page.checkins.length - rows.length;

  // A row we could not place in time is a check-in we saw but cannot vouch for, so the page
  // proves no span at all. A cursor we never stored leaves the upper bound unproven too.
  const cursorAt = p.cursor === null ? null : venueCheckinAt(db, Number(p.cursor));
  const span = dropped > 0 || (p.cursor !== null && cursorAt === null)
    ? null
    : pageSpan({ checkinTimes: rows.map((r) => r.checkin_at), cursorAt, fetchedAt: p.fetchedAt, now: p.now });

  return db.transaction((): FeedPageResult => {
    const stitched = span !== null && touches(coverageSince(db, p.venueId, span.from_at), span);
    const inserted = insertVenueCheckins(db, rows, p.eye, p.now);
    if (span !== null) addCoverage(db, p.venueId, span, p.eye, p.now);
    return { inserted, seen: rows.length, dropped, stitched, nextCursor: page.nextMaxId };
  })();
}

export interface MenuPageResult {
  items: number;
  updatedAt: string | null;
}

// Menu items come from Untappd's own venue page, so the bid is Untappd's record ('checkin'
// provenance, which a later shop-published bid may not override).
export function ingestMenuPage(db: DB, p: { festId: number; html: string; now: string }): MenuPageResult {
  if (isBlockPage(p.html)) throw new BlockedPageError();
  const menu = parseVenueMenu(p.html);
  db.transaction(() => {
    for (const item of menu.items) {
      const beerId = upsertBeerByBid(db, {
        untappd_id: item.bid,
        name: item.name,
        brewery: item.brewery,
        style: item.style,
        abv: item.abv,
        rating_global: item.rating,
        normalized_name: normalizeName(item.name),
        normalized_brewery: normalizeBrewery(item.brewery),
        untappd_id_source: 'checkin',
      });
      upsertMenuItem(db, p.festId, beerId, item.section, p.now);
    }
  })();
  return { items: menu.items.length, updatedAt: menu.updatedAt };
}
