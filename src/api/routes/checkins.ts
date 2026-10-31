import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { getProfile } from '../../storage/user_profiles';
import { getHistoryOwner } from '../../storage/history-owner';
import { upsertBeerByBid } from '../../storage/beers';
import { mergeCheckin, countCheckins, checkinExists, oldestCheckinId } from '../../storage/checkins';
import { getSyncState, recordProfileTotal } from '../../storage/checkin_sync_state';
import { addCoverage, coverageFor } from '../../storage/checkin_coverage';
import { checkPage, coverageSpan } from '../../shared/checkin-sync/guards';
import { conclude } from '../../shared/checkin-sync/conclude';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';
import { parseCheckinFeedPage } from '../../sources/untappd/checkin-feed';
import { isBlockPage } from '../../sources/untappd/block';
import {
  CHECKINS_HTML_LIMIT_CHARS,
  CHECKINS_SYNC_BODY_LIMIT_BYTES,
  CURSOR_LIMIT_CHARS,
  payloadBodyLimit,
  payloadSizeValidationHook,
} from '../middleware/payload-limit';

const SyncBody = z.object({
  linkRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  html: z.string().max(CHECKINS_HTML_LIMIT_CHARS),
  maxId: z.string().max(CURSOR_LIMIT_CHARS).nullable().optional(),
});

export function checkinsRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.get('/checkins/sync/state', (c) => deps.db.transaction(() => {
    const telegramId = c.get('telegramId')!; // auth middleware guarantees a value
    const profile = getProfile(deps.db, telegramId);
    const username = profile?.untappd_username ?? null;
    if (!username) return c.json({ error: 'not_linked' }, 409);
    const owner = getHistoryOwner(deps.db, telegramId);
    const state = getSyncState(deps.db, telegramId, owner.accountKey);
    return c.json({
      username,
      linkRevision: owner.linkRevision,
      deepest_max_id: state.deepest_max_id,
      complete: state.complete,
      serverCount: countCheckins(deps.db, telegramId, owner.accountKey),
      profileTotal: null,
    });
  })());

  app.post(
    '/checkins/sync',
    payloadBodyLimit(deps, CHECKINS_SYNC_BODY_LIMIT_BYTES, 'route'),
    zValidator('json', SyncBody, payloadSizeValidationHook(deps) as never),
    (c) => deps.db.transaction(() => {
    const telegramId = c.get('telegramId')!; // auth middleware guarantees a value
    const profile = getProfile(deps.db, telegramId);
    const username = profile?.untappd_username ?? null;
    // #846: кожна відмова лишає рядок у журналі. Фактів про людину в ньому немає — ані
    // Telegram id, ані акаунта, ані id чекінів чи курсора (id чекіна відкриває публічну
    // сторінку з профілем): для діагнозу досить відношення «вище курсора», а не чисел.
    const refuse = <S extends 400 | 409 | 422 | 502>(status: S, code: string, facts: Record<string, unknown> = {}) => {
      deps.log.warn({ code, ...facts }, 'checkins sync refused');
      return c.json({ error: code }, status);
    };
    if (!username) return refuse(409, 'not_linked');

    const { html, maxId, linkRevision } = c.req.valid('json');
    const owner = getHistoryOwner(deps.db, telegramId);
    if (linkRevision !== undefined && linkRevision !== owner.linkRevision) {
      return refuse(409, 'account_changed');
    }
    if (linkRevision === undefined && profile!.legacy_sync_revision !== owner.linkRevision) {
      return refuse(409, 'sync_context_required');
    }
    const hasCursor = maxId !== undefined && maxId !== null;
    if (isBlockPage(html)) return refuse(502, 'blocked', { hasCursor });

    const page = parseCheckinFeedPage(html);
    const pageSize = page.checkins.length;
    // #924: правила сторінки (#587/#854) — у src/shared/checkin-sync, спільні з локальним
    // режимом розширення. Найстаріший відомий чекін читається лише для порожньої сторінки, як і раніше.
    const verdict = checkPage(
      page,
      maxId,
      pageSize === 0 ? oldestCheckinId(deps.db, telegramId, owner.accountKey) : null,
    );
    if (verdict.kind === 'refuse') {
      return refuse(verdict.status, verdict.code, { reason: verdict.reason, pageSize, hasCursor });
    }
    if (verdict.kind === 'empty') {
      return c.json({
        merged: 0,
        alreadyKnown: 0,
        pageSize: 0,
        nextMaxId: null,
        nextCursor: null,
        profileTotal: page.profileTotal ?? getSyncState(deps.db, telegramId, owner.accountKey).profile_total,
        serverCount: countCheckins(deps.db, telegramId, owner.accountKey),
        complete: false,
      });
    }

    // Обидва вартові checkPage спрацювали ДО будь-якого запису.
    const { oldest } = verdict;

    let merged = 0;
    let alreadyKnown = 0;

    {
      for (const ci of page.checkins) {
        const existed = checkinExists(deps.db, telegramId, ci.checkin_id, owner.accountKey);
        // #617: ідентичність за bid. Стрічка фактів не несе (null), а upsertBeerByBid порожнім
        // значенням нічого не стирає, не перейменовує рядок і лише посилює провенанс.
        const beerId = upsertBeerByBid(deps.db, {
          untappd_id: ci.bid,
          name: ci.beer_name,
          brewery: ci.brewery_name,
          style: null,
          abv: null,
          rating_global: null,
          normalized_name: normalizeName(ci.beer_name),
          normalized_brewery: normalizeBrewery(ci.brewery_name),
          untappd_id_source: 'checkin',
        });
        mergeCheckin(deps.db, {
          checkin_id: ci.checkin_id,
          telegram_id: telegramId,
          account_key: owner.accountKey,
          beer_id: beerId,
          user_rating: ci.user_rating,
          checkin_at: ci.checkin_at,
          venue: ci.venue,
        });
        if (existed) alreadyKnown++;
        else merged++;
      }

      const [from, to] = coverageSpan(verdict);
      addCoverage(deps.db, telegramId, from, to, owner.accountKey);
      recordProfileTotal(deps.db, telegramId, page.profileTotal, owner.accountKey);
    }

    const serverCount = countCheckins(deps.db, telegramId, owner.accountKey);
    const state = getSyncState(deps.db, telegramId, owner.accountKey);
    const { nextCursor } = conclude({
      count: serverCount,
      profileTotal: state.profile_total,
      ranges: coverageFor(deps.db, telegramId, owner.accountKey),
      oldest,
    });

    return c.json({
      merged,
      alreadyKnown,
      pageSize: page.checkins.length,
      nextMaxId: page.nextMaxId,
      nextCursor,
      profileTotal: page.profileTotal,
      serverCount,
      complete: false,
    });
    }).immediate(),
  );
}
