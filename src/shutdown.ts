import type { Telegraf } from 'telegraf';
import type { ScheduledTask } from 'node-cron';
import type pino from 'pino';
import type { DB } from './storage/db';

export interface ShutdownDeps {
  bot: Pick<Telegraf<never>, 'stop'>;
  cronJobs: Pick<ScheduledTask, 'stop'>[];
  db: Pick<DB, 'close'>;
  log: pino.Logger;
}

export type Shutdown = (signal: string) => Promise<void>;

export function createShutdown(deps: ShutdownDeps): Shutdown {
  let started = false;
  return async function shutdown(signal: string): Promise<void> {
    if (started) return;
    started = true;
    deps.log.info({ signal }, 'shutdown initiated');

    for (const job of deps.cronJobs) {
      try { job.stop(); } catch (err) { deps.log.error({ err }, 'cron stop failed'); }
    }

    try { deps.bot.stop(signal); } catch (err) { deps.log.error({ err }, 'bot stop failed'); }

    try { deps.db.close(); } catch (err) { deps.log.error({ err }, 'db close failed'); }

    deps.log.info('shutdown done');
  };
}
