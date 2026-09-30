import type { DB } from '../storage/db';
import { getFest, festVenues } from '../storage/fests';
import { menuFor, menuStats } from '../storage/fest_menu';
import { members, overridesFor } from '../storage/fest_teams';
import { standsFor, type FestStand } from '../storage/fest_stands';
import { checkinsSince } from '../storage/venue_checkins';
import { coverageSince } from '../storage/fest_coverage';
import { triedBeerIds } from '../storage/untappd_had';
import { countCheckins } from '../storage/checkins';
import { getSyncState } from '../storage/checkin_sync_state';
import { computeTargets, type Target, type TargetMenuItem } from '../domain/fest/targets';
import { tapStatus, TAP_WINDOW_MS, type TapStatus } from '../domain/fest/tap-status';
import { rankSections, type SectionRank } from '../domain/fest/ranking';
import type { Span } from '../domain/fest/coverage';

export interface MemberHistory {
  telegramId: number;
  initials: string;
  untappdUsername: string | null;
  /** Check-ins the bot holds for this member. */
  inBot: number;
  /** Profile total from the last extension sync; null when never synced — "unknown", not 0. */
  profileTotal: number | null;
}

export interface FestView {
  menuCount: number;
  menuUpdatedAt: string | null;
  members: MemberHistory[];
  targets: Target[];
  unrated: TargetMenuItem[];
  statusByBeer: Map<number, TapStatus>;
  ranking: SectionRank[];
  stands: Map<string, FestStand>;
  /** Untappd bid of each menu beer id, for links and for matching venue check-ins. */
  bidByBeer: Map<number, number>;
  /** Display name and brewery of each menu beer id. */
  beerNames: Map<number, { name: string; brewery: string }>;
}

// The one place where the database meets the pure festival core (spec §5–§6). Venue check-ins
// carry Untappd bids while the menu and history carry beers.id, so statuses are joined through
// beers.untappd_id; a menu beer without a bid can never be seen on tap and stays "unknown".
export function buildFestView(db: DB, p: { festId: number; teamId: number; now: Date }): FestView {
  const fest = getFest(db, p.festId);
  if (!fest) throw new Error(`fest ${p.festId} not found`);
  const menu = menuFor(db, p.festId);
  const stats = menuStats(db, p.festId);
  const team = members(db, p.teamId);

  const history: MemberHistory[] = team.map((m) => ({
    telegramId: m.telegram_id,
    initials: m.initials,
    untappdUsername: m.untappd_username,
    inBot: countCheckins(db, m.telegram_id),
    profileTotal: getSyncState(db, m.telegram_id).profile_total,
  }));

  const { targets, unrated } = computeTargets({
    menu,
    triedByMember: team.map((m) => triedBeerIds(db, m.telegram_id)),
    overrides: overridesFor(db, p.teamId),
    criteria: { minRating: fest.target_min_rating, stylePatterns: fest.target_style_patterns },
  });

  const bidByBeer = new Map<number, number>();
  const beerNames = new Map<number, { name: string; brewery: string }>();
  for (const m of menu) {
    if (m.untappd_id !== null) bidByBeer.set(m.beer_id, m.untappd_id);
    beerNames.set(m.beer_id, { name: m.name, brewery: m.brewery });
  }

  const venueIds = festVenues(db, p.festId).map((v) => v.venue_id);
  const since = new Date(p.now.getTime() - TAP_WINDOW_MS).toISOString();
  const checkins = checkinsSince(db, venueIds, since);
  const coverageByVenue = new Map<number, Span[]>(venueIds.map((v) => [v, coverageSince(db, v, since)]));

  const statusByBeer = new Map<number, TapStatus>();
  for (const t of targets) {
    const bid = bidByBeer.get(t.beerId);
    statusByBeer.set(t.beerId, bid === undefined
      ? { kind: 'unknown' }
      : tapStatus({ bid, checkins, coverageByVenue, venueIds, now: p.now }));
  }

  return {
    menuCount: stats.count,
    menuUpdatedAt: stats.lastSeenAt,
    members: history,
    targets,
    unrated,
    statusByBeer,
    ranking: rankSections(targets, statusByBeer),
    stands: standsFor(db, p.festId),
    bidByBeer,
    beerNames,
  };
}
