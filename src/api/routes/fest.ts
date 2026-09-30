import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { CHECKINS_HTML_LIMIT_CHARS, CURSOR_LIMIT_CHARS, payloadSizeValidationHook } from '../middleware/payload-limit';
import { activeFests, currentOrNextFests, festVenues } from '../../storage/fests';
import { isFestMember } from '../../storage/fest_teams';
import { BlockedPageError, applyMenu, ingestFeedPage } from '../../jobs/fest-ingest';
import { isBlockPage } from '../../sources/untappd/block';
import { parseVenueMenu } from '../../sources/untappd/venue-menu';

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
    const active = activeFests(deps.db, now);
    if (active.length === 0) return c.json({ error: 'no_active_fest' }, 404);
    const telegramId = c.get('telegramId')!;
    const mine = active.filter((a) => isFestMember(deps.db, a.fest.id, telegramId));
    if (mine.length === 0) return c.json({ error: 'not_team_member' }, 403);
    const body = c.req.valid('json');
    // Overlapping fests are told apart by the venue: it must belong to one the caller is in.
    const target = mine.find((a) => festVenues(deps.db, a.fest.id).some((v) => v.venue_id === body.venueId));
    if (!target) return c.json({ error: 'unknown_venue' }, 400);
    try {
      const result = ingestFeedPage(deps.db, {
        venueId: body.venueId,
        html: body.html,
        cursor: body.cursor ?? null,
        fetchedAt: body.fetchedAt,
        eye: 'laptop',
        now: now.toISOString(),
      });
      // Every row names another venue: the eye paired this page with the wrong id. Nothing was
      // written; say so instead of answering as if the page were merely empty.
      if (result.mismatched > 0 && result.seen === 0 && result.dropped === 0) {
        return c.json({ error: 'venue_mismatch' }, 400);
      }
      return c.json(result);
    } catch (e) {
      if (e instanceof BlockedPageError) return c.json({ error: 'blocked' }, 502);
      throw e;
    }
  });

  // The menu is read during the run-up too, so it targets a fest being polled now or still ahead —
  // the one whose menu venue is the page's own (canonical link) and whose team the caller is in.
  app.post('/fest/menu', zValidator('json', MenuBody, payloadSizeValidationHook(deps) as never), (c) => {
    const now = clock();
    const html = c.req.valid('json').html;
    if (isBlockPage(html)) return c.json({ error: 'blocked' }, 502);
    const fests = currentOrNextFests(deps.db, now);
    if (fests.length === 0) return c.json({ error: 'no_fest' }, 404);
    const mine = fests.filter((f) => isFestMember(deps.db, f.id, c.get('telegramId')!));
    if (mine.length === 0) return c.json({ error: 'not_team_member' }, 403);
    const menu = parseVenueMenu(html);
    const fest = mine.find((f) => f.menu_venue_id === menu.venueId);
    if (!fest) return c.json({ error: 'unknown_menu_venue' }, 400);
    return c.json(applyMenu(deps.db, fest.id, menu, now.toISOString()));
  });
}
