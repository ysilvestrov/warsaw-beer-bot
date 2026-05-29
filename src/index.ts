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
import { buildNewbeersMessage } from './bot/commands/newbeers-build';
import { pubsCommand } from './bot/commands/pubs';
import { routeCommand } from './bot/commands/route';
import { filtersCommand } from './bot/commands/filters';
import { langCommand } from './bot/commands/lang';
import { createRefreshCommand } from './bot/commands/refresh';
import { refreshOntap } from './jobs/refresh-ontap';
import { refreshAllUntappd } from './jobs/refresh-untappd';
import { dedupeBreweryAliases } from './jobs/dedupe-brewery-aliases';
import { cleanupPollutedOntap } from './jobs/cleanup-polluted-ontap';
import { enrichOrphans } from './jobs/enrich-orphans';
import { refreshTapRatings } from './jobs/refresh-tap-ratings';
import { createShutdown } from './shutdown';

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const log = pino({ level: env.LOG_LEVEL });
  const db = openDb(env.DATABASE_PATH);
  migrate(db);
  dedupeBreweryAliases(db, log);
  cleanupPollutedOntap(db, log);

  const http = createHttp({ userAgent: env.NOMINATIM_USER_AGENT });
  const geocoder = createGeocoder({ userAgent: env.NOMINATIM_USER_AGENT });

  const bot = createBot({ db, env, log });
  bot.use(
    startCommand,
    linkCommand,
    importCommand,
    newbeersCommand,
    pubsCommand,
    routeCommand,
    filtersCommand,
    langCommand,
    createRefreshCommand(
      async (notify) => {
        await refreshOntap({
          db, log, http, geocoder, onProgress: notify,
          lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
        });
        await refreshAllUntappd({ db, log, http, onProgress: notify });
      },
      buildNewbeersMessage,
    ),
  );

  const cronJobs = [
    cron.schedule('0 */12 * * *', () => {
      refreshOntap({
        db, log, http, geocoder,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
      }).catch((e) => log.error({ err: e }, 'ontap cron'));
    }),
    cron.schedule('0 3 * * *', () => {
      refreshAllUntappd({ db, log, http }).catch((e) => log.error({ err: e }, 'untappd cron'));
    }),
    // enrich-orphans runs every 3h at xx:30 (offset to avoid the busy
    // on-the-hour slot used by refreshOntap and refreshAllUntappd).
    // 8 runs/day × LIMIT 20 = 160 lookups/day; 287-orphan backlog drains
    // in ~1.8 days. Burst signature unchanged (20 calls × 500ms = ~10s).
    // Bumped from '0 6,18 * * *' (12h) in PR-D-throughput-bump 2026-05-29.
    cron.schedule('30 */3 * * *', () => {
      enrichOrphans({
        db, log, http,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
      }).catch((e) => log.error({ err: e }, 'enrich-orphans cron'));
    }),
    // refresh-tap-ratings runs every 3h at xx:30 too, but on hours
    // 1/4/7/10/13/16/19/22 — offset 1h from enrich-orphans so the two
    // jobs never burst Untappd simultaneously. 8 runs/day × LIMIT 20.
    // Bumped from '0 9,21 * * *' (12h) in PR-D-throughput-bump 2026-05-29.
    cron.schedule('30 1,4,7,10,13,16,19,22 * * *', () => {
      refreshTapRatings({
        db, log, http,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
      }).catch((e) => log.error({ err: e }, 'refresh-tap-ratings cron'));
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
