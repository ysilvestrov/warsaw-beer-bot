import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { openDb, type DB } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { hashToken, rotateToken } from '../../storage/api_tokens';
import { getFestBySlug } from '../../storage/fests';
import { addMember, createTeam } from '../../storage/fest_teams';
import { takeBeer } from '../../storage/fest_queue';
import { createStation } from '../../storage/fest_print';
import { createApiApp } from '../index';
import { NIIMBLUE_FILE } from './fest-print';

const FAR = '2099-01-01T00:00:00.000Z';

function setup(expiresAt = FAR): { db: DB; app: ReturnType<typeof createApiApp>; station: string; glassId: number } {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  rotateToken(db, 1, hashToken('person-token'), '2026-09-30T00:00:00.000Z');
  const festId = getFestBySlug(db, 'wfp22')!.id;
  const team = createTeam(db, festId, -100, '2026-10-01T00:00:00.000Z').id;
  createTeam(db, festId, -200, '2026-10-01T00:00:00.000Z');
  addMember(db, team, 1, 'YS', '2026-10-01T00:00:00.000Z');
  db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
              VALUES (11, 6000011, 'Bravo', 'Brew', 'bravo', 'brew')`).run();
  const glassId = takeBeer(db, { teamId: team, beerId: 11, addedBy: 1, at: '2026-10-15T18:00:00.000Z' }).id;
  const station = createStation(db, { teamId: team, createdBy: 1, now: '2026-10-15T17:00:00.000Z', expiresAt });
  return { db, app: createApiApp({ db, env: {} as never, log: pino({ level: 'silent' }) }), station, glassId };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('print station API', () => {
  it("serves the station's team jobs to its token, outside the /fest/* person-token auth", async () => {
    const { app, station, glassId } = setup();
    const res = await app.request('/fest-print/jobs', { headers: bearer(station) });
    expect([res.status, await res.json()]).toEqual([200, {
      jobs: [{ id: glassId, glassNo: 1, beerName: 'Bravo', initials: 'YS', status: 'queued', attempts: 0, error: null }],
    }]);
  });

  it("a person's API token, a wrong token, no token and an expired station token are all refused", async () => {
    const { app } = setup('2026-01-01T00:00:00.000Z');
    const expired = setup('2026-01-01T00:00:00.000Z');
    const statuses = await Promise.all([
      app.request('/fest-print/jobs', { headers: bearer('person-token') }),
      app.request('/fest-print/jobs', { headers: bearer('nope') }),
      app.request('/fest-print/jobs'),
      expired.app.request('/fest-print/jobs', { headers: bearer(expired.station) }),
    ]).then((rs) => rs.map((r) => r.status));
    expect(statuses).toEqual([401, 401, 401, 401]);
  });

  it('a failed label stays in the queue with its error; a printed one leaves it', async () => {
    const { app, station, glassId } = setup();
    const failed = await app.request(`/fest-print/jobs/${glassId}/failed`, {
      method: 'POST', headers: { ...bearer(station), 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'paper out' }),
    });
    const afterFail = (await (await app.request('/fest-print/jobs', { headers: bearer(station) })).json()) as { jobs: { status: string; error: string }[] };
    const printed = await app.request(`/fest-print/jobs/${glassId}/printed`, { method: 'POST', headers: bearer(station) });
    const afterPrint = await (await app.request('/fest-print/jobs', { headers: bearer(station) })).json();
    expect([failed.status, afterFail.jobs.map((j) => [j.status, j.error]), printed.status, afterPrint])
      .toEqual([200, [['failed', 'paper out']], 200, { jobs: [] }]);
  });

  it('a job of another team, or a failed report without an error text, is refused', async () => {
    const { app, station, glassId } = setup();
    const other = await app.request(`/fest-print/jobs/${glassId + 1}/printed`, { method: 'POST', headers: bearer(station) });
    const bad = await app.request(`/fest-print/jobs/${glassId}/failed`, { method: 'POST', headers: bearer(station) });
    expect([other.status, bad.status]).toEqual([404, 400]);
  });

  it('serves the page as HTML and the vendored NiimBlue bundle as JavaScript, byte for byte', async () => {
    const { app } = setup();
    const page = await app.request('/fest-print');
    const lib = await app.request('/fest-print/niimbluelib.min.js');
    expect([
      page.status, page.headers.get('content-type'),
      lib.status, lib.headers.get('content-type'),
      (await lib.text()) === readFileSync(join(__dirname, '../fest-print', NIIMBLUE_FILE), 'utf8'),
    ]).toEqual([200, 'text/html; charset=UTF-8', 200, 'application/javascript; charset=utf-8', true]);
  });
});
