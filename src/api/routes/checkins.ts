import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { getProfile } from '../../storage/user_profiles';
import { upsertBeer } from '../../storage/beers';
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
  html: z.string().max(CHECKINS_HTML_LIMIT_CHARS),
  maxId: z.string().max(CURSOR_LIMIT_CHARS).nullable().optional(),
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

  app.post(
    '/checkins/sync',
    payloadBodyLimit(deps, CHECKINS_SYNC_BODY_LIMIT_BYTES, 'route'),
    zValidator('json', SyncBody, payloadSizeValidationHook(deps) as never),
    (c) => {
    const telegramId = c.get('telegramId')!; // auth middleware guarantees a value
    const username = getProfile(deps.db, telegramId)?.untappd_username ?? null;
    if (!username) return c.json({ error: 'not_linked' }, 409);

    const { html, maxId } = c.req.valid('json');
    if (isBlockPage(html)) return c.json({ error: 'blocked' }, 502);

    const page = parseCheckinFeedPage(html);
    // Курсор — числовий id. Нечислове сюди прийти не мало б, але без явної перевірки
    // воно перетворилося б на NaN і впало б уже всередині транзакції, віддавши 500.
    let cursor: number | null = null;
    if (maxId !== undefined && maxId !== null) {
      // Той самий числовий формат, що й для id у парсері фіду (`/^\d+$/`): без нього
      // Number() пропустив би '5e2', ' 580 ' чи '0x244' як валідні числа.
      if (!/^\d+$/.test(maxId)) return c.json({ error: 'bad_cursor' }, 400);
      const n = Number(maxId);
      if (!Number.isInteger(n) || n <= 0) return c.json({ error: 'bad_cursor' }, 400);
      cursor = n;
    }

    // #587: порожня сторінка нічого не доводить. Нижче нашого найстарішого чекіна вона
    // законна (там і справді може нічого не бути), вище — суперечить нашим власним даним,
    // бо принаймні той чекін мав би повернутися. Отже вище — це мертва сесія або блок.
    if (page.checkins.length === 0) {
      const oldestKnown = oldestCheckinId(deps.db, telegramId);
      if (cursor !== null && oldestKnown !== null && cursor > oldestKnown) {
        return c.json({ error: 'no_session' }, 422);
      }
      return c.json({
        merged: 0,
        alreadyKnown: 0,
        pageSize: 0,
        nextMaxId: null,
        nextCursor: null,
        profileTotal: page.profileTotal ?? getSyncState(deps.db, telegramId).profile_total,
        serverCount: countCheckins(deps.db, telegramId),
        complete: false,
      });
    }

    // ids/oldest/newest — до транзакції: обидва вартові нижче (суперечливий курсор,
    // а невдовзі й цикл) мусять спрацювати ДО будь-якого запису.
    const ids = page.checkins.map((ci) => Number(ci.checkin_id));
    const oldest = Math.min(...ids);
    const newest = Math.max(...ids);

    // #587: сторінка, найстаріший елемент якої ВИЩИЙ за курсор, — це не той фрагмент,
    // який ми просили (класично: 307-редірект more_feed на сторінку профілю). Записати
    // її діапазон означало б ствердити покриття з чужої сторінки.
    //
    // Рев'ю PR #592 (P2): того самого вимагає й верхній кінець. Легітимний фрагмент
    // повертає лише елементи СТРОГО нижче свого курсора — сторінка з `newest > cursor`
    // так само не той фрагмент (найстаріший міг випадково опинитися на місці, а верх
    // все одно чужий), і без цієї перевірки вона проходила б у транзакцію та `addCoverage`
    // до того, як покриття встигне це довести.
    if (cursor !== null && (oldest > cursor || newest > cursor)) {
      return c.json({ error: 'bad_cursor' }, 400);
    }

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
          untappd_id_source: 'checkin',
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

      // Верхня межа доведеного — курсор, що породив сторінку; для сторінки профілю
      // (курсора немає) вище найновішого елемента не доведено нічого.
      addCoverage(deps.db, telegramId, oldest, cursor ?? newest);
      recordProfileTotal(deps.db, telegramId, page.profileTotal);
    })();

    const serverCount = countCheckins(deps.db, telegramId);
    const state = getSyncState(deps.db, telegramId);
    const covering = rangeContaining(deps.db, telegramId, oldest);

    // Лічильники зійшлися — шукати нижче нічого. Це не твердження про дно стрічки
    // (його довести не можна), а констатація «роботи немає». Але самого збігу чисел
    // не досить: `profile_total` міг ЗМЕНШИТИСЯ (користувач видалив чекін на Untappd,
    // наш рядок лишився) — тому коротке замикання вимагає ще й того, щоб покриття
    // було одним суцільним діапазоном: якщо дір нема, то й іти нікуди.
    const ranges = coverageFor(deps.db, telegramId);
    const caughtUp = state.profile_total !== null
      && serverCount >= state.profile_total
      && ranges.length === 1;
    let nextCursor: string | null = caughtUp ? null : String(covering?.from_id ?? oldest);

    // #587: обхід зобов'язаний спускатися. Курсор, що не зменшився, — це цикл, і клієнт
    // після Task 5 не має власного запобіжника, щоб із нього вийти.
    if (cursor !== null && nextCursor !== null && Number(nextCursor) >= cursor) {
      nextCursor = null;
    }

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
    },
  );
}
