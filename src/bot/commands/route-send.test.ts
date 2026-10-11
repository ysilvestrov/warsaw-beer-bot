import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { notifyRouteFailed, runRouteWork, sendRouteResult } from './route-send';

const KB = { inline_keyboard: [[{ text: 'Maps', url: 'https://maps.example/x' }]] };

function io(failOn?: string) {
  const calls: { via: 'edit' | 'send'; text: string; keyboard: unknown }[] = [];
  const act = (via: 'edit' | 'send') => async (text: string, keyboard?: unknown) => {
    calls.push({ via, text, keyboard: keyboard ?? null });
    return failOn === text ? Promise.reject(new Error('400: Bad Request')) : undefined;
  };
  return { calls, io: { edit: act('edit'), send: act('send') } };
}

test('one message: it replaces the status message and carries the keyboard', async () => {
  const s = io();
  await sendRouteResult(['only'], { ...s.io, keyboard: KB });
  expect(s.calls).toEqual([{ via: 'edit', text: 'only', keyboard: KB }]);
});

test('three messages: the first is an edit, the rest are sent in order, the keyboard is under the last', async () => {
  const s = io();
  await sendRouteResult(['a', 'b', 'c'], { ...s.io, keyboard: KB });
  expect(s.calls).toEqual([
    { via: 'edit', text: 'a', keyboard: null },
    { via: 'send', text: 'b', keyboard: null },
    { via: 'send', text: 'c', keyboard: KB },
  ]);
});

test('without a keyboard nothing carries one', async () => {
  const s = io();
  await sendRouteResult(['a', 'b'], s.io);
  expect(s.calls).toEqual([
    { via: 'edit', text: 'a', keyboard: null },
    { via: 'send', text: 'b', keyboard: null },
  ]);
});

test('a failing first message rejects and sends nothing after it', async () => {
  const s = io('a');
  await expect(sendRouteResult(['a', 'b'], { ...s.io, keyboard: KB })).rejects.toThrow('400: Bad Request');
  expect(s.calls).toEqual([{ via: 'edit', text: 'a', keyboard: null }]);
});

test('a failing second message rejects and sends nothing after it', async () => {
  const s = io('b');
  await expect(sendRouteResult(['a', 'b', 'c'], { ...s.io, keyboard: KB })).rejects.toThrow('400: Bad Request');
  expect(s.calls).toEqual([
    { via: 'edit', text: 'a', keyboard: null },
    { via: 'send', text: 'b', keyboard: null },
  ]);
});

test('no messages sends nothing', async () => {
  const s = io();
  await sendRouteResult([], { ...s.io, keyboard: KB });
  expect(s.calls).toEqual([]);
});

describe('runRouteWork', () => {
  function setup() {
    const db = openDb(':memory:');
    migrate(db);
    const logged: { level: string; msg: string }[] = [];
    const log = {
      error: (_o: unknown, msg: string) => { logged.push({ level: 'error', msg }); },
      warn: (_o: unknown, msg: string) => { logged.push({ level: 'warn', msg }); },
    };
    let notified = 0;
    const notifyFailed = async () => { notified += 1; };
    const rows = () => db.prepare('SELECT source, error FROM handler_failures').all();
    return { db, log: log as never, logged, notifyFailed, notified: () => notified, rows };
  }
  const tooLong = () => new Error('400: Bad Request: message is too long');

  test('work resolves: nothing recorded, nobody told, nothing logged', async () => {
    const s = setup();
    await runRouteWork({ db: s.db, log: s.log }, async () => {}, s.notifyFailed);
    expect(s.rows()).toEqual([]);
    expect(s.notified()).toBe(0);
    expect(s.logged).toEqual([]);
  });

  test('work rejects: logged, recorded as /route and the person is told once', async () => {
    const s = setup();
    await runRouteWork({ db: s.db, log: s.log }, async () => { throw tooLong(); }, s.notifyFailed);
    expect(s.rows()).toEqual([{ source: '/route', error: '400: Bad Request: message is too long' }]);
    expect(s.notified()).toBe(1);
    expect(s.logged).toEqual([{ level: 'error', msg: 'route failed' }]);
  });

  test('work rejects and the notice rejects too: still resolves, one row, both logged', async () => {
    const s = setup();
    await expect(
      runRouteWork(
        { db: s.db, log: s.log },
        async () => { throw tooLong(); },
        async () => { throw new Error('403: blocked'); },
      ),
    ).resolves.toBeUndefined();
    expect(s.rows()).toEqual([{ source: '/route', error: '400: Bad Request: message is too long' }]);
    expect(s.logged).toEqual([
      { level: 'error', msg: 'route failed' },
      { level: 'warn', msg: 'route failure notice not sent' },
    ]);
  });

  test('a rejected delivery of the result reaches the record and the notice', async () => {
    const s = setup();
    const io = {
      edit: async () => undefined,
      send: async () => { throw tooLong(); },
    };
    await runRouteWork({ db: s.db, log: s.log }, () => sendRouteResult(['a', 'b'], io), s.notifyFailed);
    expect(s.rows()).toEqual([{ source: '/route', error: '400: Bad Request: message is too long' }]);
    expect(s.notified()).toBe(1);
  });
});

function noticeIo(editRejects: boolean, sendRejects = false) {
  const calls: string[] = [];
  return {
    calls,
    io: {
      edit: async () => { calls.push('edit'); return editRejects ? Promise.reject(new Error('400: message to edit not found')) : undefined; },
      send: async () => { calls.push('send'); return sendRejects ? Promise.reject(new Error('403: bot was blocked by the user')) : undefined; },
    },
  };
}

test('failure notice: while the status message is still progress, it is edited and nothing is sent', async () => {
  const s = noticeIo(false);
  await notifyRouteFailed(s.io, false);
  expect(s.calls).toEqual(['edit']);
});

test('failure notice: a refused edit falls back to a new message', async () => {
  const s = noticeIo(true);
  await notifyRouteFailed(s.io, false);
  expect(s.calls).toEqual(['edit', 'send']);
});

test('failure notice: once the first part is delivered it is never overwritten — a new message only', async () => {
  const s = noticeIo(false);
  await notifyRouteFailed(s.io, true);
  expect(s.calls).toEqual(['send']);
});

test('failure notice: when the new message is refused too, the rejection reaches the caller', async () => {
  const s = noticeIo(true, true);
  await expect(notifyRouteFailed(s.io, false)).rejects.toThrow('403: bot was blocked by the user');
  expect(s.calls).toEqual(['edit', 'send']);
});
