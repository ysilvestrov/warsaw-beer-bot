import { sendRouteResult } from './route-send';

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
