import type { CheckinSyncState, CheckinSyncPageResult } from '../api/types';

export interface SyncProgress {
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
}

export type SyncStatus = 'done' | 'capped' | 'not_linked' | 'blocked' | 'error';

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
    const code = errCode(e);
    return done(code === 'not_linked' ? 'not_linked' : 'error');
  }
  serverCount = state.serverCount;
  profileTotal = state.profileTotal;

  // Phase 0 starts at "now" (null). Phase 1 (if any) resumes at the saved deep
  // cursor. A fully-known page or feed bottom ends a phase.
  const startCursors: (string | null)[] = [null];
  if (state.deepest_max_id !== null && !state.complete) startCursors.push(state.deepest_max_id);

  for (let phase = 0; phase < startCursors.length; phase++) {
    let maxId = startCursors[phase];
    let firstOfPhase = true;
    while (pages < deps.pageCap) {
      const cursor = firstOfPhase && phase === 0 ? null : maxId;
      let html: string;
      try {
        html = await deps.fetchFeed(state.username, cursor);
      } catch (e) {
        return finish(errCode(e) === 'blocked' ? 'blocked' : 'error');
      }
      let res: CheckinSyncPageResult;
      try {
        res = await deps.submitPage(html, cursor);
      } catch (e) {
        const code = errCode(e);
        return finish(code === 'blocked' ? 'blocked' : code === 'not_linked' ? 'not_linked' : 'error');
      }
      pages++;
      firstOfPhase = false;
      mergedThisRun += res.merged;
      serverCount = res.serverCount;
      if (res.profileTotal !== null) profileTotal = res.profileTotal;
      deps.onProgress({ serverCount, profileTotal, mergedThisRun });

      if (res.complete) return finish('done', true);
      if (res.pageSize > 0 && res.alreadyKnown === res.pageSize) break; // reached known territory
      if (res.nextMaxId === null) return finish('done', true);
      maxId = res.nextMaxId;
      if (pages < deps.pageCap) await deps.sleep(delayMs);
    }
    if (pages >= deps.pageCap) return finish('capped', false);
  }
  return finish('done', false);

  function finish(status: SyncStatus, complete = false): SyncOutcome {
    return { status, complete, serverCount, profileTotal, mergedThisRun };
  }
  function done(status: SyncStatus): SyncOutcome {
    return { status, complete: false, serverCount, profileTotal, mergedThisRun };
  }
}
