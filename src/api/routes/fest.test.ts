import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import pino from 'pino';
import { openDb, type DB } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { hashToken, rotateToken } from '../../storage/api_tokens';
import { getFestBySlug } from '../../storage/fests';
import { addMember, createTeam } from '../../storage/fest_teams';
import { authMiddleware } from '../middleware/auth';
import { festRoute } from './fest';
import type { ApiEnv } from '../types';

const RAW = readFileSync(join(__dirname, '../../sources/untappd/__fixtures__/venue-more-feed-raw.html'), 'utf8');
const MENU = readFileSync(join(__dirname, '../../sources/untappd/__fixtures__/venue-menu.html'), 'utf8');
const MEMBER = 101;
const OUTSIDER = 202;
const IN_SESSION = new Date('2026-10-15T15:00:00.000Z');

function setup(now: Date): { db: DB; app: Hono<ApiEnv> } {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, token] of [[MEMBER, 'member-token'], [OUTSIDER, 'outsider-token']] as const) {
    ensureProfile(db, id);
    setUntappdUsername(db, id, `user${id}`);
    rotateToken(db, id, hashToken(token), '2026-09-30T00:00:00.000Z');
  }
  const team = createTeam(db, getFestBySlug(db, 'wfp22')!.id, -100, '2026-09-30T00:00:00.000Z');
  addMember(db, team.id, MEMBER, 'MM', '2026-09-30T00:00:00.000Z');
  const app = new Hono<ApiEnv>();
  app.use('/fest/*', authMiddleware(db));
  festRoute(app, { db, env: {} as never, log: pino({ level: 'silent' }) }, () => now);
  return { db, app };
}

const post = (app: Hono<ApiEnv>, path: string, token: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const feed = { venueId: 11142155, html: RAW, cursor: null, fetchedAt: '2026-10-15T14:59:00.000Z' };

describe('POST /fest/feed', () => {
  it('ingests a page for a team member during a session', async () => {
    const { app } = setup(IN_SESSION);
    const res = await post(app, '/fest/feed', 'member-token', feed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 3, seen: 3, dropped: 0, mismatched: 0, stitched: false, nextCursor: '1559318775' });
  });

  it('refuses a user who is not in any team of the fest', async () => {
    const { app } = setup(IN_SESSION);
    const res = await post(app, '/fest/feed', 'outsider-token', feed);
    expect([res.status, await res.json()]).toEqual([403, { error: 'not_team_member' }]);
  });

  it('refuses outside every polling window', async () => {
    const { app } = setup(new Date('2026-10-16T01:00:00.000Z'));
    const res = await post(app, '/fest/feed', 'member-token', feed);
    expect([res.status, await res.json()]).toEqual([404, { error: 'no_active_fest' }]);
  });

  it('refuses a venue that is not one of the fest venues', async () => {
    const { app } = setup(IN_SESSION);
    const res = await post(app, '/fest/feed', 'member-token', { ...feed, venueId: 12345 });
    expect([res.status, await res.json()]).toEqual([400, { error: 'unknown_venue' }]);
  });

  it('answers 400 when every row of the page belongs to another fest venue', async () => {
    const { db, app } = setup(IN_SESSION);
    const res = await post(app, '/fest/feed', 'member-token', { ...feed, venueId: 2167060 });
    expect([res.status, await res.json()]).toEqual([400, { error: 'venue_mismatch' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM venue_checkins').get()).toEqual({ n: 0 });
  });

  it('routes to the overlapping fest the member belongs to and that owns the venue', async () => {
    const { db, app } = setup(IN_SESSION);
    // A second fest over the same hours with its own venue; the member joins only its team.
    db.prepare(`INSERT INTO fests (slug, name, menu_venue_id, target_min_rating, target_style_patterns) VALUES ('other', 'Other', 1, 4, '[]')`).run();
    const other = getFestBySlug(db, 'other')!;
    db.prepare(`INSERT INTO fest_sessions VALUES (?, 1, '2026-10-15T14:00:00.000Z', '2026-10-15T22:00:00.000Z')`).run(other.id);
    db.prepare(`INSERT INTO fest_venues VALUES (?, 11142155, 'Same venue', '/v/x/11142155')`).run(other.id);
    db.prepare('DELETE FROM fest_team_members').run();
    addMember(db, createTeam(db, other.id, -200, '2026-09-30T00:00:00.000Z').id, MEMBER, 'MM', '2026-09-30T00:00:00.000Z');
    const res = await post(app, '/fest/feed', 'member-token', feed);
    expect(res.status).toBe(200);
  });

  it('answers 502 for a Cloudflare page and writes nothing', async () => {
    const { db, app } = setup(IN_SESSION);
    const res = await post(app, '/fest/feed', 'member-token', { ...feed, html: '<title>Just a moment...</title>' });
    expect([res.status, await res.json()]).toEqual([502, { error: 'blocked' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM venue_checkins').get()).toEqual({ n: 0 });
  });

  it('rejects a non-numeric cursor', async () => {
    const { app } = setup(IN_SESSION);
    const res = await post(app, '/fest/feed', 'member-token', { ...feed, cursor: '0x10' });
    expect(res.status).toBe(400);
  });

  it('requires a token', async () => {
    const { app } = setup(IN_SESSION);
    const res = await app.request('/fest/feed', { method: 'POST', body: JSON.stringify(feed), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(401);
  });
});

describe('POST /fest/menu', () => {
  it('ingests the menu during the run-up, before any polling window', async () => {
    const { app } = setup(new Date('2026-09-30T10:00:00.000Z'));
    const res = await post(app, '/fest/menu', 'member-token', { html: MENU });
    expect([res.status, await res.json()]).toEqual([200, { items: 4, updatedAt: '2026-09-29T12:15:39.465Z', stale: false }]);
  });

  it('refuses a non-member', async () => {
    const { app } = setup(new Date('2026-09-30T10:00:00.000Z'));
    const res = await post(app, '/fest/menu', 'outsider-token', { html: MENU });
    expect(res.status).toBe(403);
  });

  it('has no fest to write to once the last window has closed', async () => {
    const { app } = setup(new Date('2026-10-17T22:31:00.000Z'));
    const res = await post(app, '/fest/menu', 'member-token', { html: MENU });
    expect([res.status, await res.json()]).toEqual([404, { error: 'no_fest' }]);
  });
});
