import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { getProfile } from '../../storage/user_profiles';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin, countCheckins, checkinExists } from '../../storage/checkins';
import { getSyncState, advanceSyncState } from '../../storage/checkin_sync_state';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';
import { parseCheckinFeedPage } from '../../sources/untappd/checkin-feed';
import { isBlockPage } from '../../sources/untappd/block';

const SyncBody = z.object({
  html: z.string(),
  maxId: z.string().nullable().optional(),
});

export function checkinsRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.get('/checkins/sync/state', (c) => {
    const telegramId = c.get('telegramId')!; // auth middleware guarantees a value
    const username = getProfile(deps.db, telegramId)?.untappd_username ?? null;
    if (!username) return c.json({ error: 'not_linked' }, 409);
    const state = getSyncState(deps.db, telegramId);
    return c.json({
      username,
      deepest_max_id: state.deepest_max_id,
      complete: state.complete,
      serverCount: countCheckins(deps.db, telegramId),
      profileTotal: null,
    });
  });

  app.post('/checkins/sync', zValidator('json', SyncBody), (c) => {
    const telegramId = c.get('telegramId')!; // auth middleware guarantees a value
    const username = getProfile(deps.db, telegramId)?.untappd_username ?? null;
    if (!username) return c.json({ error: 'not_linked' }, 409);

    // maxId is accepted for forward-compat/observability but the authoritative next cursor is
    // re-derived from the parsed page (page.nextMaxId).
    const { html } = c.req.valid('json');
    if (isBlockPage(html)) return c.json({ error: 'blocked' }, 502);

    const page = parseCheckinFeedPage(html);
    let merged = 0;
    let alreadyKnown = 0;

    deps.db.transaction(() => {
      for (const ci of page.checkins) {
        const existed = checkinExists(deps.db, telegramId, ci.checkin_id);
        const beerId = upsertBeer(deps.db, {
          untappd_id: ci.bid,
          name: ci.beer_name,
          brewery: ci.brewery_name,
          style: null,
          abv: null,
          rating_global: null,
          normalized_name: normalizeName(ci.beer_name),
          normalized_brewery: normalizeBrewery(ci.brewery_name),
        });
        mergeCheckin(deps.db, {
          checkin_id: ci.checkin_id,
          telegram_id: telegramId,
          beer_id: beerId,
          user_rating: ci.user_rating,
          checkin_at: ci.checkin_at,
          venue: ci.venue,
        });
        if (existed) alreadyKnown++;
        else merged++;
      }
      advanceSyncState(deps.db, telegramId, page.nextMaxId, page.nextMaxId === null, page.profileTotal);
    })();

    return c.json({
      merged,
      alreadyKnown,
      pageSize: page.checkins.length,
      nextMaxId: page.nextMaxId,
      profileTotal: page.profileTotal,
      serverCount: countCheckins(deps.db, telegramId),
      complete: page.nextMaxId === null,
    });
  });
}
