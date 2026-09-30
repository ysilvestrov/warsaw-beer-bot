import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { ensureProfile, setUntappdUsername } from '../storage/user_profiles';
import { getFestBySlug } from '../storage/fests';
import { addMember, createTeam } from '../storage/fest_teams';
import { upsertMenuItem } from '../storage/fest_menu';
import { upsertStand } from '../storage/fest_stands';
import { insertVenueCheckins } from '../storage/venue_checkins';
import { addCoverage } from '../storage/fest_coverage';
import { markHad } from '../storage/untappd_had';
import { recordProfileTotal } from '../storage/checkin_sync_state';
import { buildFestView } from './fest-view';

const NOW = new Date('2026-10-15T18:00:00.000Z');
const FEST_VENUE = 11142155;
const VENUES = [11142155, 2815864, 2167060];

function beer(db: DB, id: number, bid: number | null, rating: number | null, style: string, name = `beer-${id}`): void {
  db.prepare(
    `INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery, style, rating_global)
     VALUES (?, ?, ?, 'Brew', ?, 'brew', ?, ?)`,
  ).run(id, bid, name, name, style, rating);
}

function setup(): { db: DB; festId: number; teamId: number } {
  const db = openDb(':memory:');
  migrate(db);
  const festId = getFestBySlug(db, 'wfp22')!.id;
  for (const [id, name] of [[1, 'ysilvestrov'], [2, 'Nesh05']] as const) {
    ensureProfile(db, id);
    setUntappdUsername(db, id, name);
  }
  const team = createTeam(db, festId, -100, '2026-10-01T00:00:00.000Z');
  addMember(db, team.id, 1, 'YS', '2026-10-01T00:00:00.000Z');
  addMember(db, team.id, 2, 'OB', '2026-10-01T00:00:00.000Z');
  beer(db, 10, 6000010, 4.2, 'IPA - American', 'Alpha');     // member 2 had it → not a Target
  beer(db, 11, 6000011, 4.1, 'IPA - American', 'Bravo');     // Target by rating
  beer(db, 12, 6000012, 3.2, 'Stout - Imperial / Double', 'Charlie'); // Target by style
  upsertMenuItem(db, festId, 10, 'PINTA', '2026-10-15T10:00:00.000Z');
  upsertMenuItem(db, festId, 11, 'PINTA', '2026-10-15T10:00:00.000Z');
  upsertMenuItem(db, festId, 12, 'Verdant', '2026-10-15T11:00:00.000Z');
  markHad(db, 2, 10, '2026-09-01T00:00:00.000Z');
  return { db, festId, teamId: team.id };
}

const coverAll = (db: DB, venues = VENUES) => {
  for (const v of venues) {
    addCoverage(db, v, { from_at: '2026-10-15T16:30:00.000Z', to_at: NOW.toISOString() }, 'laptop', NOW.toISOString());
  }
};

describe('buildFestView', () => {
  it('lists Targets untried by every member, with reasons', () => {
    const { db, festId, teamId } = setup();
    const view = buildFestView(db, { festId, teamId, now: NOW });
    expect(view.targets.map((t) => [t.beerId, t.reasons])).toEqual([[11, ['rating']], [12, ['style']]]);
    expect([view.menuCount, view.menuUpdatedAt]).toEqual([3, '2026-10-15T11:00:00.000Z']);
  });

  it('marks a Target on tap from a stadium check-in and puts its section first', () => {
    const { db, festId, teamId } = setup();
    insertVenueCheckins(db, [{ checkin_id: 1, venue_id: 2167060, bid: 6000012, untappd_user: 'x', checkin_at: '2026-10-15T17:50:00.000Z' }], 'laptop', NOW.toISOString());
    coverAll(db);
    const view = buildFestView(db, { festId, teamId, now: NOW });
    expect(view.statusByBeer.get(12)).toEqual({ kind: 'on_tap', lastAt: '2026-10-15T17:50:00.000Z', count: 1 });
    expect(view.statusByBeer.get(11)).toEqual({ kind: 'not_seen' });
    expect(view.ranking.map((r) => [r.section, r.onTap])).toEqual([['Verdant', 1], ['PINTA', 0]]);
  });

  it('with one venue unwatched, a Target without a check-in is unknown', () => {
    const { db, festId, teamId } = setup();
    coverAll(db, [FEST_VENUE, 2815864]);
    expect(buildFestView(db, { festId, teamId, now: NOW }).statusByBeer.get(11)).toEqual({ kind: 'unknown' });
  });

  it('reports history completeness, with an unknown profile total as null', () => {
    const { db, festId, teamId } = setup();
    recordProfileTotal(db, 1, 12709);
    expect(buildFestView(db, { festId, teamId, now: NOW }).members.map((m) => [m.initials, m.inBot, m.profileTotal]))
      .toEqual([['YS', 0, 12709], ['OB', 0, null]]);
  });

  it('a menu beer without a bid is never on tap and stays unknown', () => {
    const { db, festId, teamId } = setup();
    beer(db, 13, null, 4.5, 'IPA - American', 'Delta');
    upsertMenuItem(db, festId, 13, 'PINTA', '2026-10-15T10:00:00.000Z');
    coverAll(db);
    const view = buildFestView(db, { festId, teamId, now: NOW });
    expect([view.statusByBeer.get(13), view.bidByBeer.has(13)]).toEqual([{ kind: 'unknown' }, false]);
  });

  it('carries stands by section', () => {
    const { db, festId, teamId } = setup();
    upsertStand(db, festId, { section: 'PINTA', floor: '2', stand: 'B14' }, 1, NOW.toISOString());
    expect(buildFestView(db, { festId, teamId, now: NOW }).stands.get('PINTA')).toEqual({ section: 'PINTA', floor: '2', stand: 'B14' });
  });
});
