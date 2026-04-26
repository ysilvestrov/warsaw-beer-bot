import { makeThrottledProgress } from './refresh';

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
