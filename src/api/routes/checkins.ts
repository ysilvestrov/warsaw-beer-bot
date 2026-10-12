import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { getProfile } from '../../storage/user_profiles';
import { getHistoryOwner } from '../../storage/history-owner';
import { upsertBeerByBid } from '../../storage/beers';
import { mergeCheckin, countCheckins, checkinExists, oldestCheckinId } from '../../storage/checkins';
import { getSyncState, recordProfileTotal } from '../../storage/checkin_sync_state';
import { addCoverage, rangeContaining, coverageFor } from '../../storage/checkin_coverage';
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
    const badCursor = (reason: string) => refuse(400, 'bad_cursor', { reason, pageSize, hasCursor });
    // Курсор — числовий id. Нечислове сюди прийти не мало б, але без явної перевірки
    // воно перетворилося б на NaN і впало б уже всередині транзакції, віддавши 500.
    let cursor: number | null = null;
    if (maxId !== undefined && maxId !== null) {
      // Той самий числовий формат, що й для id у парсері фіду (`/^\d+$/`): без нього
      // Number() пропустив би '5e2', ' 580 ' чи '0x244' як валідні числа.
      if (!/^\d+$/.test(maxId)) return badCursor('cursor_format');
      const n = Number(maxId);
      if (!Number.isInteger(n) || n <= 0) return badCursor('cursor_format');
      cursor = n;
    }

    // #587: порожня сторінка нічого не доводить. Нижче нашого найстарішого чекіна вона
    // законна (там і справді може нічого не бути), вище — суперечить нашим власним даним,
    // бо принаймні той чекін мав би повернутися. Отже вище — це мертва сесія або блок.
    if (page.checkins.length === 0) {
      const oldestKnown = oldestCheckinId(deps.db, telegramId, owner.accountKey);
      if (cursor !== null && oldestKnown !== null && cursor > oldestKnown) {
        return refuse(422, 'no_session', { reason: 'empty_above_known', pageSize, hasCursor });
      }
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

    // ids/oldest/newest — до транзакції: обидва вартові нижче мусять спрацювати ДО
    // будь-якого запису.
    const ids = page.checkins.map((ci) => Number(ci.checkin_id));
    const oldest = Math.min(...ids);
    const newest = Math.max(...ids);

    // #587: сторінка, найстаріший елемент якої ВИЩИЙ за курсор, — це не той фрагмент,
    // який ми просили (класично: 307-редірект more_feed на сторінку профілю). Записати
    // її діапазон означало б ствердити покриття з чужої сторінки.
    if (cursor !== null && oldest > cursor) return badCursor('oldest_above_cursor');

    // #854: верхній кінець id-ами не перевіряється. Стрічка Untappd упорядкована за ЧАСОМ
    // чекіна, а час можна виставити заднім числом: такий чекін має пізній id і стоїть у
    // стрічці глибоко, тож законний фрагмент несе id вище курсора (жива проба 2026-10-12).
    // Вартовий `newest > cursor` з рев'ю PR #592 відкидав таку сторінку назавжди — та сама
    // сторінка приходила на кожен повтор. Від нього лишається те, що не залежить від
    // порядку id: фрагмент «після курсора» не може містити сам курсорний чекін. Саме так
    // виглядає сторінка профілю, повернута замість фрагмента, коли курсор лежить у її межах.
    if (cursor !== null && ids.includes(cursor)) return badCursor('page_contains_cursor');

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

      // Верхня межа доведеного — курсор, що породив сторінку; для сторінки профілю
      // (курсора немає) вище найновішого елемента не доведено нічого.
      addCoverage(deps.db, telegramId, oldest, cursor ?? newest, owner.accountKey);
      recordProfileTotal(deps.db, telegramId, page.profileTotal, owner.accountKey);
    }

    const serverCount = countCheckins(deps.db, telegramId, owner.accountKey);
    const state = getSyncState(deps.db, telegramId, owner.accountKey);
    const covering = rangeContaining(deps.db, telegramId, oldest, owner.accountKey);

    // Лічильники зійшлися — шукати нижче нічого. Це не твердження про дно стрічки
    // (його довести не можна), а констатація «роботи немає». Але самого збігу чисел
    // не досить: `profile_total` міг ЗМЕНШИТИСЯ (користувач видалив чекін на Untappd,
    // наш рядок лишився) — тому коротке замикання вимагає ще й того, щоб покриття
    // було одним суцільним діапазоном: якщо дір нема, то й іти нікуди.
    const ranges = coverageFor(deps.db, telegramId, owner.accountKey);
    const caughtUp = state.profile_total !== null
      && serverCount >= state.profile_total
      && ranges.length === 1;
    const nextCursor: string | null = caughtUp ? null : String(covering?.from_id ?? oldest);

    // #587: обхід зобов'язаний спускатися — клієнт власного запобіжника від циклу не має.
    // Окремої перевірки тут немає, бо спуск випливає з двох вартових вище (#854): сторінка
    // пройшла лише з `oldest <= cursor` і без самого курсорного чекіна, тобто `oldest <
    // cursor`; а діапазон, що містить `oldest`, має `from_id <= oldest`. Отже `nextCursor`
    // строго менший за курсор запиту.

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
