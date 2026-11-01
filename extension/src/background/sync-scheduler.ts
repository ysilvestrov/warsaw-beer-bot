import type { CheckinSyncPageResult } from '../api/types';
import type { SyncOutcome } from './handle-checkin-sync';

// #934: the sync scheduler. It keeps only the INTENT "a sync is wanted" (manual or silent, and how
// much of the silent budget is spent) — never a cursor: where to continue is what the server's (or
// the local database's) coverage says (#587). Steps of runCheckinSync follow one another until the
// intent is gone; a watchdog alarm brings the loop back when the worker dies. No chrome.* here:
// everything comes in through SchedulerDeps, so it is tested without Chrome.

export const STEP_PAGE_CAP = 200;
/** Silent budget — REQUESTS to untappd.com per check, reserved before each one goes out. */
export const SILENT_BUDGET = 10;
export const MAX_CHECKS_PER_DAY = 4;
/** Check-ins on a more_feed page (live probe 2026-10-31); the profile page has 15. */
export const MORE_FEED_PAGE_SIZE = 25;
export const WATCHDOG_ALARM = 'wbb-sync-watchdog';
export const CHECK_ALARM = 'wbb-sync-check';
export const CHECK_PERIOD_MINUTES = 360;

export const INTENT_KEY = 'syncIntent';
export const PAUSE_KEY = 'syncPause';
export const CHECKS_KEY = 'syncChecks';

export interface SyncIntent {
  /** A fresh id per start: settling one intent never removes another written meanwhile. */
  id: string;
  kind: 'manual' | 'silent';
  startedAt: string;
  silentPagesUsed: number;
}

/** An intent older than this is a leftover (a rollback and a later upgrade), not a wish. */
export const INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SchedulerStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface StepRequest {
  pageCap: number;
  signal: AbortSignal;
  beforeFetch: () => Promise<boolean>;
  afterPage: (res: CheckinSyncPageResult, pages: number) => 'continue' | 'stop';
}

/** What the popup state gets once the intent is settled. */
export interface SchedulerReport {
  outcome: SyncOutcome;
  kind: SyncIntent['kind'];
  /** `gap`: the estimate profileTotal − serverCount; only a display, never a decision. */
  gapMissing: number | null;
  pausedUntil: string | null;
  /** A silent check found no session: a calm hint, no badge. */
  quiet: boolean;
  /** false — the intent was dropped without a step in this worker (resume found no token). */
  afterStep: boolean;
}

export interface SchedulerDeps {
  store: SchedulerStore;
  alarms: { create: (name: string, periodInMinutes: number) => Promise<void>; clear: (name: string) => Promise<void> };
  now: () => Date;
  runStep: (req: StepRequest) => Promise<SyncOutcome>;
  newId?: () => string;
  clearMatchCache: () => Promise<void>;
  hasUntappdPermission: () => Promise<boolean>;
  hasToken: () => Promise<boolean>;
  onReport: (r: SchedulerReport) => Promise<void>;
}

export type CheckResult = 'started' | 'no_permission' | 'no_token' | 'running' | 'paused' | 'daily_limit';

export function nextLocalMidnight(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
}

export function localDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Pages a silent sync would need to close the count gap, from the counters only. */
export function pagesNeeded(profileTotal: number | null, serverCount: number): number {
  if (profileTotal === null) return 0;
  return Math.ceil(Math.max(0, profileTotal - serverCount) / MORE_FEED_PAGE_SIZE);
}

function emptyOutcome(status: SyncOutcome['status']): SyncOutcome {
  return { status, complete: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, caughtUp: false };
}

export function createSyncScheduler(deps: SchedulerDeps) {
  let loopPromise: Promise<void> | null = null;
  let controller: AbortController | null = null;
  // The last intent this instance read or wrote: afterPage is synchronous.
  let current: SyncIntent | null = null;
  const newId = deps.newId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  // Every read-modify-write of the intent runs in this chain: storage has no transactions, and a
  // start, a budget reservation and a settle must not interleave inside one worker.
  let intentChain: Promise<unknown> = Promise.resolve();
  function withIntent<T>(work: (cur: SyncIntent | null) => Promise<T>): Promise<T> {
    const run = intentChain.then(async () => work(await readIntent()));
    intentChain = run.catch(() => undefined);
    return run;
  }

  const readIntent = async () => (current = (await deps.store.get<SyncIntent>(INTENT_KEY)) ?? null);
  async function writeIntent(i: SyncIntent): Promise<void> {
    await deps.store.set(INTENT_KEY, i);
    current = i;
    await deps.alarms.create(WATCHDOG_ALARM, 1);
  }
  async function removeIntent(): Promise<void> {
    await deps.store.remove(INTENT_KEY);
    current = null;
    await deps.alarms.clear(WATCHDOG_ALARM);
  }
  /** Removes the intent only if it is still `id`; true when nothing else is wanted now. */
  const clearIntent = (id: string) => withIntent(async (cur) => {
    if (cur && cur.id !== id) return false;
    await removeIntent();
    return true;
  });

  const beforeFetch = () => withIntent(async (i) => {
    if (!i) return false;
    if (i.kind === 'manual') return true;
    if (i.silentPagesUsed >= SILENT_BUDGET) return false;
    // Reserved and stored BEFORE the request: a worker that dies between request and answer leaves
    // the page counted, so a restart cannot spend more than the budget.
    await writeIntent({ ...i, silentPagesUsed: i.silentPagesUsed + 1 });
    return true;
  });

  function afterPage(res: CheckinSyncPageResult): 'continue' | 'stop' {
    if (!current || current.kind === 'manual') return 'continue';
    return pagesNeeded(res.profileTotal, res.serverCount) > SILENT_BUDGET - current.silentPagesUsed ? 'stop' : 'continue';
  }

  async function settle(outcome: SyncOutcome, intent: SyncIntent): Promise<void> {
    const kind = intent.kind;
    const missing = outcome.profileTotal !== null ? Math.max(0, outcome.profileTotal - outcome.serverCount) : null;
    // A silent budget spent on a coverage hole, with the counts equal, is no news for the person:
    // only a count gap is a gap (badge, "N new check-ins").
    const gap = outcome.status === 'gap' || (outcome.status === 'capped' && kind === 'silent' && missing !== null && missing > 0);
    let pausedUntil: string | null = null;
    if (outcome.status === 'blocked') {
      pausedUntil = nextLocalMidnight(deps.now()).toISOString();
      await deps.store.set(PAUSE_KEY, { until: pausedUntil });
    }
    await withIntent(async (cur) => {
      // A start written while this step ran has its own id and stays: the loop runs it next.
      if (cur && cur.id !== intent.id) return;
      // The verdict is stored before the intent goes: a worker that dies between the two re-runs the
      // step from the intent, instead of leaving a finished sync without its ✓, gap or pause.
      await deps.onReport({
        outcome: gap ? { ...outcome, status: 'gap' } : outcome,
        kind,
        gapMissing: gap ? missing : null,
        pausedUntil,
        quiet: outcome.status === 'no_session' && kind === 'silent',
        afterStep: true,
      });
      await removeIntent();
    });
  }

  function loop(): Promise<void> {
    loopPromise ??= runLoop().finally(() => {
      loopPromise = null;
      // An intent written after the loop's last read but before it ended is not left to the watchdog.
      void deps.store.get<SyncIntent>(INTENT_KEY).then((i) => { if (i && !loopPromise) void loop(); }, () => undefined);
    });
    return loopPromise;
  }

  async function runLoop(): Promise<void> {
    for (;;) {
      const intent = await readIntent();
      if (!intent) return;
      const step = new AbortController();
      controller = step;
      let outcome: SyncOutcome;
      try {
        outcome = await deps.runStep({ pageCap: STEP_PAGE_CAP, signal: step.signal, beforeFetch, afterPage });
      } catch {
        outcome = emptyOutcome('error');
      } finally {
        if (controller === step) controller = null;
      }
      if (outcome.mergedThisRun > 0) {
        // New check-ins: the /match cache would keep the old "not drunk" for up to 8 h.
        await deps.clearMatchCache().catch(() => undefined);
      }
      const after = await readIntent();
      // Stop removed the intent while the step ran — also when a Sync after it already wrote a new
      // one: that is a request of its own, not this step's to settle. The loop runs it next.
      if (!after || (step.signal.aborted && after.id !== intent.id)) {
        await deps.onReport({ outcome: { ...outcome, status: 'cancelled' }, kind: intent.kind, gapMissing: null, pausedUntil: null, quiet: false, afterStep: true });
        continue;
      }
      // capped and gap are budget verdicts: a manual intent — also one pressed after the silent step
      // ended, before this read — owes them nothing and runs on.
      if ((outcome.status === 'capped' || outcome.status === 'gap') && after.kind === 'manual') continue;
      await settle(outcome, after);
    }
  }

  return {
    get running(): boolean { return loopPromise !== null; },

    async startManual(): Promise<{ alreadyRunning: boolean }> {
      const alreadyRunning = loopPromise !== null;
      await deps.store.remove(PAUSE_KEY);
      // A new id even over a running silent intent: a settle of the silent one keeps this start.
      // A fresh press is a fresh request: its age starts now, so the day limit cannot expire it early.
      await withIntent((i) => writeIntent({ id: newId(), kind: 'manual', startedAt: deps.now().toISOString(), silentPagesUsed: i?.silentPagesUsed ?? 0 }));
      void loop();
      return { alreadyRunning };
    },

    async stop(): Promise<boolean> {
      const had = await withIntent(async (i) => {
        await removeIntent();
        return i !== null;
      }) || loopPromise !== null;
      controller?.abort();
      return had;
    },

    async check(): Promise<CheckResult> {
      // Never asks for the permission itself: only uses one the person gave.
      if (!(await deps.hasUntappdPermission())) return 'no_permission';
      if (!(await deps.hasToken())) return 'no_token';
      if (loopPromise || (await readIntent())) return 'running';
      const now = deps.now();
      const pause = await deps.store.get<{ until: string }>(PAUSE_KEY);
      if (pause && Date.parse(pause.until) > now.getTime()) return 'paused';
      const today = localDate(now);
      const checks = await deps.store.get<{ date: string; count: number }>(CHECKS_KEY);
      const count = checks && checks.date === today ? checks.count : 0;
      if (count >= MAX_CHECKS_PER_DAY) return 'daily_limit';
      // Counted before the request, like the budget.
      await deps.store.set(CHECKS_KEY, { date: today, count: count + 1 });
      const started = await withIntent(async (i) => {
        if (i) return false;
        await writeIntent({ id: newId(), kind: 'silent', startedAt: now.toISOString(), silentPagesUsed: 0 });
        return true;
      });
      if (!started) return 'running';
      void loop();
      return 'started';
    },

    /** Worker start and the watchdog alarm: continue an intent nobody is running. */
    async resume(): Promise<void> {
      if (loopPromise) return;
      // In the chain: a check that writes its intent (and watchdog) meanwhile is not undone by this clear.
      const i = await withIntent(async (cur) => {
        if (!cur) await deps.alarms.clear(WATCHDOG_ALARM);
        return cur;
      });
      if (!i) return;
      if (!(deps.now().getTime() - Date.parse(i.startedAt) < INTENT_MAX_AGE_MS)) {
        await clearIntent(i.id);
        return;
      }
      const token = await deps.hasToken();
      if (!token || !(await deps.hasUntappdPermission())) {
        if (!(await clearIntent(i.id))) return;
        await deps.onReport({ outcome: emptyOutcome(token ? 'error' : 'not_linked'), kind: i.kind, gapMissing: null, pausedUntil: null, quiet: false, afterStep: false });
        return;
      }
      // Chrome does not promise that alarms survive a browser restart: without the watchdog a second
      // worker death would strand the intent (a check sees it and never starts).
      await deps.alarms.create(WATCHDOG_ALARM, 1);
      // The dead worker may have had pages accepted and died before its step cleared the /match cache;
      // the resumed step finds them known (merged 0) and would leave the old "not drunk" for 8 h.
      await deps.clearMatchCache().catch(() => undefined);
      await loop();
    },

    /** Resolves when the current loop has settled. */
    idle(): Promise<void> {
      return loopPromise ?? Promise.resolve();
    },
  };
}

export type SyncScheduler = ReturnType<typeof createSyncScheduler>;
