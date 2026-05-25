import pino from 'pino';
import { makeThrottledProgress, runRefreshPipeline } from './refresh';
import type { Translator } from '../../i18n/types';

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
