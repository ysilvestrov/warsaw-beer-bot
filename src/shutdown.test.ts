import { createShutdown } from './shutdown';

describe('createShutdown', () => {
  function makeMocks() {
    const calls: string[] = [];
    const bot = { stop: jest.fn((sig: string) => calls.push(`bot.stop:${sig}`)) };
    const cronJobs = [
      { stop: jest.fn(() => calls.push('cron0.stop')) },
      { stop: jest.fn(() => calls.push('cron1.stop')) },
    ];
    const db = { close: jest.fn(() => calls.push('db.close')) };
    const log = { info: jest.fn(), error: jest.fn() };
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
    const bot = { stop: jest.fn(() => { throw new Error('boom'); }) };
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
});
