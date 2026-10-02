import type { DB } from '../storage/db';
import { parseCheckinFeedPage, feedCheckinTime } from '../sources/untappd/checkin-feed';
import { parseVenueMenu, type VenueMenu } from '../sources/untappd/venue-menu';
import { isBlockPage } from '../sources/untappd/block';
import { upsertBeerByBid } from '../storage/beers';
import { normalizeBrewery, normalizeName } from '../domain/normalize';
import { insertVenueCheckins, venueCheckinAt, type Eye } from '../storage/venue_checkins';
import { addCoverage, coverageSince } from '../storage/fest_coverage';
import { upsertMenuItem } from '../storage/fest_menu';
import { getJobState, setJobState } from '../storage/job_state';
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
  /** Check-ins of this venue without a second-precision time (not stored). */
  dropped: number;
  /** Check-ins whose venue link is not this venue (not stored). */
  mismatched: number;
  /** Whether the page's proven span overlaps or touches existing coverage of this venue. */
  stitched: boolean;
  /** Cursor for the next (older) page; null on an empty page. */
  nextCursor: string | null;
}

export type CheckinPageResult = Omit<FeedPageResult, 'nextCursor'>;

/** A check-in as an eye read it, before this venue's rules are applied. */
export interface CheckinRowInput {
  checkin_id: number;
  /** The venue the check-in names; null when it names none. */
  venue_id: number | null;
  bid: number;
  untappd_user: string | null;
  /** ISO time to the second; null when the source gave no such time. */
  checkin_at: string | null;
}

export interface CheckinPageInput {
  venueId: number;
  /** The page's check-ins, newest first, as the source listed them. */
  rows: CheckinRowInput[];
  /** checkin_id the page was requested below; null for the head page. */
  cursor: number | null;
  fetchedAt: string;
  eye: Eye;
  now: string;
  /** False when the source cannot vouch that the page is the venue as it is now (MCP mem). */
  provesCoverage: boolean;
}

// The single write path for every eye (spec §4.2): laptop relay, server poller, friend feed, MCP
// venue eye. HTML pages arrive through ingestFeedPage; the MCP eye hands its rows here directly.
export function ingestCheckinRows(db: DB, p: CheckinPageInput): CheckinPageResult {
  // A row whose venue link names another venue (or none) does not belong to this feed: a relay
  // that pairs one venue's page with another's id must not create check-ins or coverage there.
  const here = p.rows.filter((c) => c.venue_id === p.venueId);
  const mismatched = p.rows.length - here.length;
  const rows = here.flatMap((c) => (c.checkin_at === null
    ? []
    : [{ checkin_id: c.checkin_id, venue_id: p.venueId, bid: c.bid, untappd_user: c.untappd_user, checkin_at: c.checkin_at }]));
  const dropped = here.length - rows.length;

  // A row we could not place in time or in this venue is a check-in we saw but cannot vouch for,
  // so the page proves no span at all. A cursor we never stored leaves the upper bound unproven too.
  const cursorAt = p.cursor === null ? null : venueCheckinAt(db, p.cursor, p.venueId);
  const span = !p.provesCoverage || dropped > 0 || mismatched > 0 || (p.cursor !== null && cursorAt === null)
    ? null
    : pageSpan({ checkinTimes: rows.map((r) => r.checkin_at), cursorAt, fetchedAt: p.fetchedAt, now: p.now });

  return db.transaction((): CheckinPageResult => {
    const stitched = span !== null && touches(coverageSince(db, p.venueId, span.from_at), span);
    const inserted = insertVenueCheckins(db, rows, p.eye, p.now);
    if (span !== null) addCoverage(db, p.venueId, span, p.eye, p.now);
    return { inserted, seen: rows.length, dropped, mismatched, stitched };
  })();
}

/** An HTML feed page (laptop relay, server poller): parsed here, then the common path above. */
export function ingestFeedPage(db: DB, p: FeedPageInput): FeedPageResult {
  if (isBlockPage(p.html)) throw new BlockedPageError();
  const page = parseCheckinFeedPage(p.html);
  const result = ingestCheckinRows(db, {
    venueId: p.venueId,
    rows: page.checkins.map((c) => ({
      checkin_id: Number(c.checkin_id), venue_id: c.venue_id, bid: c.bid, untappd_user: c.author,
      checkin_at: feedCheckinTime(c.checkin_at),
    })),
    cursor: p.cursor === null ? null : Number(p.cursor),
    fetchedAt: p.fetchedAt, eye: p.eye, now: p.now, provesCoverage: true,
  });
  return { ...result, nextCursor: page.nextMaxId };
}

export interface MenuPageResult {
  items: number;
  updatedAt: string | null;
  /** The page is older than the menu already applied; nothing was written. */
  stale: boolean;
}

const menuUpdatedKey = (festId: number): string => `fest_menu_updated_at:${festId}`;

// Menu items come from Untappd's own venue page, so the bid is Untappd's record ('checkin'
// provenance, which a later shop-published bid may not override).
export function ingestMenuPage(db: DB, p: { festId: number; html: string; now: string }): MenuPageResult {
  if (isBlockPage(p.html)) throw new BlockedPageError();
  return applyMenu(db, p.festId, parseVenueMenu(p.html), p.now);
}

/** Writes an already-parsed menu; the route parses first to learn which fest the page belongs to. */
export function applyMenu(db: DB, festId: number, menu: VenueMenu, now: string): MenuPageResult {
  return db.transaction((): MenuPageResult => {
    // Two eyes can relay the menu out of order; a page whose "updated" stamp is older than the
    // one already applied must not roll the menu back. A page without a stamp cannot be ordered
    // and is applied (upserts only add rows and refresh last_seen_at).
    const applied = getJobState(db, menuUpdatedKey(festId));
    if (menu.updatedAt !== null && applied !== null && menu.updatedAt < applied) {
      return { items: menu.items.length, updatedAt: menu.updatedAt, stale: true };
    }
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
      upsertMenuItem(db, festId, beerId, item.section, now);
    }
    if (menu.updatedAt !== null) setJobState(db, menuUpdatedKey(festId), menu.updatedAt);
    return { items: menu.items.length, updatedAt: menu.updatedAt, stale: false };
  })();
}
