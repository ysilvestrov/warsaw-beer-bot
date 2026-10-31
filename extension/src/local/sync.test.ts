import 'fake-indexeddb/auto';
import { ApiError } from '../api/client';
import type { CheckinSyncPageResult } from '../api/types';
import { runCheckinSync } from '../background/handle-checkin-sync';
import { EMPTY_PAGE, SYNC_SCENARIOS, feedPageOf, type StepExpect } from '../../../src/shared/checkin-sync/scenarios';
import { allCheckins, clearLocalDb, currentGeneration, inPageTx } from './db';
import { UNTAPPD_HOME, localSyncDeps } from './sync';

const signedIn = (name: string) =>
  `<html><body><a class="track-click" data-href=":user/profile" href="/user/${name}">My Profile</a></body></html>`;
const SIGNED_OUT = '<html><body><a href="/login">Log in</a></body></html>';

const deps = (home: string) => localSyncDeps({ fetchText: async () => home, now: () => new Date('2026-10-31T12:00:00Z') });
const ranges = () => inPageTx((tx) => tx.ranges());
const meta = () => inPageTx((tx) => tx.meta());

async function answerOf(run: () => Promise<CheckinSyncPageResult>): Promise<StepExpect> {
  try {
    const r = await run();
    return { status: 200, nextCursor: r.nextCursor, merged: r.merged, alreadyKnown: r.alreadyKnown, serverCount: r.serverCount };
  } catch (e) {
    // The server client's mapping (api/client.ts): 400 bad_cursor → page_rejected, 422 → no_session.
    if (e instanceof ApiError && e.code === 'page_rejected') return { status: 400, error: 'bad_cursor' };
    if (e instanceof ApiError && e.code === 'no_session') return { status: 422, error: 'no_session' };
    throw e;
  }
}

beforeEach(async () => {
  await clearLocalDb();
});

describe('local submitPage — shared scenarios (#924)', () => {
  it.each(SYNC_SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, scenario) => {
    const local = deps(signedIn('bob'));
    const { linkRevision } = await local.getState();
    const answers: StepExpect[] = [];
    for (const step of scenario.steps) answers.push(await answerOf(() => local.submitPage(step.html, step.maxId, linkRevision)));
    expect(answers).toEqual(scenario.steps.map((s) => s.expect));
    expect(await ranges()).toEqual(scenario.coverage);
  });
});

describe('local getState', () => {
  it('makes the session user the owner of a new database, at the current generation', async () => {
    const state = await deps(signedIn('Bob')).getState();
    expect(state).toEqual({ username: 'bob', linkRevision: await currentGeneration(), deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null });
    expect(await meta()).toEqual({ username: 'bob', generation: await currentGeneration(), profileTotal: null, oldestId: null, updatedAt: '2026-10-31T12:00:00.000Z' });
  });

  it('refuses another account than the owner, without touching the database', async () => {
    await deps(signedIn('bob')).getState();
    await expect(deps(signedIn('alice')).getState()).rejects.toMatchObject({ code: 'account_changed' });
    expect((await meta())?.username).toBe('bob');
  });

  it('refuses a signed-out session as no_session', async () => {
    await expect(deps(SIGNED_OUT).getState()).rejects.toMatchObject({ code: 'no_session' });
    expect(await meta()).toBeNull();
  });
});

describe('local submitPage — writes', () => {
  it('replaces a removed rating with null, as the server merge does (spec test 11)', async () => {
    const local = deps(signedIn('bob'));
    const { linkRevision } = await local.getState();
    await local.submitPage(feedPageOf([600], { rating: 4.5 }), null, linkRevision);
    expect((await allCheckins()).map((c) => c.user_rating)).toEqual([4.5]);
    await local.submitPage(feedPageOf([600]), null, linkRevision);
    expect(await allCheckins()).toEqual([{
      checkin_id: '600', bid: 600, beer_name: 'Beer 600', brewery_name: 'Some Brewery', user_rating: null, checkin_at: '2026-06-15 18:00:00',
    }]);
  });

  it('refuses a block page before parsing', async () => {
    const local = deps(signedIn('bob'));
    const { linkRevision } = await local.getState();
    await expect(local.submitPage('<html>Just a moment...</html>', null, linkRevision)).rejects.toMatchObject({ code: 'blocked' });
    expect(await allCheckins()).toEqual([]);
  });

  it('keeps the known profile total when a page carries none', async () => {
    const local = deps(signedIn('bob'));
    const { linkRevision } = await local.getState();
    await local.submitPage(feedPageOf([600, 590], { total: 40 }), null, linkRevision);
    const r = await local.submitPage(EMPTY_PAGE, '590', linkRevision);
    expect(r.profileTotal).toBe(40);
    expect((await meta())?.profileTotal).toBe(40);
  });
});

describe('clearing the local database', () => {
  it('empties every store and starts a new owner at a new generation (spec test 9)', async () => {
    const local = deps(signedIn('bob'));
    const first = await local.getState();
    await local.submitPage(feedPageOf([600, 590]), null, first.linkRevision);
    await clearLocalDb();
    expect(await allCheckins()).toEqual([]);
    expect(await ranges()).toEqual([]);
    expect(await meta()).toBeNull();
    const next = await deps(signedIn('alice')).getState();
    expect(next.username).toBe('alice');
    expect(next.linkRevision).toBe(first.linkRevision + 1);
  });

  it('refuses a late page of the old database and writes it nowhere (spec test 10)', async () => {
    const before = await deps(signedIn('bob')).getState();
    const abort = vi.fn();
    await clearLocalDb(abort);
    expect(abort).toHaveBeenCalledTimes(1);
    const after = deps(signedIn('alice'));
    await after.getState();
    await expect(after.submitPage(feedPageOf([600, 590]), null, before.linkRevision)).rejects.toMatchObject({ code: 'account_changed' });
    expect(await allCheckins()).toEqual([]);
    expect(await ranges()).toEqual([]);
  });
});

describe('a getState in flight across Clear (cross-review finding 1)', () => {
  it('does not re-create the old owner in the new database', async () => {
    let answer: ((html: string) => void) | undefined;
    const pending = localSyncDeps({ fetchText: () => new Promise<string>((resolve) => { answer = resolve; }) }).getState();
    // The session request is in flight (so the generation was already read) when Clear runs.
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    await clearLocalDb();
    answer!(signedIn('bob'));
    await expect(pending).rejects.toMatchObject({ code: 'account_changed' });
    expect(await meta()).toBeNull();
    expect((await deps(signedIn('alice')).getState()).username).toBe('alice');
  });

  it('replaces an owner record left at an older generation with no check-ins', async () => {
    const stale = await currentGeneration();
    await inPageTx((tx) => tx.putMeta({ username: 'bob', generation: stale, profileTotal: null, oldestId: null, updatedAt: 'x' }));
    await chrome.storage.local.set({ localDbGeneration: stale + 1 });
    const state = await deps(signedIn('alice')).getState();
    expect(state).toMatchObject({ username: 'alice', linkRevision: stale + 1 });
    expect(await meta()).toMatchObject({ username: 'alice', generation: stale + 1 });
  });

  it('still refuses an older-generation owner that holds check-ins', async () => {
    const local = deps(signedIn('bob'));
    const { linkRevision } = await local.getState();
    await local.submitPage(feedPageOf([600]), null, linkRevision);
    await chrome.storage.local.set({ localDbGeneration: linkRevision + 1 });
    await expect(deps(signedIn('alice')).getState()).rejects.toMatchObject({ code: 'account_changed' });
    expect((await allCheckins()).length).toBe(1);
  });
});

describe('runCheckinSync over local deps', () => {
  const walk = (home: string, pages: Record<string, string>, fetchSpy: (url: string) => void) => {
    const fetchText = async (url: string) => { fetchSpy(url); return home; };
    const local = localSyncDeps({ fetchText });
    return runCheckinSync({
      ...local,
      fetchFeed: async (_user, maxId) => {
        const url = maxId === null ? 'https://untappd.com/user/bob' : `https://untappd.com/profile/more_feed/bob/${maxId}`;
        fetchSpy(url);
        return pages[maxId ?? 'top'];
      },
      onProgress: () => undefined,
      sleep: async () => undefined,
      pageCap: 10,
      delayMs: 0,
    });
  };

  it('walks three pages to the end and talks only to untappd.com (spec test 8)', async () => {
    const urls: string[] = [];
    const out = await walk(signedIn('bob'), {
      top: feedPageOf([600, 590], { total: 6 }),
      '590': feedPageOf([580, 570]),
      '570': feedPageOf([560, 550]),
    }, (u) => urls.push(u));
    expect(out).toEqual({ status: 'done', complete: true, serverCount: 6, profileTotal: 6, mergedThisRun: 6 });
    expect(urls).toEqual([
      UNTAPPD_HOME,
      'https://untappd.com/user/bob',
      'https://untappd.com/profile/more_feed/bob/590',
      'https://untappd.com/profile/more_feed/bob/570',
    ]);
    expect(await ranges()).toEqual([{ from_id: 550, to_id: 600 }]);
  });

  it('stops with account_changed from getState, not error (spec test 12)', async () => {
    await deps(signedIn('bob')).getState();
    const out = await walk(signedIn('alice'), {}, () => undefined);
    expect(out.status).toBe('account_changed');
  });

  it('stops with no_session from getState, not error (spec test 12)', async () => {
    const out = await walk(SIGNED_OUT, {}, () => undefined);
    expect(out.status).toBe('no_session');
  });
});
