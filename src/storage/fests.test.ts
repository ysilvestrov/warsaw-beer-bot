import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from './db';
import { migrate } from './schema';
import { activeFest, currentOrNextFest, festSessions, festVenues, getFestBySlug, pollingSessionAt, updateFestVenueFeedPath } from './fests';
import { menuFor, menuStats, upsertMenuItem } from './fest_menu';
import { checkinsSince, insertVenueCheckins, venueCheckinAt } from './venue_checkins';
import { addCoverage, coverageSince } from './fest_coverage';
import { addMember, createTeam, isFestMember, members, overridesFor, setOverride, teamByChat } from './fest_teams';

function seedBeer(db: DB, id: number, bid: number | null = null): void {
  db.prepare(
    'INSERT INTO beers (id, untappd_id, brewery, name, normalized_brewery, normalized_name, style, rating_global) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, bid, `brewery-${id}`, `name-${id}`, `brewery-${id}`, `name-${id}`, 'IPA - American', 3.9);
}

function seedUser(db: DB, telegramId: number, username: string | null): void {
  db.prepare('INSERT INTO user_profiles (telegram_id, untappd_username) VALUES (?, ?)').run(telegramId, username);
}

describe('migration 42 — festival mode', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('records version 42', () => {
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 42').get()).toEqual({ version: 42 });
  });

  it('seeds WFP22 with its target criteria', () => {
    const fest = getFestBySlug(db, 'wfp22')!;
    expect({ ...fest, id: undefined }).toEqual({
      id: undefined,
      slug: 'wfp22',
      name: 'Warszawski Festiwal Piwa 22',
      menu_venue_id: 11142155,
      target_min_rating: 3.8,
      target_style_patterns: ['Imperial', 'Wild Ale', 'Sour', 'Lambic', 'Eisbock', 'Barleywine', 'Wheatwine'],
    });
  });

  it('seeds the three WFP22 sessions in UTC (Warsaw is UTC+2 until 25.10)', () => {
    const fest = getFestBySlug(db, 'wfp22')!;
    expect(festSessions(db, fest.id)).toEqual([
      { session_no: 1, start_at: '2026-10-15T14:00:00.000Z', end_at: '2026-10-15T22:00:00.000Z' },
      { session_no: 2, start_at: '2026-10-16T12:00:00.000Z', end_at: '2026-10-16T22:00:00.000Z' },
      { session_no: 3, start_at: '2026-10-17T10:00:00.000Z', end_at: '2026-10-17T22:00:00.000Z' },
    ]);
  });

  it('seeds the three venues, the festival one on its /activity feed', () => {
    const fest = getFestBySlug(db, 'wfp22')!;
    expect(festVenues(db, fest.id)).toEqual([
      { venue_id: 2167060, label: 'Stadion Legii', feed_path: '/v/stadion-legii-warszawa-im-marszalka-jozefa-pilsudskiego/2167060' },
      { venue_id: 2815864, label: 'Centrum Konferencyjne Legia', feed_path: '/v/centrum-konferencyjne-legia/2815864' },
      { venue_id: 11142155, label: 'Warszawski Festiwal Piwa', feed_path: '/v/warszawski-festiwal-piwa/11142155/activity' },
    ]);
  });

  it('updateFestVenueFeedPath updates feed_path for matching venue', () => {
    const fest = getFestBySlug(db, 'wfp22')!;
    const changes = updateFestVenueFeedPath(db, 11142155, '/v/wfp-future-slug/11142155/activity');
    expect(changes).toBe(1);
    const venues = festVenues(db, fest.id);
    const wfp = venues.find((v) => v.venue_id === 11142155);
    expect(wfp?.feed_path).toBe('/v/wfp-future-slug/11142155/activity');
  });

  it('deleting a fest cascades to its sessions, venues, menu and teams', () => {
    const fest = getFestBySlug(db, 'wfp22')!;
    seedBeer(db, 1);
    upsertMenuItem(db, fest.id, 1, 'PINTA', '2026-09-30T10:00:00.000Z');
    createTeam(db, fest.id, -100, '2026-09-30T10:00:00.000Z');
    db.prepare('DELETE FROM fests WHERE id = ?').run(fest.id);
    const counts = ['fest_sessions', 'fest_venues', 'fest_menu', 'fest_teams'].map(
      (t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    );
    expect(counts).toEqual([0, 0, 0, 0]);
  });
});

describe('activeFest — polling window is each session ± 30 min', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('is null 31 min before the first session', () => {
    expect(activeFest(db, new Date('2026-10-15T13:29:00.000Z'))).toBeNull();
  });

  it('starts exactly 30 min before the first session', () => {
    expect(activeFest(db, new Date('2026-10-15T13:30:00.000Z'))?.session.session_no).toBe(1);
  });

  it('ends exactly 30 min after a session', () => {
    expect(activeFest(db, new Date('2026-10-15T22:30:00.000Z'))?.session.session_no).toBe(1);
  });

  it('is null 31 min after a session', () => {
    expect(activeFest(db, new Date('2026-10-15T22:31:00.000Z'))).toBeNull();
  });

  it('is null between sessions', () => {
    expect(activeFest(db, new Date('2026-10-16T01:00:00.000Z'))).toBeNull();
  });

  it('picks the Saturday session', () => {
    const fest = getFestBySlug(db, 'wfp22')!;
    expect(pollingSessionAt(db, fest.id, new Date('2026-10-17T12:00:00.000Z'))?.session_no).toBe(3);
  });
});

describe('currentOrNextFest', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('is WFP22 during the run-up', () => {
    expect(currentOrNextFest(db, new Date('2026-09-30T10:00:00.000Z'))?.slug).toBe('wfp22');
  });

  it('is WFP22 until 30 min after its last session', () => {
    expect(currentOrNextFest(db, new Date('2026-10-17T22:30:00.000Z'))?.slug).toBe('wfp22');
  });

  it('is null once the last window has closed', () => {
    expect(currentOrNextFest(db, new Date('2026-10-17T22:31:00.000Z'))).toBeNull();
  });
});

describe('fest_menu', () => {
  it('keeps first_seen_at and moves last_seen_at on a repeat sighting', () => {
    const db = openDb(':memory:');
    migrate(db);
    const fest = getFestBySlug(db, 'wfp22')!;
    seedBeer(db, 7, 6134008);
    upsertMenuItem(db, fest.id, 7, 'PINTA', '2026-09-30T10:00:00.000Z');
    upsertMenuItem(db, fest.id, 7, 'PINTA', '2026-10-01T10:00:00.000Z');
    const [row] = menuFor(db, fest.id);
    expect([row.first_seen_at, row.last_seen_at, row.untappd_id]).toEqual([
      '2026-09-30T10:00:00.000Z', '2026-10-01T10:00:00.000Z', 6134008,
    ]);
    expect(menuStats(db, fest.id)).toEqual({ count: 1, lastSeenAt: '2026-10-01T10:00:00.000Z' });
  });

  it('reports an empty menu as zero with no timestamp', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(menuStats(db, getFestBySlug(db, 'wfp22')!.id)).toEqual({ count: 0, lastSeenAt: null });
  });
});

describe('venue_checkins', () => {
  it('dedups one check-in seen by two eyes and keeps the first eye', () => {
    const db = openDb(':memory:');
    migrate(db);
    const row = { checkin_id: 1605001196, venue_id: 11142155, bid: 6134008, untappd_user: 'ysilvestrov', checkin_at: '2026-09-29T20:59:23.000Z' };
    expect(insertVenueCheckins(db, [row], 'laptop', '2026-09-29T21:00:00.000Z')).toBe(1);
    expect(insertVenueCheckins(db, [row], 'friend_feed', '2026-09-29T21:05:00.000Z')).toBe(0);
    expect(db.prepare('SELECT first_eye FROM venue_checkins').get()).toEqual({ first_eye: 'laptop' });
    expect(venueCheckinAt(db, 1605001196, 11142155)).toBe('2026-09-29T20:59:23.000Z');
    expect(venueCheckinAt(db, 1605001196, 2167060)).toBeNull();
    expect(venueCheckinAt(db, 1, 11142155)).toBeNull();
  });

  it('returns only check-ins strictly after the bound, only at the given venues', () => {
    const db = openDb(':memory:');
    migrate(db);
    insertVenueCheckins(db, [
      { checkin_id: 1, venue_id: 11142155, bid: 10, untappd_user: null, checkin_at: '2026-10-15T15:00:00.000Z' },
      { checkin_id: 2, venue_id: 11142155, bid: 11, untappd_user: null, checkin_at: '2026-10-15T15:30:00.000Z' },
      { checkin_id: 3, venue_id: 999, bid: 12, untappd_user: null, checkin_at: '2026-10-15T15:40:00.000Z' },
    ], 'server', '2026-10-15T16:00:00.000Z');
    expect(checkinsSince(db, [11142155, 2167060], '2026-10-15T15:00:00.000Z').map((c) => c.checkin_id)).toEqual([2]);
    expect(checkinsSince(db, [], '2026-10-15T00:00:00.000Z')).toEqual([]);
  });
});

describe('fest_coverage', () => {
  it('returns spans that end at or after the bound and ignores duplicates', () => {
    const db = openDb(':memory:');
    migrate(db);
    addCoverage(db, 11142155, { from_at: '2026-10-15T14:00:00.000Z', to_at: '2026-10-15T14:30:00.000Z' }, 'laptop', 'x');
    addCoverage(db, 11142155, { from_at: '2026-10-15T14:30:00.000Z', to_at: '2026-10-15T15:00:00.000Z' }, 'laptop', 'x');
    addCoverage(db, 11142155, { from_at: '2026-10-15T14:30:00.000Z', to_at: '2026-10-15T15:00:00.000Z' }, 'laptop', 'y');
    addCoverage(db, 2167060, { from_at: '2026-10-15T14:30:00.000Z', to_at: '2026-10-15T15:00:00.000Z' }, 'server', 'x');
    expect(coverageSince(db, 11142155, '2026-10-15T14:30:00.000Z')).toEqual([
      { from_at: '2026-10-15T14:00:00.000Z', to_at: '2026-10-15T14:30:00.000Z' },
      { from_at: '2026-10-15T14:30:00.000Z', to_at: '2026-10-15T15:00:00.000Z' },
    ]);
  });
});

describe('fest_teams', () => {
  let db: DB;
  let festId: number;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    festId = getFestBySlug(db, 'wfp22')!.id;
    seedUser(db, 1, 'ysilvestrov');
    seedUser(db, 2, 'Nesh05');
    seedUser(db, 3, null);
  });

  it('creates one team per chat, idempotently', () => {
    const a = createTeam(db, festId, -100, '2026-09-30T10:00:00.000Z');
    const b = createTeam(db, festId, -100, '2026-09-30T11:00:00.000Z');
    expect(b.id).toBe(a.id);
    expect(teamByChat(db, festId, -200)).toBeNull();
  });

  it('lists members in join order with their Untappd username', () => {
    const team = createTeam(db, festId, -100, '2026-09-30T10:00:00.000Z');
    addMember(db, team.id, 2, 'OB', '2026-09-30T10:01:00.000Z');
    addMember(db, team.id, 1, 'YS', '2026-09-30T10:02:00.000Z');
    addMember(db, team.id, 1, 'XX', '2026-09-30T10:03:00.000Z');
    expect(members(db, team.id)).toEqual([
      { telegram_id: 2, initials: 'OB', untappd_username: 'Nesh05' },
      { telegram_id: 1, initials: 'YS', untappd_username: 'ysilvestrov' },
    ]);
  });

  it('gates membership per fest', () => {
    const team = createTeam(db, festId, -100, '2026-09-30T10:00:00.000Z');
    addMember(db, team.id, 1, 'YS', '2026-09-30T10:00:00.000Z');
    expect([isFestMember(db, festId, 1), isFestMember(db, festId, 2)]).toEqual([true, false]);
  });

  it('keeps the latest override per beer', () => {
    const team = createTeam(db, festId, -100, '2026-09-30T10:00:00.000Z');
    seedBeer(db, 5);
    setOverride(db, team.id, 5, 'add', 1, '2026-09-30T10:00:00.000Z');
    setOverride(db, team.id, 5, 'remove', 2, '2026-09-30T10:05:00.000Z');
    expect([...overridesFor(db, team.id)]).toEqual([[5, 'remove']]);
  });
});
