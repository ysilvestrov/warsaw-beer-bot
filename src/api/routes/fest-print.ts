import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { markFailed, markPrinted, pendingJobs, requeue, stationTeam } from '../../storage/fest_print';

// Print station (spec §8). Outside /fest/*: the station authenticates with its own team-bound token
// (fest_print_stations), never with a person's API token. The page and the vendored NiimBlue bundle
// are served from the source tree — the deploy ships src/**, and the same path resolves from src/
// under tests and from dist/ in production.
const ASSETS = join(__dirname, '../../../src/api/fest-print');
export const NIIMBLUE_FILE = 'vendor/niimbluelib-0.47.0.min.js';

let cache: { html: string; lib: string } | null = null;
const assets = () => (cache ??= {
  html: readFileSync(join(ASSETS, 'index.html'), 'utf8'),
  lib: readFileSync(join(ASSETS, NIIMBLUE_FILE), 'utf8'),
});

const FailedBody = z.object({ error: z.string().max(1000) });

export function festPrintRoute(app: Hono<ApiEnv>, deps: ApiDeps, clock: () => Date = () => new Date()): void {
  const team = (c: Context<ApiEnv>): number | null => {
    const m = /^Bearer\s+(\S+)$/.exec(c.req.header('Authorization') ?? '');
    return m ? stationTeam(deps.db, m[1], clock().toISOString()) : null;
  };

  app.get('/fest-print', (c) => {
    c.header('Cache-Control', 'no-cache');
    return c.html(assets().html);
  });

  app.get('/fest-print/niimbluelib.min.js', (c) => {
    c.header('Content-Type', 'application/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(assets().lib);
  });

  app.get('/fest-print/jobs', (c) => {
    const teamId = team(c);
    if (teamId === null) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ jobs: pendingJobs(deps.db, teamId) });
  });

  app.post('/fest-print/jobs/:id{[0-9]+}/:action{printed|failed|requeue}', async (c) => {
    const teamId = team(c);
    if (teamId === null) return c.json({ error: 'unauthorized' }, 401);
    const id = Number(c.req.param('id'));
    const now = clock().toISOString();
    const action = c.req.param('action');
    let ok: boolean;
    if (action === 'failed') {
      const body = FailedBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: 'bad_body' }, 400);
      ok = markFailed(deps.db, teamId, id, body.data.error, now);
    } else {
      ok = action === 'printed' ? markPrinted(deps.db, teamId, id, now) : requeue(deps.db, teamId, id, now);
    }
    return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
  });
}
