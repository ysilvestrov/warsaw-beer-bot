import type { CheckinSyncState, CheckinSyncPageResult } from '../api/types';

export interface SyncProgress {
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
}

export type SyncStatus = 'done' | 'capped' | 'cancelled' | 'not_linked' | 'blocked' | 'no_session' | 'error';

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
  submitPage: (html: string, maxId: string | null) => Promise<CheckinSyncPageResult>;
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
    return finish(code === 'not_linked' ? 'not_linked' : 'error');
  }
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
      return finish(errCode(e) === 'blocked' ? 'blocked' : 'error');
    }
    if (deps.signal?.aborted) return finish('cancelled');
    let res: CheckinSyncPageResult;
    try {
      res = await deps.submitPage(html, cursor);
    } catch (e) {
      if (deps.signal?.aborted) return finish('cancelled');
      const code = errCode(e);
      if (code === 'blocked') return finish('blocked');
      if (code === 'not_linked') return finish('not_linked');
      if (code === 'no_session') return finish('no_session');
      return finish('error');
    }
    pages++;
    mergedThisRun += res.merged;
    serverCount = res.serverCount;
    if (res.profileTotal !== null) profileTotal = res.profileTotal;
    deps.onProgress({ serverCount, profileTotal, mergedThisRun });
    if (deps.signal?.aborted) return finish('cancelled');

    // #587: нестрога рівність навмисно — сервер, відкочений нижче цієї гілки, шле
    // відповідь без цього поля взагалі, і undefined має зупиняти обхід так само, як null.
    if (res.nextCursor == null) return finish('done');
    cursor = res.nextCursor;
    if (pages < deps.pageCap) await deps.sleep(delayMs);
  }
  return finish('capped');

  function finish(status: SyncStatus): SyncOutcome {
    // #587: «повністю» — це збіг лічильників, а не дно стрічки: дно недоказове, бо
    // порожню відповідь віддає і воно, і мертва сесія.
    const complete = profileTotal !== null && serverCount >= profileTotal;
    return { status, complete, serverCount, profileTotal, mergedThisRun };
  }
}
