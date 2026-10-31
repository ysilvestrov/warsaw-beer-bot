import type { CheckinFeedPage } from '../untappd/checkin-feed';

// #924: what a feed page proves, decided the same way for the server (SQLite) and the
// extension's local mode (IndexedDB). Moved verbatim from routes/checkins.ts; reads and writes
// stay with each adapter, which also checks for a block page before parsing.
export type PageVerdict =
  | { kind: 'refuse'; status: 400 | 422; code: 'bad_cursor' | 'no_session'; reason: string }
  | { kind: 'empty' }
  | { kind: 'accept'; cursor: number | null; ids: number[]; oldest: number; newest: number };

export function checkPage(page: CheckinFeedPage, maxId: string | null | undefined, oldestKnown: number | null): PageVerdict {
  const badCursor = (reason: string): PageVerdict => ({ kind: 'refuse', status: 400, code: 'bad_cursor', reason });

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
    if (cursor !== null && oldestKnown !== null && cursor > oldestKnown) {
      return { kind: 'refuse', status: 422, code: 'no_session', reason: 'empty_above_known' };
    }
    return { kind: 'empty' };
  }

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

  return { kind: 'accept', cursor, ids, oldest, newest };
}

// Верхня межа доведеного — курсор, що породив сторінку; для сторінки профілю
// (курсора немає) вище найновішого елемента не доведено нічого.
export function coverageSpan(page: { cursor: number | null; oldest: number; newest: number }): [number, number] {
  return [page.oldest, page.cursor ?? page.newest];
}
