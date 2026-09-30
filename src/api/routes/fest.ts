import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { CHECKINS_HTML_LIMIT_CHARS, CURSOR_LIMIT_CHARS, payloadSizeValidationHook } from '../middleware/payload-limit';
import { activeFest, currentOrNextFest, festVenues } from '../../storage/fests';
import { isFestMember } from '../../storage/fest_teams';
import { BlockedPageError, ingestFeedPage, ingestMenuPage } from '../../jobs/fest-ingest';

const FeedBody = z.object({
  venueId: z.number().int().positive(),
  html: z.string().max(CHECKINS_HTML_LIMIT_CHARS),
  cursor: z.string().regex(/^\d+$/).max(CURSOR_LIMIT_CHARS).nullable().optional(),
  fetchedAt: z.string().datetime(),
});

const MenuBody = z.object({
  html: z.string().max(CHECKINS_HTML_LIMIT_CHARS),
});

// Relay endpoints for festival eyes (spec §4.2). Only a member of a team of the fest that is
// being polled right now may write; outside every polling window there is nothing to write to.
export function festRoute(app: Hono<ApiEnv>, deps: ApiDeps, clock: () => Date = () => new Date()): void {
  app.post('/fest/feed', zValidator('json', FeedBody, payloadSizeValidationHook(deps) as never), (c) => {
    const now = clock();
    const active = activeFest(deps.db, now);
    if (!active) return c.json({ error: 'no_active_fest' }, 404);
    if (!isFestMember(deps.db, active.fest.id, c.get('telegramId')!)) return c.json({ error: 'not_team_member' }, 403);
    const body = c.req.valid('json');
    if (!festVenues(deps.db, active.fest.id).some((v) => v.venue_id === body.venueId)) {
      return c.json({ error: 'unknown_venue' }, 400);
    }
    try {
      return c.json(ingestFeedPage(deps.db, {
        venueId: body.venueId,
        html: body.html,
        cursor: body.cursor ?? null,
        fetchedAt: body.fetchedAt,
        eye: 'laptop',
        now: now.toISOString(),
      }));
    } catch (e) {
      if (e instanceof BlockedPageError) return c.json({ error: 'blocked' }, 502);
      throw e;
    }
  });

  // The menu is read during the run-up too, so it targets the fest being polled now or the next one.
  app.post('/fest/menu', zValidator('json', MenuBody, payloadSizeValidationHook(deps) as never), (c) => {
    const now = clock();
    const fest = currentOrNextFest(deps.db, now);
    if (!fest) return c.json({ error: 'no_fest' }, 404);
    if (!isFestMember(deps.db, fest.id, c.get('telegramId')!)) return c.json({ error: 'not_team_member' }, 403);
    try {
      return c.json(ingestMenuPage(deps.db, { festId: fest.id, html: c.req.valid('json').html, now: now.toISOString() }));
    } catch (e) {
      if (e instanceof BlockedPageError) return c.json({ error: 'blocked' }, 502);
      throw e;
    }
  });
}
