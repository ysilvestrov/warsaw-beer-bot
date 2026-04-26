import 'dotenv/config';
import cron from 'node-cron';
import pino from 'pino';
import { loadEnv } from './config/env';
import { openDb } from './storage/db';
import { migrate } from './storage/schema';
import { createHttp } from './sources/http';
import { createGeocoder } from './sources/geocoder';
import { createBot } from './bot';
import { startCommand } from './bot/commands/start';
import { linkCommand } from './bot/commands/link';
import { importCommand } from './bot/commands/import';
import { newbeersCommand } from './bot/commands/newbeers';
import { routeCommand } from './bot/commands/route';
import { filtersCommand } from './bot/commands/filters';
import { createRefreshCommand } from './bot/commands/refresh';
import { refreshOntap } from './jobs/refresh-ontap';
import { refreshAllUntappd } from './jobs/refresh-untappd';
import { createShutdown } from './shutdown';

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const log = pino({ level: env.LOG_LEVEL });
  const db = openDb(env.DATABASE_PATH);
  migrate(db);

  const http = createHttp({ userAgent: env.NOMINATIM_USER_AGENT });
  const geocoder = createGeocoder({ userAgent: env.NOMINATIM_USER_AGENT });

  const bot = createBot({ db, env, log });
  bot.use(
    startCommand,
    linkCommand,
    importCommand,
    newbeersCommand,
    routeCommand,
    filtersCommand,
    createRefreshCommand(async (notify) => {
      await refreshOntap({ db, log, http, geocoder, onProgress: notify });
      await refreshAllUntappd({ db, log, http, onProgress: notify });
    }),
  );

  const cronJobs = [
    cron.schedule('0 */12 * * *', () => {
      refreshOntap({ db, log, http, geocoder }).catch((e) => log.error({ err: e }, 'ontap cron'));
    }),
    cron.schedule('0 3 * * *', () => {
      refreshAllUntappd({ db, log, http }).catch((e) => log.error({ err: e }, 'untappd cron'));
    }),
  ];

  bot.launch();
  log.info('bot launched');

  // Without an explicit exit, node-cron schedules and the SQLite handle keep
  // the event loop alive — systemd then SIGKILLs us at TimeoutStopSec (90s
  // default), which risks a non-clean SQLite WAL flush.
  const shutdown = createShutdown({ bot, cronJobs, db, log });
  const onSignal = (signal: string) => {
    shutdown(signal).finally(() => process.exit(0));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
