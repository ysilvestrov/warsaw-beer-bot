import { describe, it, expect, vi } from 'vitest';
import type { CheckinSyncPageResult } from '../api/types';
import type { SyncOutcome } from './handle-checkin-sync';
import {
  CHECKS_KEY, INTENT_KEY, PAUSE_KEY, SILENT_BUDGET, WATCHDOG_ALARM,
  createSyncScheduler, localDate, nextLocalMidnight, pagesNeeded,
  type SchedulerDeps, type SchedulerReport, type StepRequest, type SyncIntent,
} from './sync-scheduler';

function memoryStore(init: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(init));
  return {
    data,
    get: async <T,>(k: string) => data.get(k) as T | undefined,
    set: async (k: string, v: unknown) => { data.set(k, structuredClone(v)); },
    remove: async (k: string) => { data.delete(k); },
  };
}

function outcome(status: SyncOutcome['status'], over: Partial<SyncOutcome> = {}): SyncOutcome {
  return { status, complete: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, caughtUp: false, ...over };
}

// A feed of `pages` more_feed pages of 25, walked the way runCheckinSync calls the hooks:
// beforeFetch before every request, afterPage after every accepted page that is not the last.
function fakeFeed(pages: number, opts: { profileTotal: number; serverCount?: number; merged?: number } ) {
  let left = pages;
  let count = opts.serverCount ?? 0;
  const perPage = opts.merged ?? 25;
  const steps: number[] = [];
  const runStep = async (req: StepRequest): Promise<SyncOutcome> => {
    let n = 0;
    let merged = 0;
    const out = (status: SyncOutcome['status']) => outcome(status, { serverCount: count, profileTotal: opts.profileTotal, mergedThisRun: merged });
    try {
      while (n < req.pageCap) {
        if (req.signal.aborted) return out('cancelled');
        if (!(await req.beforeFetch())) return out('capped');
        n++; left--; count += perPage; merged += perPage;
        const res: CheckinSyncPageResult = { merged: perPage, alreadyKnown: 0, pageSize: 25, nextMaxId: null,
          nextCursor: left > 0 ? String(left) : null, profileTotal: opts.profileTotal, serverCount: count, complete: false };
        if (res.nextCursor === null) return out('done');
        if (req.afterPage(res, n) === 'stop') return out('gap');
      }
      return out('capped');
    } finally {
      steps.push(n);
    }
  };
  return { runStep, steps };
}

function setup(over: Partial<SchedulerDeps> = {}, store = memoryStore()) {
  const alarms = new Set<string>();
  const reports: SchedulerReport[] = [];
  const clearMatchCache = vi.fn(async () => {});
  let now = new Date(2026, 10, 1, 12, 0, 0);
  const deps: SchedulerDeps = {
    store,
    alarms: { create: async (n) => { alarms.add(n); }, clear: async (n) => { alarms.delete(n); } },
    now: () => now,
    runStep: async () => outcome('done'),
    clearMatchCache,
    hasUntappdPermission: async () => true,
    hasToken: async () => true,
    onReport: async (r) => { reports.push(r); },
    ...over,
  };
  const scheduler = createSyncScheduler(deps);
  return { scheduler, store, alarms, reports, clearMatchCache, setNow: (d: Date) => { now = d; } };
}

const never = () => new Promise<never>(() => {});

describe('pagesNeeded', () => {
  it('is 0 without a profile total', () => expect(pagesNeeded(null, 10)).toBe(0));
  it('is 0 when the counts agree (a coverage hole is left to the budget)', () => expect(pagesNeeded(100, 100)).toBe(0));
  it('is 0 when the count is above the total', () => expect(pagesNeeded(100, 120)).toBe(0));
  it('rounds a partial page up', () => expect(pagesNeeded(126, 100)).toBe(2));
  it('counts whole pages exactly', () => expect(pagesNeeded(150, 100)).toBe(2));
});

describe('local calendar helpers', () => {
  it('pauses until the next local midnight, also one minute before it', () => {
    expect(nextLocalMidnight(new Date(2026, 10, 1, 23, 59))).toEqual(new Date(2026, 10, 2, 0, 0, 0, 0));
  });
  it('rolls over a month end', () => {
    expect(nextLocalMidnight(new Date(2026, 9, 31, 8, 0))).toEqual(new Date(2026, 10, 1, 0, 0, 0, 0));
  });
  it('formats the local date with padding', () => expect(localDate(new Date(2026, 0, 5, 1, 0))).toBe('2026-01-05'));
});

describe('manual sync', () => {
  it('walks 450 pages in three steps without a press, then drops the intent and the watchdog', async () => {
    const feed = fakeFeed(450, { profileTotal: 450 * 25 });
    const t = setup({ runStep: feed.runStep });
    await t.scheduler.startManual();
    expect(t.alarms.has(WATCHDOG_ALARM)).toBe(true);
    await t.scheduler.idle();
    expect(feed.steps).toEqual([200, 200, 50]);
    expect(t.reports.map((r) => r.outcome.status)).toEqual(['done']);
    expect(t.store.data.has(INTENT_KEY)).toBe(false);
    expect(t.alarms.has(WATCHDOG_ALARM)).toBe(false);
  });

  it('continues after a worker death: a new scheduler over the same storage resumes from the first page', async () => {
    const store = memoryStore();
    const dead = setup({ runStep: never }, store);
    await dead.scheduler.startManual();
    const feed = fakeFeed(3, { profileTotal: 75 });
    const reborn = setup({ runStep: feed.runStep }, store);
    await reborn.scheduler.resume();
    expect(feed.steps).toEqual([3]);
    expect(reborn.reports.map((r) => r.outcome.status)).toEqual(['done']);
    expect(store.data.has(INTENT_KEY)).toBe(false);
  });

  it('turns a running silent intent into a manual one without restarting', async () => {
    const t = setup({ runStep: never });
    await t.scheduler.check();
    const reply = await t.scheduler.startManual();
    expect(reply).toEqual({ alreadyRunning: true });
    expect((t.store.data.get(INTENT_KEY) as SyncIntent).kind).toBe('manual');
  });

  // #934 review: a press that lands while the previous intent settles is not wiped out by that settle.
  it('keeps and runs a manual start written while a silent intent settles', async () => {
    const base = memoryStore();
    let t!: ReturnType<typeof setup>;
    // The pause is written inside the intent chain: a press then queues behind the settle, so it
    // is not awaited here (that would wait on the chain it sits in).
    const store = { ...base, set: async (k: string, v: unknown) => {
      await base.set(k, v);
      if (k === PAUSE_KEY) void t.scheduler.startManual();
    } };
    const runStep = vi.fn()
      .mockResolvedValueOnce(outcome('blocked'))
      .mockResolvedValueOnce(outcome('done', { serverCount: 5, profileTotal: 5 }));
    t = setup({ runStep }, store as never);
    await t.scheduler.check();
    await vi.waitFor(() => expect(runStep).toHaveBeenCalledTimes(2));
    await t.scheduler.idle();
    expect(t.reports.map((r) => [r.kind, r.outcome.status])).toEqual([['silent', 'blocked'], ['manual', 'done']]);
    expect(base.data.has(INTENT_KEY)).toBe(false);
    // The press lifts the pause the silent step had just set.
    expect(base.data.has(PAUSE_KEY)).toBe(false);
  });

  it('stop drops the intent, reports cancelled, and the watchdog restores nothing', async () => {
    const runStep = vi.fn((req: StepRequest) => new Promise<SyncOutcome>((resolve) => {
      req.signal.addEventListener('abort', () => resolve(outcome('cancelled')));
    }));
    const t = setup({ runStep });
    await t.scheduler.startManual();
    expect(await t.scheduler.stop()).toBe(true);
    await t.scheduler.idle();
    await t.scheduler.resume();
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(t.reports.map((r) => r.outcome.status)).toEqual(['cancelled']);
    expect(t.store.data.has(INTENT_KEY)).toBe(false);
    expect(t.alarms.has(WATCHDOG_ALARM)).toBe(false);
  });

  // #934 cross-review: Stop, then Sync before the aborted step has settled — the step must not
  // settle the new intent as its own.
  it('a Sync pressed right after Stop survives the cancelled step and runs', async () => {
    let releaseCancel!: () => void;
    const cancelled = new Promise<void>((r) => { releaseCancel = r; });
    const runStep = vi.fn()
      .mockImplementationOnce((req: StepRequest) => new Promise<SyncOutcome>((resolve) => {
        req.signal.addEventListener('abort', () => { void cancelled.then(() => resolve(outcome('cancelled'))); });
      }))
      .mockResolvedValueOnce(outcome('done', { serverCount: 5, profileTotal: 5 }));
    const t = setup({ runStep });
    await t.scheduler.startManual();
    await vi.waitFor(() => expect(runStep).toHaveBeenCalledTimes(1));
    await t.scheduler.stop();
    await t.scheduler.startManual();
    releaseCancel();
    await vi.waitFor(() => expect(runStep).toHaveBeenCalledTimes(2));
    await t.scheduler.idle();
    expect(t.reports.map((r) => r.outcome.status)).toEqual(['cancelled', 'done']);
    expect(t.store.data.has(INTENT_KEY)).toBe(false);
  });

  // #934 PR review: a press between the end of a silent step and the loop's next read.
  it('a Sync pressed right after a silent step ended with a gap runs as manual', async () => {
    let t!: ReturnType<typeof setup>;
    const runStep = vi.fn()
      .mockResolvedValueOnce(outcome('gap', { serverCount: 50, profileTotal: 500, mergedThisRun: 25 }))
      .mockResolvedValueOnce(outcome('done', { serverCount: 500, profileTotal: 500 }));
    // The cache clear runs between the step and the loop's read of the intent.
    t = setup({ runStep, clearMatchCache: async () => { await t.scheduler.startManual(); } });
    await t.scheduler.check();
    await vi.waitFor(() => expect(runStep).toHaveBeenCalledTimes(2));
    await t.scheduler.idle();
    expect(t.reports.map((r) => [r.kind, r.outcome.status])).toEqual([['manual', 'done']]);
  });

  // #934 PR review @6fbb536: the same window, with a step that ended in a pause — the press must not
  // be settled by the old step's verdict (it would put the pause back).
  it('a Sync pressed right after a silent step ended blocked runs, and the pause is not set', async () => {
    let t!: ReturnType<typeof setup>;
    const runStep = vi.fn()
      .mockResolvedValueOnce(outcome('blocked', { serverCount: 75, profileTotal: 500, mergedThisRun: 25 }))
      .mockResolvedValueOnce(outcome('done', { serverCount: 500, profileTotal: 500 }));
    t = setup({ runStep, clearMatchCache: async () => { await t.scheduler.startManual(); } });
    await t.scheduler.check();
    await vi.waitFor(() => expect(runStep).toHaveBeenCalledTimes(2));
    await t.scheduler.idle();
    expect(t.reports.map((r) => [r.kind, r.outcome.status])).toEqual([['manual', 'done']]);
    expect(t.store.data.has(PAUSE_KEY)).toBe(false);
  });

  // #934 PR review @6fbb536: a report that fails must not leave the intent to restart the loop.
  it('a verdict that fails to store still ends the sync: one step, no intent left', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runStep = vi.fn(async () => outcome('done', { serverCount: 5, profileTotal: 5, caughtUp: true }));
    const t = setup({ runStep, onReport: async () => { throw new Error('quota'); } });
    await t.scheduler.startManual();
    await t.scheduler.idle();
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(t.store.data.has(INTENT_KEY)).toBe(false);
    expect(warn).toHaveBeenCalledWith('[beer-overlay] sync verdict not stored', new Error('quota'));
    warn.mockRestore();
  });

  // #934 PR review: a worker death between the two must not lose the verdict.
  it('stores the verdict while the intent still stands', async () => {
    const store = memoryStore();
    const seen: boolean[] = [];
    const t = setup({ runStep: async () => outcome('done', { serverCount: 5, profileTotal: 5, caughtUp: true }),
      onReport: async () => { seen.push(store.data.has(INTENT_KEY)); } }, store);
    await t.scheduler.startManual();
    await t.scheduler.idle();
    expect(seen).toEqual([true]);
    expect(store.data.has(INTENT_KEY)).toBe(false);
  });

  it('a step that threw ends as error and drops the intent', async () => {
    const t = setup({ runStep: async () => { throw new Error('boom'); } });
    await t.scheduler.startManual();
    await t.scheduler.idle();
    expect(t.reports.map((r) => r.outcome.status)).toEqual(['error']);
    expect(t.store.data.has(INTENT_KEY)).toBe(false);
  });
});

describe('fresh ✅ after a sync', () => {
  it('clears the /match cache once for a step that merged new check-ins', async () => {
    const t = setup({ runStep: async () => outcome('done', { mergedThisRun: 3 }) });
    await t.scheduler.startManual();
    await t.scheduler.idle();
    expect(t.clearMatchCache).toHaveBeenCalledTimes(1);
  });

  it('leaves the cache alone for a step without new check-ins', async () => {
    const t = setup({ runStep: async () => outcome('done', { mergedThisRun: 0 }) });
    await t.scheduler.startManual();
    await t.scheduler.idle();
    expect(t.clearMatchCache).toHaveBeenCalledTimes(0);
  });
});

describe('silent sync budget', () => {
  it('never lets more than the budget of requests out, even when the worker died after reserving one', async () => {
    const store = memoryStore();
    const dead = setup({ runStep: async (req) => { await req.beforeFetch(); return never(); } }, store);
    expect(await dead.scheduler.check()).toBe('started');
    await vi.waitFor(() => expect((store.data.get(INTENT_KEY) as SyncIntent).silentPagesUsed).toBe(1));

    let allowed = 0;
    const reborn = setup({ runStep: async (req) => {
      while (await req.beforeFetch()) allowed++;
      return outcome('capped', { serverCount: 100, profileTotal: 400 });
    } }, store);
    await reborn.scheduler.resume();
    expect(allowed).toBe(SILENT_BUDGET - 1);
    expect(reborn.reports).toEqual([expect.objectContaining({ kind: 'silent', gapMissing: 300, outcome: expect.objectContaining({ status: 'gap' }) })]);
  });

  it('stops after the first page with a gap when more pages are missing than the budget holds', async () => {
    const feed = fakeFeed(20, { profileTotal: 10 * 25 + 25 + 15 });
    const t = setup({ runStep: feed.runStep });
    await t.scheduler.check();
    await t.scheduler.idle();
    expect(feed.steps).toEqual([1]);
    expect(t.reports).toEqual([expect.objectContaining({ gapMissing: 265, outcome: expect.objectContaining({ status: 'gap' }) })]);
  });

  it('finishes within the budget when the missing pages fit', async () => {
    const feed = fakeFeed(9, { profileTotal: 9 * 25 });
    const t = setup({ runStep: feed.runStep });
    await t.scheduler.check();
    await t.scheduler.idle();
    expect(feed.steps).toEqual([9]);
    expect(t.reports.map((r) => r.outcome.status)).toEqual(['done']);
  });

  it('a silent budget spent on a coverage hole with equal counts is no gap', async () => {
    const t = setup({ runStep: async () => outcome('capped', { serverCount: 100, profileTotal: 100 }) });
    await t.scheduler.check();
    await t.scheduler.idle();
    expect(t.reports).toEqual([expect.objectContaining({ gapMissing: null, outcome: expect.objectContaining({ status: 'capped' }) })]);
  });

  it('a silent no_session is quiet', async () => {
    const t = setup({ runStep: async () => outcome('no_session') });
    await t.scheduler.check();
    await t.scheduler.idle();
    expect(t.reports).toEqual([expect.objectContaining({ quiet: true, outcome: expect.objectContaining({ status: 'no_session' }) })]);
  });

  it('a manual no_session is not quiet', async () => {
    const t = setup({ runStep: async () => outcome('no_session') });
    await t.scheduler.startManual();
    await t.scheduler.idle();
    expect(t.reports).toEqual([expect.objectContaining({ quiet: false })]);
  });
});

describe('pause after blocked', () => {
  it('pauses until the next local midnight; a check during it does not start; a manual start lifts it', async () => {
    const runStep = vi.fn(async () => outcome('blocked'));
    const t = setup({ runStep });
    t.setNow(new Date(2026, 10, 1, 23, 59));
    await t.scheduler.startManual();
    await t.scheduler.idle();
    const until = new Date(2026, 10, 2, 0, 0, 0, 0).toISOString();
    expect(t.reports).toEqual([expect.objectContaining({ pausedUntil: until })]);
    expect(t.store.data.get(PAUSE_KEY)).toEqual({ until });

    expect(await t.scheduler.check()).toBe('paused');
    expect(runStep).toHaveBeenCalledTimes(1);

    await t.scheduler.startManual();
    expect(t.store.data.has(PAUSE_KEY)).toBe(false);
    await t.scheduler.idle();
    expect(runStep).toHaveBeenCalledTimes(2);
  });

  it('a check after the pause expired starts', async () => {
    const t = setup({}, memoryStore({ [PAUSE_KEY]: { until: new Date(2026, 10, 1, 0, 0).toISOString() } }));
    expect(await t.scheduler.check()).toBe('started');
  });
});

describe('check conditions', () => {
  it('starts at most four checks a local day; the next day starts again', async () => {
    const t = setup();
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await t.scheduler.check());
      await t.scheduler.idle();
    }
    expect(results).toEqual(['started', 'started', 'started', 'started', 'daily_limit']);
    t.setNow(new Date(2026, 10, 2, 0, 1));
    expect(await t.scheduler.check()).toBe('started');
    expect(t.store.data.get(CHECKS_KEY)).toEqual({ date: '2026-11-02', count: 1 });
  });

  it('without the untappd.com permission makes no request and counts nothing', async () => {
    const runStep = vi.fn(async () => outcome('done'));
    const t = setup({ runStep, hasUntappdPermission: async () => false });
    expect(await t.scheduler.check()).toBe('no_permission');
    expect(runStep).toHaveBeenCalledTimes(0);
    expect(t.store.data.has(CHECKS_KEY)).toBe(false);
  });

  it('without a token makes no request', async () => {
    const runStep = vi.fn(async () => outcome('done'));
    const t = setup({ runStep, hasToken: async () => false });
    expect(await t.scheduler.check()).toBe('no_token');
    expect(runStep).toHaveBeenCalledTimes(0);
  });

  it('does not start a second sync while one is wanted', async () => {
    const t = setup({ runStep: never });
    await t.scheduler.startManual();
    expect(await t.scheduler.check()).toBe('running');
  });
});

describe('resume', () => {
  it('drops an intent older than a day without a request or a report', async () => {
    const intent: SyncIntent = { id: 'a', kind: 'manual', startedAt: new Date(2026, 9, 31, 11, 59).toISOString(), silentPagesUsed: 0 };
    const runStep = vi.fn(async () => outcome('done'));
    const t = setup({ runStep }, memoryStore({ [INTENT_KEY]: intent }));
    await t.scheduler.resume();
    expect(runStep).toHaveBeenCalledTimes(0);
    expect(t.reports).toEqual([]);
    expect(t.store.data.has(INTENT_KEY)).toBe(false);
    expect(t.clearMatchCache).toHaveBeenCalledTimes(0);
  });

  it('continues an intent just under a day old', async () => {
    const intent: SyncIntent = { id: 'a', kind: 'manual', startedAt: new Date(2026, 9, 31, 12, 1).toISOString(), silentPagesUsed: 0 };
    const runStep = vi.fn(async () => outcome('done'));
    const t = setup({ runStep }, memoryStore({ [INTENT_KEY]: intent }));
    await t.scheduler.resume();
    expect(runStep).toHaveBeenCalledTimes(1);
  });

  // #934 cross-review: alarms are not promised to survive a browser restart.
  it('restores a missing watchdog for the intent it continues', async () => {
    const intent: SyncIntent = { id: 'a', kind: 'manual', startedAt: new Date(2026, 10, 1, 10, 0).toISOString(), silentPagesUsed: 0 };
    const t = setup({ runStep: never }, memoryStore({ [INTENT_KEY]: intent }));
    void t.scheduler.resume();
    await vi.waitFor(() => expect(t.alarms.has(WATCHDOG_ALARM)).toBe(true));
  });

  // #934 cross-review: the dead worker's accepted pages come back as known (merged 0) in the resumed step.
  it('clears the /match cache once when it continues a dead worker\'s intent, even if the step merges nothing', async () => {
    const intent: SyncIntent = { id: 'a', kind: 'manual', startedAt: new Date(2026, 10, 1, 10, 0).toISOString(), silentPagesUsed: 0 };
    const t = setup({ runStep: async () => outcome('done', { serverCount: 5, profileTotal: 5 }) }, memoryStore({ [INTENT_KEY]: intent }));
    await t.scheduler.resume();
    expect(t.clearMatchCache).toHaveBeenCalledTimes(1);
  });

  // #934 PR review: resume and the browser-start check run together at worker start.
  it('a resume that saw no intent does not clear the watchdog a concurrent check just set', async () => {
    const base = memoryStore();
    let open!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    let first = true;
    const store = { ...base, get: async <T,>(k: string) => {
      const v = await base.get<T>(k);
      if (k === INTENT_KEY && first) { first = false; await opened; }
      return v;
    } };
    const t = setup({ runStep: never }, store as never);
    const resumed = t.scheduler.resume();
    const checked = t.scheduler.check();
    await new Promise((r) => setTimeout(r, 0));
    open();
    await resumed;
    expect(await checked).toBe('started');
    expect(t.alarms.has(WATCHDOG_ALARM)).toBe(true);
  });

  // #934 PR review: an old silent intent must not make a fresh press expire early.
  it('a manual start over an older intent starts its own day', async () => {
    const intent: SyncIntent = { id: 'a', kind: 'silent', startedAt: new Date(2026, 9, 31, 13, 0).toISOString(), silentPagesUsed: 3 };
    const t = setup({ runStep: never }, memoryStore({ [INTENT_KEY]: intent }));
    await t.scheduler.startManual();
    expect(t.store.data.get(INTENT_KEY)).toMatchObject({ kind: 'manual', startedAt: new Date(2026, 10, 1, 12, 0, 0).toISOString() });
  });

  it('without an intent only drops a stale watchdog', async () => {
    const runStep = vi.fn(async () => outcome('done'));
    const t = setup({ runStep });
    t.alarms.add(WATCHDOG_ALARM);
    await t.scheduler.resume();
    expect(runStep).toHaveBeenCalledTimes(0);
    expect(t.alarms.has(WATCHDOG_ALARM)).toBe(false);
  });

  it('drops an intent whose token is gone, as not_linked', async () => {
    const intent: SyncIntent = { id: 'a', kind: 'manual', startedAt: new Date(2026, 10, 1, 10, 0).toISOString(), silentPagesUsed: 0 };
    const runStep = vi.fn(async () => outcome('done'));
    const t = setup({ runStep, hasToken: async () => false }, memoryStore({ [INTENT_KEY]: intent }));
    await t.scheduler.resume();
    expect(runStep).toHaveBeenCalledTimes(0);
    expect(t.reports).toEqual([expect.objectContaining({ afterStep: false, outcome: expect.objectContaining({ status: 'not_linked' }) })]);
    expect(t.store.data.has(INTENT_KEY)).toBe(false);
  });

  it('drops an intent whose untappd.com permission is gone, as error', async () => {
    const intent: SyncIntent = { id: 'a', kind: 'silent', startedAt: new Date(2026, 10, 1, 10, 0).toISOString(), silentPagesUsed: 2 };
    const t = setup({ hasUntappdPermission: async () => false }, memoryStore({ [INTENT_KEY]: intent }));
    await t.scheduler.resume();
    expect(t.reports.map((r) => r.outcome.status)).toEqual(['error']);
  });
});
