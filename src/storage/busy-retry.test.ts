import { isBusyError, withBusyRetry } from './busy-retry';

function sqliteBusy(): Error {
  const e = new Error('database is locked') as Error & { code: string };
  e.code = 'SQLITE_BUSY';
  return e;
}

const noSleep = async () => {};

describe('isBusyError', () => {
  test('true for SQLITE_BUSY', () => {
    expect(isBusyError(sqliteBusy())).toBe(true);
  });
  test('false for other errors / non-errors', () => {
    expect(isBusyError(new Error('nope'))).toBe(false);
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError('SQLITE_BUSY')).toBe(false);
  });
});

describe('withBusyRetry', () => {
  test('returns the result without retrying when fn succeeds', async () => {
    let calls = 0;
    const out = await withBusyRetry(() => { calls++; return 42; }, { sleep: noSleep });
    expect(out).toBe(42);
    expect(calls).toBe(1);
  });

  test('retries on SQLITE_BUSY and returns once it succeeds', async () => {
    let calls = 0;
    const out = await withBusyRetry(() => {
      calls++;
      if (calls < 3) throw sqliteBusy();
      return 'ok';
    }, { attempts: 5, sleep: noSleep });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  test('rethrows a non-BUSY error immediately without retrying', async () => {
    let calls = 0;
    await expect(withBusyRetry(() => { calls++; throw new Error('boom'); }, { sleep: noSleep }))
      .rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  test('gives up after exhausting attempts on persistent BUSY', async () => {
    let calls = 0;
    await expect(withBusyRetry(() => { calls++; throw sqliteBusy(); }, { attempts: 4, sleep: noSleep }))
      .rejects.toThrow('database is locked');
    expect(calls).toBe(4);
  });

  test('backs off with increasing delays between attempts', async () => {
    const delays: number[] = [];
    let calls = 0;
    await withBusyRetry(() => {
      calls++;
      if (calls < 4) throw sqliteBusy();
      return 0;
    }, { attempts: 5, baseDelayMs: 10, sleep: async (ms) => { delays.push(ms); } });
    expect(delays).toEqual([10, 20, 40]);
  });
});
