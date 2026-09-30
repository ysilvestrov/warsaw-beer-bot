import { openDb, type DB } from './db';
import { migrate } from './schema';
import { ensureProfile, setUntappdUsername } from './user_profiles';
import { getFestBySlug } from './fests';
import { createTeam } from './fest_teams';
import { insertVenueCheckins } from './venue_checkins';
import { mergeCheckin } from './checkins';
import { memberBeerCheckins, queueFor, takeBeer } from './fest_queue';

function setup(): { db: DB; teamA: number; teamB: number } {
  const db = openDb(':memory:');
  migrate(db);
  const festId = getFestBySlug(db, 'wfp22')!.id;
  ensureProfile(db, 1);
  setUntappdUsername(db, 1, 'JohnDoe');
  db.prepare(
    `INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery) VALUES
     (11, 6000011, 'Bravo', 'Brew', 'bravo', 'brew'), (12, 6000012, 'Charlie', 'Brew', 'charlie', 'brew')`,
  ).run();
  return {
    db,
    teamA: createTeam(db, festId, -100, '2026-10-01T00:00:00.000Z').id,
    teamB: createTeam(db, festId, -200, '2026-10-01T00:00:00.000Z').id,
  };
}

const AT = '2026-10-15T18:00:00.000Z';

describe('takeBeer', () => {
  it('numbers glasses per team, starting at 1, and queues a print job for each', () => {
    const { db, teamA, teamB } = setup();
    const first = takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: AT });
    const second = takeBeer(db, { teamId: teamA, beerId: 12, addedBy: 1, at: AT });
    const other = takeBeer(db, { teamId: teamB, beerId: 11, addedBy: 1, at: AT });
    expect([first.glassNo, second.glassNo, other.glassNo]).toEqual([1, 2, 1]);
    expect(db.prepare('SELECT queue_id, status, attempts FROM fest_print_jobs ORDER BY queue_id').all()).toEqual([
      { queue_id: first.id, status: 'queued', attempts: 0 },
      { queue_id: second.id, status: 'queued', attempts: 0 },
      { queue_id: other.id, status: 'queued', attempts: 0 },
    ]);
    expect(queueFor(db, teamA).map((r) => [r.glass_no, r.beer_id])).toEqual([[1, 11], [2, 12]]);
  });
});

describe('takeBeer on a repeated tap', () => {
  it('the same member and beer within 30 s is the same glass; at 31 s, or by someone else, a new one', () => {
    const { db, teamA } = setup();
    ensureProfile(db, 2);
    const at = (s: number) => new Date(Date.parse(AT) + s * 1000).toISOString();
    const r = [
      takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: at(0) }),
      takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: at(30) }),
      takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 2, at: at(30) }),
      takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: at(61) }),
    ];
    expect(r.map((x) => [x.glassNo, x.repeated])).toEqual([[1, false], [1, true], [2, false], [3, false]]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM fest_print_jobs').get()).toEqual({ n: 3 });
  });
});

describe('takeBeer against a glass dated ahead of the clock', () => {
  it('a glass stamped later than this tap is not a repeat of it', () => {
    const { db, teamA } = setup();
    const ahead = takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: '2026-10-15T18:01:00.000Z' });
    const now = takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: AT });
    expect([ahead.glassNo, now.glassNo, now.repeated]).toEqual([1, 2, false]);
  });
});

describe('memberBeerCheckins', () => {
  const member = [{ telegramId: 1, untappdUsername: 'JohnDoe' }];

  it("reads the member's history with its time as ISO 'Z', not as local time", () => {
    const { db } = setup();
    mergeCheckin(db, { checkin_id: '900', telegram_id: 1, beer_id: 11, user_rating: null, checkin_at: '2026-10-15T18:05:00Z', venue: null });
    expect(memberBeerCheckins(db, { members: member, beerIds: [11], sinceIso: '2026-10-15T17:50:00.000Z' }))
      .toEqual([{ telegramId: 1, beerId: 11, checkinId: '900', checkinAt: '2026-10-15T18:05:00.000Z' }]);
  });

  it('an authored venue row closes for the member whatever the case of the name; an anonymous one for nobody', () => {
    const { db } = setup();
    insertVenueCheckins(db, [
      { checkin_id: 501, venue_id: 2167060, bid: 6000011, untappd_user: 'johndoe', checkin_at: '2026-10-15T18:10:00.000Z' },
      { checkin_id: 502, venue_id: 2167060, bid: 6000011, untappd_user: null, checkin_at: '2026-10-15T18:11:00.000Z' },
    ], 'laptop', AT);
    expect(memberBeerCheckins(db, { members: member, beerIds: [11], sinceIso: '2026-10-15T17:50:00.000Z' }))
      .toEqual([{ telegramId: 1, beerId: 11, checkinId: '501', checkinAt: '2026-10-15T18:10:00.000Z' }]);
  });

  it("a check-in kept under the member's previous Untappd account does not count", () => {
    const { db } = setup();
    mergeCheckin(db, { checkin_id: '901', telegram_id: 1, account_key: 'oldname', beer_id: 11, user_rating: null, checkin_at: '2026-10-15T18:05:00Z', venue: null });
    expect(memberBeerCheckins(db, { members: member, beerIds: [11], sinceIso: '2026-10-15T17:50:00.000Z' })).toEqual([]);
  });

  it('check-ins before the start and of other beers are left out; no beers asks nothing', () => {
    const { db } = setup();
    mergeCheckin(db, { checkin_id: '902', telegram_id: 1, beer_id: 11, user_rating: null, checkin_at: '2026-10-15T17:49:59Z', venue: null });
    mergeCheckin(db, { checkin_id: '903', telegram_id: 1, beer_id: 12, user_rating: null, checkin_at: '2026-10-15T18:05:00Z', venue: null });
    expect([
      memberBeerCheckins(db, { members: member, beerIds: [11], sinceIso: '2026-10-15T17:50:00.000Z' }),
      memberBeerCheckins(db, { members: member, beerIds: [], sinceIso: '2026-10-15T17:50:00.000Z' }),
    ]).toEqual([[], []]);
  });
});
