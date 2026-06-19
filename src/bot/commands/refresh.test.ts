import pino from 'pino';
import {
  makeThrottledProgress,
  runRefreshPipeline,
  resolveRefreshScope,
  checkAndStampCooldown,
  cooldownWindowFor,
} from './refresh';
import type { Translator } from '../../i18n/types';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';

describe('makeThrottledProgress', () => {
  test('drops non-forced calls within interval', async () => {
    let now = 1000;
    const calls: string[] = [];
    const send = async (t: string) => {
      calls.push(t);
    };
    const notify = makeThrottledProgress(send, 100, () => now);

    await notify('a');
    await notify('b');
    expect(calls).toEqual(['a']);

    now += 50;
    await notify('c');
    expect(calls).toEqual(['a']);

    now += 60;
    await notify('d');
    expect(calls).toEqual(['a', 'd']);
  });

  test('forced calls bypass throttle', async () => {
    let now = 1000;
    const calls: string[] = [];
    const send = async (t: string) => {
      calls.push(t);
    };
    const notify = makeThrottledProgress(send, 100000, () => now);

    await notify('start', { force: true });
    await notify('mid');
    await notify('end', { force: true });
    expect(calls).toEqual(['start', 'end']);
  });

  test('dedupes consecutive identical messages', async () => {
    let now = 1000;
    const calls: string[] = [];
    const send = async (t: string) => {
      calls.push(t);
    };
    const notify = makeThrottledProgress(send, 0, () => now);

    await notify('a');
    await notify('a');
    await notify('a', { force: true });
    expect(calls).toEqual(['a']);
  });
});

const silentLog = pino({ level: 'silent' });

// `(key: string) => key` is structurally wider than Translator's keyof-Messages
// constraint, so a double-cast is the smallest type ceremony to use it as a
// stub here. The pipeline only forwards `t(...)` calls verbatim, so identity
// is enough.
const tStub = ((key: string) => key) as unknown as Translator;

interface NotifyCall {
  text: string;
  force: boolean;
}

function makeNotify() {
  const calls: NotifyCall[] = [];
  const notify = async (text: string, opts?: { force?: boolean }) => {
    calls.push({ text, force: opts?.force === true });
  };
  return { notify, calls };
}

describe('runRefreshPipeline', () => {
  test('on success: refresh.done emitted BEFORE postRun runs', async () => {
    const { notify, calls } = makeNotify();
    const events: string[] = [];
    // Tag the notify so we can sequence notify against run/postRun.
    const wrappedNotify = async (text: string, opts?: { force?: boolean }) => {
      events.push(`notify:${text}`);
      await notify(text, opts);
    };
    const run = async () => {
      events.push('run');
    };
    const postRun = async () => {
      events.push('postRun');
    };

    await runRefreshPipeline({ run, notify: wrappedNotify, t: tStub, log: silentLog, postRun });

    expect(events).toEqual(['run', 'notify:refresh.done', 'postRun']);
    expect(calls).toEqual([{ text: 'refresh.done', force: true }]);
  });

  test('on success without postRun: only refresh.done is emitted', async () => {
    const { notify, calls } = makeNotify();
    const run = async () => {};

    await runRefreshPipeline({ run, notify, t: tStub, log: silentLog });

    expect(calls).toEqual([{ text: 'refresh.done', force: true }]);
  });

  test('postRun throws: error is logged, pipeline still resolves, no refresh.failed', async () => {
    const { notify, calls } = makeNotify();
    const errors: unknown[] = [];
    const log = {
      error: (obj: unknown) => errors.push(obj),
      info: () => {},
      warn: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    } as unknown as typeof silentLog;
    const run = async () => {};
    const postRun = async () => {
      throw new Error('boom');
    };

    await expect(
      runRefreshPipeline({ run, notify, t: tStub, log, postRun }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([{ text: 'refresh.done', force: true }]);
    expect(errors).toHaveLength(1);
  });

  test('run rejects: emits refresh.failed and never calls postRun', async () => {
    const { notify, calls } = makeNotify();
    let postRunCalled = false;
    const run = async () => {
      throw new Error('scrape died');
    };
    const postRun = async () => {
      postRunCalled = true;
    };

    await runRefreshPipeline({ run, notify, t: tStub, log: silentLog, postRun });

    expect(postRunCalled).toBe(false);
    expect(calls).toEqual([{ text: 'refresh.failed', force: true }]);
  });
});

function dbWithPubs() {
  const db = openDb(':memory:');
  migrate(db);
  upsertPub(db, { slug: 'bracka', name: 'Bracka 4', address: 'Bracka 4', lat: null, lon: null, city: 'warszawa' });
  upsertPub(db, { slug: 'piwpaw', name: 'PiwPaw', address: 'Foksal 16', lat: null, lon: null, city: 'warszawa' });
  upsertPub(db, { slug: 'piwpaw-bis', name: 'PiwPaw Bis', address: 'Żurawia 32', lat: null, lon: null, city: 'warszawa' });
  return db;
}

describe('resolveRefreshScope', () => {
  test('empty argument → all', () => {
    const db = dbWithPubs();
    expect(resolveRefreshScope(db, '')).toEqual({ kind: 'all' });
    expect(resolveRefreshScope(db, '   ')).toEqual({ kind: 'all' });
  });

  test('argument matching exactly one pub → scoped with that slug', () => {
    const db = dbWithPubs();
    const scope = resolveRefreshScope(db, 'bracka');
    expect(scope).toEqual({ kind: 'scoped', slugs: new Set(['bracka']), query: 'bracka' });
  });

  test('argument matching several pubs → scoped with all their slugs', () => {
    const db = dbWithPubs();
    const scope = resolveRefreshScope(db, 'piwpaw');
    expect(scope.kind).toBe('scoped');
    if (scope.kind !== 'scoped') throw new Error('expected scoped');
    expect(scope.slugs).toEqual(new Set(['piwpaw', 'piwpaw-bis']));
  });

  test('argument matching nothing → pub_not_found', () => {
    const db = dbWithPubs();
    expect(resolveRefreshScope(db, 'nonexistent')).toEqual({
      kind: 'pub_not_found',
      query: 'nonexistent',
    });
  });
});

describe('cooldownWindowFor', () => {
  test('full refresh → 5 minutes', () => {
    expect(cooldownWindowFor('all')).toBe(5 * 60 * 1000);
  });
  test('scoped refresh → 30 seconds', () => {
    expect(cooldownWindowFor('scoped')).toBe(30 * 1000);
  });
});

describe('checkAndStampCooldown', () => {
  test('first call allowed and stamps the map', () => {
    const map = new Map<number, number>();
    expect(checkAndStampCooldown(map, 42, 1000, 5000)).toBe(true);
    expect(map.get(42)).toBe(5000);
  });

  test('second call within the window is blocked', () => {
    const map = new Map<number, number>();
    checkAndStampCooldown(map, 42, 1000, 5000);
    expect(checkAndStampCooldown(map, 42, 1000, 5500)).toBe(false);
  });

  test('call after the window is allowed again', () => {
    const map = new Map<number, number>();
    checkAndStampCooldown(map, 42, 1000, 5000);
    expect(checkAndStampCooldown(map, 42, 1000, 6001)).toBe(true);
  });

  test('separate maps do not interfere', () => {
    const full = new Map<number, number>();
    const scoped = new Map<number, number>();
    checkAndStampCooldown(full, 42, 300000, 1000);
    // full is now in cooldown, but the scoped map is untouched
    expect(checkAndStampCooldown(scoped, 42, 30000, 1000)).toBe(true);
  });
});
