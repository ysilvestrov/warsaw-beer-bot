import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv, Principal } from '../types';
import type { CatalogCache } from '../../domain/catalog-cache';
import { triedBeerIds } from '../../storage/untappd_had';
import { latestRatingsByBeer } from '../../storage/checkins';
import { matchBeerList, type MatchListResult } from '../../domain/match-list';
import { recordMisses } from '../../storage/match_misses';
import { recordInstallUsage } from '../../storage/install_usage';
import { touchInstall } from '../../storage/extension_installs';
import { recordMatchUsage } from '../../storage/api_usage';
import { findActiveDispositionForBeer, findActiveDispositionForCard } from '../../storage/legacy-orphan-dispositions';
import { warsawDateAndHour } from '../../domain/warsaw-time';
import {
  BEER_TEXT_LIMIT_CHARS,
  MATCH_BODY_LIMIT_BYTES,
  payloadBodyLimit,
  payloadSizeValidationHook,
} from '../middleware/payload-limit';
import { matchBeerItemSchema } from '../match-input';

// #633: опубліковані крамницею поля живуть лише тут. `bid` — строго ціле додатне (машинно
// витягнуте з URL, як в /enrich/*); `brand` — доказ броварні, проти якого його перевіряють.
const MatchBody = z.object({
  beers: z
    .array(
      matchBeerItemSchema.extend({
        bid: z.number().int().positive().optional(),
        brand: z.string().max(BEER_TEXT_LIMIT_CHARS).optional(),
      }),
    )
    .min(1)
    .max(200),
  // #923: who is asking, for per-install accounting. Optional both ways: an old client omits it,
  // an old server strips it as an unknown key.
  client: z.object({ version: z.string().max(64).optional(), shop: z.string().max(64).optional() }).optional(),
});

// Registers POST /match on the given app. Auth is optional here: a missing
// token yields telegramId===null (anonymous, global-only results); a valid
// token yields personal drunk/rating data (see optionalAuthMiddleware).
// The prepared-catalog cache is created ONCE at the composition root and passed in:
// a second instance would double both the memory and the rebuild CPU (~30k rows).
export function matchRoute(app: Hono<ApiEnv>, deps: ApiDeps, cache: CatalogCache): void {
  app.post(
    '/match',
    payloadBodyLimit(deps, MATCH_BODY_LIMIT_BYTES, 'route'),
    zValidator('json', MatchBody, payloadSizeValidationHook(deps) as never),
    async (c) => {
    const telegramId = c.get('telegramId') ?? null;
    const principal = c.get('principal') ?? null;
    const { beers, client } = c.req.valid('json');

    // Operational usage metric for the daily digest — never break the response.
    try {
      recordMatchUsage(deps.db, {
        date: warsawDateAndHour(new Date()).date,
        authed: telegramId !== null,
        install: principal?.kind === 'install',
        beers: beers.length,
        channel: 'extension',
      });
    } catch (e) {
      deps.log.warn({ err: e }, 'api_usage record failed');
    }

    const { prepared, byId, byUntappdId, aliases } = await cache.get();
    // Anonymous callers get global-only results: empty drunk/ratings sets mean
    // is_drunk=false, user_rating=null, but matched_beer still carries the global
    // rating + untappd_id (⭐/⚪ badges render unchanged).
    const { drunkSet, ratings } = deps.db.transaction(() => ({
      drunkSet: telegramId === null ? new Set<number>() : triedBeerIds(deps.db, telegramId),
      ratings: telegramId === null ? new Map<number, number>() : latestRatingsByBeer(deps.db, telegramId),
    }))();

    const { results, fallback, bid } = await matchBeerList(prepared, byId, drunkSet, ratings, beers, {
      aliases,
      byUntappdId,
      isInactiveCard: (item) => findActiveDispositionForCard(deps.db, item.brewery, item.name, item.abv ?? null) !== null,
      isInactiveBeerId: (id) => findActiveDispositionForBeer(deps.db, id) !== null,
    });
    deps.log.info(
      {
        channel: 'extension',
        items: beers.length,
        fullFallback: {
          attempts: fallback.attempts,
          hits: fallback.hits,
          budgetSkipped: fallback.budgetSkipped,
        },
        // #633: скільки карток несли опублікований bid, скільки з них дали exact і скільки —
        // суперечність броварні. Єдиний спосіб побачити ефект зміни на проді.
        bid,
      },
      'match fallback stats',
    );
    if (principal !== null) recordCallerLedger(deps, principal, client, beers, results);
    return c.json({ results });
    },
  );
}

// #923 §2.4: for a caller with any token, journal the cards we searched and did not find; for an
// install, also count its traffic. Best-effort like api_usage: a failed write never breaks /match.
// A card with an active disposition is not a miss — it was already decided not to be looked for.
function recordCallerLedger(
  deps: ApiDeps,
  principal: Principal,
  client: { version?: string; shop?: string } | undefined,
  beers: { brewery: string; name: string; abv?: number | null }[],
  results: MatchListResult[],
): void {
  try {
    const now = new Date();
    const date = warsawDateAndHour(now).date;
    const shop = client?.shop ?? '';
    const misses = beers.filter((b, i) =>
      results[i].matched_beer === null && results[i].searched
      && findActiveDispositionForCard(deps.db, b.brewery, b.name, b.abv ?? null) === null);
    const recorded = recordMisses(deps.db, { at: now.toISOString(), date, shop, cards: misses });
    if (principal.kind === 'install') {
      recordInstallUsage(deps.db, {
        date, installId: principal.installId, shop,
        matchRequests: 1, matchBeers: beers.length, matchMisses: recorded,
      });
      if (client?.version !== undefined) touchInstall(deps.db, principal, { date, version: client.version });
    }
  } catch (e) {
    deps.log.warn({ err: e }, 'install ledger record failed');
  }
}
