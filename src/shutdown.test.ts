import { vi } from 'vitest';
import { createShutdown } from './shutdown';

describe('createShutdown', () => {
  function makeMocks() {
    const calls: string[] = [];
    const bot = { stop: vi.fn((sig: string) => calls.push(`bot.stop:${sig}`)) };
    const cronJobs = [
      { stop: vi.fn(() => calls.push('cron0.stop')) },
      { stop: vi.fn(() => calls.push('cron1.stop')) },
    ];
    const db = { close: vi.fn(() => calls.push('db.close')) };
    const log = { info: vi.fn(), error: vi.fn() };
    return { bot, cronJobs, db, log, calls };
  }

  test('stops crons, then bot, then closes db', async () => {
    const { bot, cronJobs, db, log, calls } = makeMocks();
    const shutdown = createShutdown({ bot: bot as any, cronJobs: cronJobs as any, db: db as any, log: log as any });

    await shutdown('SIGTERM');

    expect(calls).toEqual(['cron0.stop', 'cron1.stop', 'bot.stop:SIGTERM', 'db.close']);
  });

  test('passes signal through to bot.stop', async () => {
    const { bot, cronJobs, db, log } = makeMocks();
    const shutdown = createShutdown({ bot: bot as any, cronJobs: cronJobs as any, db: db as any, log: log as any });

    await shutdown('SIGINT');

    expect(bot.stop).toHaveBeenCalledWith('SIGINT');
  });

  test('closes db even if bot.stop throws', async () => {
    const { cronJobs, db, log } = makeMocks();
    const bot = { stop: vi.fn(() => { throw new Error('boom'); }) };
    const shutdown = createShutdown({ bot: bot as any, cronJobs: cronJobs as any, db: db as any, log: log as any });

    await shutdown('SIGTERM');

    expect(db.close).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  test('is idempotent — second call is a no-op', async () => {
    const { bot, cronJobs, db, log } = makeMocks();
    const shutdown = createShutdown({ bot: bot as any, cronJobs: cronJobs as any, db: db as any, log: log as any });

    await shutdown('SIGTERM');
    await shutdown('SIGTERM');

    expect(bot.stop).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(cronJobs[0].stop).toHaveBeenCalledTimes(1);
  });

  test('closes the http server between bot stop and db close', async () => {
    const order: string[] = [];
    const bot = { stop: vi.fn(() => order.push('bot')) };
    const db = { close: vi.fn(() => order.push('db')) };
    const httpServer = {
      close: vi.fn((cb?: (err?: Error) => void) => { order.push('http'); cb?.(); }),
    };
    const log = { info: vi.fn(), error: vi.fn() } as any;
    const shutdown = createShutdown({ bot: bot as any, cronJobs: [], db: db as any, httpServer: httpServer as any, log });
    await shutdown('SIGTERM');
    expect(order).toEqual(['bot', 'http', 'db']);
  });

  test('works when no http server is provided', async () => {
    const bot = { stop: vi.fn() };
    const db = { close: vi.fn() };
    const log = { info: vi.fn(), error: vi.fn() } as any;
    const shutdown = createShutdown({ bot: bot as any, cronJobs: [], db: db as any, log });
    await expect(shutdown('SIGINT')).resolves.toBeUndefined();
    expect(db.close).toHaveBeenCalled();
  });

  test('logs and continues when http server close errors', async () => {
    const order: string[] = [];
    const bot = { stop: vi.fn(() => order.push('bot')) };
    const db = { close: vi.fn(() => order.push('db')) };
    const httpServer = { close: vi.fn((cb?: (err?: Error) => void) => cb?.(new Error('boom'))) };
    const log = { info: vi.fn(), error: vi.fn() } as any;
    const shutdown = createShutdown({ bot: bot as any, cronJobs: [], db: db as any, httpServer: httpServer as any, log });
    await shutdown('SIGTERM');
    expect(log.error).toHaveBeenCalled();
    expect(db.close).toHaveBeenCalled();
    expect(order).toEqual(['bot', 'db']); // http pushed nothing (it errored), db still ran
  });
});
