import { describe, it, expect, vi } from 'vitest';
import { runCheckinSync, type CheckinSyncDeps } from './handle-checkin-sync';
import type { CheckinSyncPageResult } from '../api/types';

function page(over: Partial<CheckinSyncPageResult>): CheckinSyncPageResult {
  return { merged: 25, alreadyKnown: 0, pageSize: 25, nextMaxId: '1', profileTotal: 100, serverCount: 0, complete: false, ...over };
}

function baseDeps(over: Partial<CheckinSyncDeps>): CheckinSyncDeps {
  return {
    getState: async () => ({ username: 'bob', deepest_max_id: null, complete: false, serverCount: 0, profileTotal: 100 }),
    fetchFeed: async () => '<html>feed</html>',
    submitPage: async () => page({}),
    onProgress: () => {},
    sleep: async () => {},
    pageCap: 200,
    ...over,
  };
}

describe('runCheckinSync', () => {
  it('Phase 0 (recent feed) stops on the first fully-known page', async () => {
    const submitPage = vi.fn(async () => page({ merged: 0, alreadyKnown: 25, pageSize: 25, nextMaxId: '1' }));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(submitPage).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('done');
  });

  it('walks to feed bottom and reports complete', async () => {
    let n = 0;
    const submitPage = vi.fn(async () => (++n < 3 ? page({ nextMaxId: String(10 - n) }) : page({ nextMaxId: null, complete: true })));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(submitPage).toHaveBeenCalledTimes(3);
    expect(out.complete).toBe(true);
  });

  it('Phase 1 (deep extend) resumes from the saved cursor when Phase 0 is fully known', async () => {
    const getState = async () => ({ username: 'bob', deepest_max_id: '500', complete: false, serverCount: 5000, profileTotal: 8000 });
    const calls: (string | null)[] = [];
    const submitPage = vi.fn(async (_html: string, maxId: string | null) => {
      calls.push(maxId);
      if (calls.length === 1) return page({ merged: 0, alreadyKnown: 25 }); // Phase 1 top: fully known
      return page({ nextMaxId: null, complete: true }); // Phase 2 from cursor → bottom
    });
    await runCheckinSync(baseDeps({ getState, submitPage }));
    expect(calls[0]).toBeNull();
    expect(calls[1]).toBe('500');
  });

  it('halts and reports the page cap', async () => {
    const submitPage = vi.fn(async () => page({ nextMaxId: '1' })); // never bottoms out
    const out = await runCheckinSync(baseDeps({ submitPage, pageCap: 3 }));
    expect(submitPage).toHaveBeenCalledTimes(3);
    expect(out.status).toBe('capped');
    expect(out.complete).toBe(false);
  });

  it('surfaces not_linked from getState', async () => {
    const getState = vi.fn(async () => { throw Object.assign(new Error(), { code: 'not_linked' }); });
    const out = await runCheckinSync(baseDeps({ getState }));
    expect(out.status).toBe('not_linked');
  });

  it('surfaces blocked from submitPage', async () => {
    const submitPage = vi.fn(async () => { throw Object.assign(new Error(), { code: 'blocked' }); });
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(out.status).toBe('blocked');
  });

  it('does not schedule Phase 1 when state is already complete', async () => {
    const getState = async () => ({ username: 'bob', deepest_max_id: '500', complete: true, serverCount: 9000, profileTotal: 9000 });
    const submitPage = vi.fn(async () => page({ merged: 0, alreadyKnown: 25 })); // Phase 0 fully known → stop
    await runCheckinSync(baseDeps({ getState, submitPage }));
    expect(submitPage).toHaveBeenCalledTimes(1); // only Phase 0 ran
  });

  it('reaching feed bottom in Phase 0 skips Phase 1', async () => {
    const getState = async () => ({ username: 'bob', deepest_max_id: '500', complete: false, serverCount: 0, profileTotal: 100 });
    const submitPage = vi.fn(async () => page({ nextMaxId: null, complete: true }));
    const out = await runCheckinSync(baseDeps({ getState, submitPage }));
    expect(submitPage).toHaveBeenCalledTimes(1);
    expect(out.complete).toBe(true);
  });

  it('reports progress once per page', async () => {
    let n = 0;
    const submitPage = vi.fn(async () => (++n < 3 ? page({ nextMaxId: String(10 - n) }) : page({ nextMaxId: null, complete: true })));
    const onProgress = vi.fn();
    await runCheckinSync(baseDeps({ submitPage, onProgress }));
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it('stops cleanly on a zero-item page', async () => {
    const submitPage = vi.fn(async () => page({ merged: 0, alreadyKnown: 0, pageSize: 0, nextMaxId: null }));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(submitPage).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('done');
  });
});
