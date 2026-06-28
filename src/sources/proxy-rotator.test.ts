import { createRotatingDispatcher } from './proxy-rotator';

type FakeAgent = { url: string; closed: boolean; close: () => Promise<void> };

function fakeFactory() {
  const created: FakeAgent[] = [];
  const factory = (url: string) => {
    const a: FakeAgent = { url, closed: false, close: async () => { a.closed = true; } };
    created.push(a);
    return a as unknown as import('undici').Dispatcher;
  };
  return { factory, created };
}

test('per-request: current() returns a new agent each call and closes the previous', () => {
  const { factory, created } = fakeFactory();
  const rd = createRotatingDispatcher({ proxyUrl: 'u:p@h:80', mode: 'per-request', agentFactory: factory });
  const a1 = rd.current();
  const a2 = rd.current();
  expect(a1).not.toBe(a2);
  expect(created.length).toBe(2);
  expect(created[0].closed).toBe(true);
});

test('on-block: current() returns the same agent until rotate()', () => {
  const { factory, created } = fakeFactory();
  const rd = createRotatingDispatcher({ proxyUrl: 'u:p@h:80', mode: 'on-block', agentFactory: factory });
  expect(rd.current()).toBe(rd.current());
  expect(created.length).toBe(1);
  rd.rotate('block-status');
  rd.current();
  expect(created.length).toBe(2);
  expect(created[0].closed).toBe(true);
  expect(rd.rotations()).toBe(1);
});

test('rotate() increments rotations() and reports the reason via onRotate', () => {
  const { factory } = fakeFactory();
  const reasons: string[] = [];
  const rd = createRotatingDispatcher({
    proxyUrl: 'u:p@h:80', mode: 'on-block', agentFactory: factory,
    onRotate: (r) => reasons.push(r),
  });
  rd.current();
  rd.rotate('block-page');
  rd.rotate('block-status');
  expect(rd.rotations()).toBe(2);
  expect(reasons).toEqual(['block-page', 'block-status']);
});

test('close() closes the current agent', () => {
  const { factory, created } = fakeFactory();
  const rd = createRotatingDispatcher({ proxyUrl: 'u:p@h:80', mode: 'on-block', agentFactory: factory });
  rd.current();
  rd.close();
  expect(created[0].closed).toBe(true);
});

test('normalizes a scheme-less proxy url before building an agent', () => {
  const seen: string[] = [];
  const rd = createRotatingDispatcher({
    proxyUrl: 'u:p@h:80', mode: 'on-block',
    agentFactory: (url) => { seen.push(url); return {} as unknown as import('undici').Dispatcher; },
  });
  rd.current();
  expect(seen[0]).toBe('http://u:p@h:80');
});
