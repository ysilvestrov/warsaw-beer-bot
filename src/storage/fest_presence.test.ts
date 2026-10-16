import { openDb, type DB } from './db';
import { migrate } from './schema';
import { ensureProfile, setUntappdUsername } from './user_profiles';
import { getFestBySlug } from './fests';
import { addMember, createTeam } from './fest_teams';
import { insertVenueCheckins } from './venue_checkins';
import { takeBeer } from './fest_queue';
import { addPresence, presenceEvents } from './fest_presence';

// Presence events (spec 2026-10-15-fest-queue-reality-design.md §PR 2): explicit start/end, and an
// implicit start for each own «Взяв» and each own authored check-in at a venue of the fest.

function setup(): { db: DB; festId: number; teamId: number } {
  const db = openDb(':memory:');
  migrate(db);
  const festId = getFestBySlug(db, 'wfp22')!.id;
  for (const [id, name] of [[1, 'JohnDoe'], [2, 'other']] as const) {
    ensureProfile(db, id);
    setUntappdUsername(db, id, name);
  }
  const teamId = createTeam(db, festId, -100, '2026-10-01T00:00:00.000Z').id;
  addMember(db, teamId, 1, 'JD', '2026-10-01T00:00:00.000Z');
  db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
              VALUES (11, 6000011, 'Bravo', 'Brew', 'bravo', 'brew')`).run();
  return { db, festId, teamId };
}

const SINCE = '2026-10-15T00:00:00.000Z';

describe('presenceEvents', () => {
  it('lists explicit events and implicit starts from own «Взяв» and own venue check-ins, oldest first', () => {
    const { db, festId, teamId } = setup();
    addPresence(db, { teamId, telegramId: 1, kind: 'end', at: '2026-10-15T20:00:00.000Z' });
    addPresence(db, { teamId, telegramId: 1, kind: 'start', at: '2026-10-15T15:00:00.000Z' });
    takeBeer(db, { teamId, beerId: 11, addedBy: 1, at: '2026-10-15T16:00:00.000Z' });
    insertVenueCheckins(db, [
      { checkin_id: 501, venue_id: 2167060, bid: 6000011, untappd_user: 'johndoe', checkin_at: '2026-10-15T17:00:00.000Z' },
    ], 'laptop', SINCE);
    expect(presenceEvents(db, { festId, teamId, sinceIso: SINCE })).toEqual([
      { telegramId: 1, kind: 'start', at: '2026-10-15T15:00:00.000Z' },
      { telegramId: 1, kind: 'start', at: '2026-10-15T16:00:00.000Z' },
      { telegramId: 1, kind: 'start', at: '2026-10-15T17:00:00.000Z' },
      { telegramId: 1, kind: 'end', at: '2026-10-15T20:00:00.000Z' },
    ]);
  });

  it('a venue check-in starts nothing when it is not at a fest venue, has no author, is someone else’s or not a member’s', () => {
    const { db, festId, teamId } = setup();
    insertVenueCheckins(db, [
      { checkin_id: 501, venue_id: 999, bid: 6000011, untappd_user: 'JohnDoe', checkin_at: '2026-10-15T17:00:00.000Z' },
      { checkin_id: 502, venue_id: 2167060, bid: 6000011, untappd_user: null, checkin_at: '2026-10-15T17:01:00.000Z' },
      { checkin_id: 503, venue_id: 2167060, bid: 6000011, untappd_user: 'other', checkin_at: '2026-10-15T17:02:00.000Z' },
      { checkin_id: 504, venue_id: 2167060, bid: 6000011, untappd_user: 'stranger', checkin_at: '2026-10-15T17:03:00.000Z' },
    ], 'laptop', SINCE);
    expect(presenceEvents(db, { festId, teamId, sinceIso: SINCE })).toEqual([]);
  });

  it('leaves out events before `since` and another team’s', () => {
    const { db, festId, teamId } = setup();
    const otherTeam = createTeam(db, festId, -200, '2026-10-01T00:00:00.000Z').id;
    addPresence(db, { teamId, telegramId: 1, kind: 'start', at: '2026-10-14T15:00:00.000Z' });
    addPresence(db, { teamId: otherTeam, telegramId: 1, kind: 'start', at: '2026-10-15T15:00:00.000Z' });
    takeBeer(db, { teamId: otherTeam, beerId: 11, addedBy: 1, at: '2026-10-15T16:00:00.000Z' });
    expect(presenceEvents(db, { festId, teamId, sinceIso: SINCE })).toEqual([]);
  });

  it('an end at the same instant as an implicit start comes after it, so the day still ends', () => {
    const { db, festId, teamId } = setup();
    addPresence(db, { teamId, telegramId: 1, kind: 'end', at: '2026-10-15T16:00:00.000Z' });
    takeBeer(db, { teamId, beerId: 11, addedBy: 1, at: '2026-10-15T16:00:00.000Z' });
    expect(presenceEvents(db, { festId, teamId, sinceIso: SINCE }).map((e) => e.kind)).toEqual(['start', 'end']);
  });
});

describe('migration v51', () => {
  it('records its version and refuses a presence kind nobody defined', () => {
    const { db, teamId } = setup();
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 51').get()).toEqual({ version: 51 });
    expect(() => db.prepare("INSERT INTO fest_presence (team_id, telegram_id, kind, at) VALUES (?, 1, 'pause', 'x')").run(teamId))
      .toThrow(/CHECK constraint failed/);
  });
});
