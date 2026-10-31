import type { CheckinSyncState, CheckinSyncPageResult } from '../api/types';

export interface SyncProgress {
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
}

export type SyncStatus = 'done' | 'capped' | 'cancelled' | 'not_linked' | 'blocked' | 'no_session' | 'account_changed' | 'sync_context_required' | 'feed_unavailable' | 'page_rejected' | 'error';

// #846: чому Untappd не віддав стрічку. more_feed — лише для XHR: перенаправлення на ньому
// означає, що запит не вшановано, і парсити сторінку, куди нас відправили, не можна.
// Сторінка профілю перенаправляється законно (перейменований акаунт).
export function feedFailure(isMoreFeed: boolean, res: { ok: boolean; status: number; redirected: boolean }): 'blocked' | 'feed_unavailable' | null {
  if (res.status === 403 || res.status === 429) return 'blocked';
  if ((isMoreFeed && res.redirected) || !res.ok) return 'feed_unavailable';
  return null;
}

export interface SyncOutcome {
  status: SyncStatus;
  complete: boolean;
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
}

export interface CheckinSyncDeps {
  getState: () => Promise<CheckinSyncState>;
  fetchFeed: (username: string, maxId: string | null) => Promise<string>;
  submitPage: (html: string, maxId: string | null, linkRevision: number) => Promise<CheckinSyncPageResult>;
  onProgress: (p: SyncProgress) => void;
  sleep: (ms: number) => Promise<void>;
  pageCap: number;
  delayMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_DELAY_MS = 4000;

function errCode(e: unknown): string | null {
  return e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : null;
}

export async function runCheckinSync(deps: CheckinSyncDeps): Promise<SyncOutcome> {
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  let mergedThisRun = 0;
  let serverCount = 0;
  let profileTotal: number | null = null;
  let pages = 0;

  let state: CheckinSyncState;
  try {
    state = await deps.getState();
  } catch (e) {
    if (deps.signal?.aborted) return finish('cancelled');
    const code = errCode(e);
    // #924: local mode learns the session and the database owner here, before any page:
    // no signed-in untappd.com user, or another one than the database belongs to.
    if (code === 'not_linked' || code === 'no_session' || code === 'account_changed') return finish(code);
    return finish('error');
  }
  if (!Number.isSafeInteger(state.linkRevision) || state.linkRevision < 0) return finish('sync_context_required');
  serverCount = state.serverCount;
  profileTotal = state.profileTotal;
  if (deps.signal?.aborted) return finish('cancelled');

  // #587: одна прогулянка згори вниз. Куди ступати далі — каже сервер (`nextCursor`):
  // він знає покриття і стрибає під уже покриту територію. Двох фаз і евристики
  // «усі 25 відомі → стоп» більше немає: саме вони лишали діру недосяжною.
  let cursor: string | null = null;
  while (pages < deps.pageCap) {
    if (deps.signal?.aborted) return finish('cancelled');
    let html: string;
    try {
      html = await deps.fetchFeed(state.username, cursor);
    } catch (e) {
      if (deps.signal?.aborted) return finish('cancelled');
      const code = errCode(e);
      if (code === 'blocked' || code === 'feed_unavailable') return finish(code);
      return finish('error');
    }
    if (deps.signal?.aborted) return finish('cancelled');
    let res: CheckinSyncPageResult;
    try {
      res = await deps.submitPage(html, cursor, state.linkRevision);
    } catch (e) {
      if (deps.signal?.aborted) return finish('cancelled');
      const code = errCode(e);
      if (code === 'account_changed' || code === 'sync_context_required') return finish(code);
      if (code === 'blocked') return finish('blocked');
      if (code === 'not_linked') return finish('not_linked');
      if (code === 'no_session') return finish('no_session');
      if (code === 'page_rejected') return finish('page_rejected');
      return finish('error');
    }
    pages++;
    mergedThisRun += res.merged;
    serverCount = res.serverCount;
    if (res.profileTotal !== null) profileTotal = res.profileTotal;
    deps.onProgress({ serverCount, profileTotal, mergedThisRun });
    if (deps.signal?.aborted) return finish('cancelled');

    // #587: явний `null` — це «роботи немає». ВІДСУТНЄ поле — це сервер, старший за цей
    // клієнт (відкат), і мовчазна зупинка після першої сторінки виглядала б як звичайний
    // частковий прогрес. Показуємо помилку, а не вдаваний успіх.
    if (!('nextCursor' in res)) return finish('error');
    if (res.nextCursor === null) return finish('done');
    cursor = res.nextCursor;
    if (pages < deps.pageCap) await deps.sleep(delayMs);
  }
  return finish('capped');

  function finish(status: SyncStatus): SyncOutcome {
    // #587: «повністю» — це збіг лічильників, а не дно стрічки: дно недоказове, бо
    // порожню відповідь віддає і воно, і мертва сесія.
    const complete = status !== 'account_changed' && status !== 'sync_context_required' && profileTotal !== null && serverCount >= profileTotal;
    return { status, complete, serverCount, profileTotal, mergedThisRun };
  }
}
