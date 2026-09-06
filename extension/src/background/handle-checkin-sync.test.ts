import { describe, it, expect, vi } from 'vitest';
import { runCheckinSync, type CheckinSyncDeps } from './handle-checkin-sync';
import type { CheckinSyncPageResult } from '../api/types';

function page(over: Partial<CheckinSyncPageResult>): CheckinSyncPageResult {
  return { merged: 25, alreadyKnown: 0, pageSize: 25, nextMaxId: '1', nextCursor: '1', profileTotal: 100, serverCount: 0, complete: false, ...over };
}

function baseDeps(over: Partial<CheckinSyncDeps>): CheckinSyncDeps {
  return {
    // #587: НЕ null — інакше «курсор ігнорується» і «курсор використовується» дають
    // однаковий результат, і повернення старої фази-2 не впіймає жоден тест.
    getState: async () => ({ username: 'bob', deepest_max_id: '500', complete: true, serverCount: 0, profileTotal: 100 }),
    fetchFeed: async () => '<html>feed</html>',
    submitPage: async () => page({}),
    onProgress: () => {},
    sleep: async () => {},
    pageCap: 200,
    ...over,
  };
}

describe('runCheckinSync', () => {
  it('follows nextCursor and stops when the server says there is nothing below', async () => {
    const cursors: (string | null)[] = [];
    const submitPage = vi.fn(async (_html: string, cursor: string | null) => {
      cursors.push(cursor);
      return cursors.length === 1 ? page({ nextCursor: '500' }) : page({ nextCursor: null });
    });
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(cursors).toEqual([null, '500']);
    expect(out.status).toBe('done');
  });

  // #587: сервер стрибає під покриту територію — клієнт просто йде, куди сказано,
  // і більше не має власної евристики «усі відомі → стоп».
  it('does not stop on a fully-known page when the server hands back a cursor', async () => {
    let n = 0;
    const submitPage = vi.fn(async () => (++n < 3
      ? page({ merged: 0, alreadyKnown: 25, nextCursor: String(100 - n) })
      : page({ nextCursor: null })));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(submitPage).toHaveBeenCalledTimes(3);
    expect(out.status).toBe('done');
  });

  it('reports complete from the counts, not from the feed bottom', async () => {
    const submitPage = vi.fn(async () => page({ nextCursor: null, serverCount: 100, profileTotal: 100 }));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(out.complete).toBe(true);
  });

  it('does not claim complete when the counts still disagree', async () => {
    const submitPage = vi.fn(async () => page({ nextCursor: null, serverCount: 90, profileTotal: 100 }));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(out.complete).toBe(false);
  });

  it('surfaces a dead Untappd session as its own status', async () => {
    const submitPage = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'no_session' }); });
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(out.status).toBe('no_session');
  });

  it('halts and reports the page cap', async () => {
    const submitPage = vi.fn(async () => page({ nextCursor: '1' })); // never bottoms out
    const out = await runCheckinSync(baseDeps({ submitPage, pageCap: 3 }));
    expect(submitPage).toHaveBeenCalledTimes(3);
    expect(out.status).toBe('capped');
    expect(out.complete).toBe(false);
  });

  it('stops before submitting a page when the run is cancelled during the feed request', async () => {
    const controller = new AbortController();
    const submitPage = vi.fn(async () => page({}));
    const fetchFeed = async () => {
      controller.abort();
      return '<html>feed</html>';
    };

    const out = await runCheckinSync(baseDeps({
      fetchFeed,
      submitPage,
      signal: controller.signal,
    }));

    expect(out.status).toBe('cancelled');
    expect(submitPage).not.toHaveBeenCalled();
  });

  it('records an accepted page before reporting cancellation', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn();
    const submitPage = async () => {
      controller.abort();
      return page({ merged: 5, serverCount: 17, profileTotal: 100, nextMaxId: '11' });
    };

    const out = await runCheckinSync(baseDeps({
      submitPage,
      onProgress,
      signal: controller.signal,
    }));

    expect(out).toMatchObject({ status: 'cancelled', serverCount: 17, mergedThisRun: 5 });
    expect(onProgress).toHaveBeenCalledWith({ serverCount: 17, profileTotal: 100, mergedThisRun: 5 });
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

  it('reports progress once per page', async () => {
    let n = 0;
    const submitPage = vi.fn(async () => (++n < 3 ? page({ nextCursor: String(10 - n) }) : page({ nextCursor: null })));
    const onProgress = vi.fn();
    await runCheckinSync(baseDeps({ submitPage, onProgress }));
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  // #587: явний `null` — «роботи немає», обхід завершується успішно.
  it('finishes done on an explicit null nextCursor', async () => {
    const submitPage = vi.fn(async () => page({ nextCursor: null }));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(out.status).toBe('done');
  });

  // #587: сервер, відкочений нижче цієї гілки, шле відповідь узагалі БЕЗ цього поля —
  // на відміну від явного `null`. Мовчазна зупинка тут виглядала б як звичайний
  // частковий прогрес, тож це має бути помилка, а не вдаваний `done`.
  it('reports an error, not done, when nextCursor is absent from the response', async () => {
    const submitPage = vi.fn(async () => {
      const { nextCursor: _drop, ...rest } = page({});
      return rest as CheckinSyncPageResult;
    });
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(out.status).toBe('error');
    expect(submitPage).toHaveBeenCalledTimes(1);
  });

  it('keeps the profile total from page one when later pages carry none', async () => {
    let n = 0;
    const submitPage = vi.fn(async () => (++n === 1
      ? page({ profileTotal: 100, serverCount: 50, nextCursor: '500' })
      : page({ profileTotal: null, serverCount: 100, nextCursor: null })));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(out.profileTotal).toBe(100);
    expect(out.complete).toBe(true);
  });
});
