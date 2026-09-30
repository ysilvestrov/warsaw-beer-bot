import { openDb, type DB } from './db';
import { migrate } from './schema';
import { ensureProfile } from './user_profiles';
import { getFestBySlug } from './fests';
import { addMember, createTeam } from './fest_teams';
import { takeBeer } from './fest_queue';
import { createStation, markFailed, markPrinted, pendingJobs, requeue, stationTeam } from './fest_print';

const NOW = '2026-10-15T18:00:00.000Z';

function setup(): { db: DB; teamA: number; teamB: number } {
  const db = openDb(':memory:');
  migrate(db);
  const festId = getFestBySlug(db, 'wfp22')!.id;
  ensureProfile(db, 1);
  const teamA = createTeam(db, festId, -100, NOW).id;
  const teamB = createTeam(db, festId, -200, NOW).id;
  addMember(db, teamA, 1, 'YS', NOW);
  db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
              VALUES (11, 6000011, 'Bravo', 'Brew', 'bravo', 'brew')`).run();
  return { db, teamA, teamB };
}

describe('station tokens', () => {
  it('a token opens its own team until it expires, and is never stored in the clear', () => {
    const { db, teamA } = setup();
    const token = createStation(db, { teamId: teamA, createdBy: 1, now: NOW, expiresAt: '2026-10-19T00:00:00.000Z' });
    const stored = db.prepare('SELECT token_hash FROM fest_print_stations').all() as { token_hash: string }[];
    expect([
      stationTeam(db, token, NOW),
      stationTeam(db, token, '2026-10-19T00:00:00.000Z'),
      stationTeam(db, 'someone-elses', NOW),
      stored.length, stored[0].token_hash === token, token.length,
    ]).toEqual([teamA, null, null, 1, false, 43]);
  });
});

describe('print jobs', () => {
  it('lists queued jobs of the team with beer and initials; printed ones leave, failed ones stay with the error', () => {
    const { db, teamA } = setup();
    const a = takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: NOW });
    const b = takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: '2026-10-15T18:05:00.000Z' });
    markPrinted(db, teamA, a.id, NOW);
    markFailed(db, teamA, b.id, 'x'.repeat(300), NOW);
    expect(pendingJobs(db, teamA)).toEqual([
      { id: b.id, glassNo: 2, beerName: 'Bravo', initials: 'YS', status: 'failed', attempts: 1, error: 'x'.repeat(200) },
    ]);
  });

  it('another team can neither see nor mark the jobs', () => {
    const { db, teamA, teamB } = setup();
    const a = takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: NOW });
    expect([pendingJobs(db, teamB), markPrinted(db, teamB, a.id, NOW), pendingJobs(db, teamA).length]).toEqual([[], false, 1]);
  });

  it('"print again" returns a printed job to the queue without an error', () => {
    const { db, teamA } = setup();
    const a = takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 1, at: NOW });
    markFailed(db, teamA, a.id, 'paper jam', NOW);
    markPrinted(db, teamA, a.id, NOW);
    requeue(db, teamA, a.id, NOW);
    expect(pendingJobs(db, teamA).map((j) => [j.status, j.attempts, j.error])).toEqual([['queued', 2, null]]);
  });

  it('a glass taken by someone who left the team prints "?" for initials', () => {
    const { db, teamA } = setup();
    takeBeer(db, { teamId: teamA, beerId: 11, addedBy: 99, at: NOW });
    expect(pendingJobs(db, teamA).map((j) => j.initials)).toEqual(['?']);
  });
});
