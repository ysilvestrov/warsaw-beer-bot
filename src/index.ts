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
import { beersCommand } from './bot/commands/beers';
import { pubsCommand } from './bot/commands/pubs';
import { routeCommand } from './bot/commands/route';
import { filtersCommand } from './bot/commands/filters';
import { langCommand } from './bot/commands/lang';
import { helpCommand } from './bot/commands/help';
import { registerCommandMenu } from './bot/register-command-menu';
import { createRefreshCommand } from './bot/commands/refresh';
import { refreshOntap } from './jobs/refresh-ontap';
import { refreshAllUntappd } from './jobs/refresh-untappd';
import { dedupeBreweryAliases } from './jobs/dedupe-brewery-aliases';
import { cleanupPollutedOntap } from './jobs/cleanup-polluted-ontap';
import { enrichOrphans } from './jobs/enrich-orphans';
import { refreshTapRatings } from './jobs/refresh-tap-ratings';
import { cleanupOldSnapshots } from './jobs/cleanup-old-snapshots';
import { createShutdown } from './shutdown';

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const log = pino({ level: env.LOG_LEVEL });
  const db = openDb(env.DATABASE_PATH);
  migrate(db);
  dedupeBreweryAliases(db, log);
  cleanupPollutedOntap(db, log);
  cleanupOldSnapshots(db, log, env.SNAPSHOT_RETENTION_DAYS);

  const http = createHttp({ userAgent: env.NOMINATIM_USER_AGENT });
  const geocoder = createGeocoder({ userAgent: env.NOMINATIM_USER_AGENT });

  const untappdHttp = env.UNTAPPD_SESSION_COOKIE
    ? createHttp({
        userAgent: env.NOMINATIM_USER_AGENT,
        cookie: env.UNTAPPD_SESSION_COOKIE,
        redirect: 'manual',
      })
    : null;
  if (!untappdHttp) {
    log.warn('untappd profile scraper disabled (UNTAPPD_SESSION_COOKIE not set)');
  }

  const bot = createBot({ db, env, log });

  const notifyAdmin = env.ADMIN_TELEGRAM_ID
    ? (msg: string) =>
        bot.telegram.sendMessage(env.ADMIN_TELEGRAM_ID!, msg).then(() => {})
    : undefined;

  bot.use(
    startCommand,
    linkCommand,
    importCommand,
    newbeersCommand,
    beersCommand,
    pubsCommand,
    routeCommand,
    filtersCommand,
    langCommand,
    helpCommand,
    createRefreshCommand(
      async (notify, opts) => {
        await refreshOntap({
          db, log, http, geocoder, onProgress: notify,
          lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
          pubSlugs: opts?.pubSlugs,
        });
        // Scoped refresh (a specific pub) is ontap-only: the Untappd had-list
        // is not pub-specific and is refreshed daily + on a full /refresh.
        if (!opts?.pubSlugs && untappdHttp) {
          await refreshAllUntappd({ db, log, http: untappdHttp, onProgress: notify, notifyAdmin });
        }
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
    // cleanup-old-snapshots: daily at 05:00 Warsaw, a quiet slot away from the
    // on-the-hour scraper runs (00:00/12:00 ontap, 03:00 untappd). Bounds DB
    // growth; each pub always keeps its latest snapshot. Synchronous → try/catch.
    cron.schedule('0 5 * * *', () => {
      try {
        cleanupOldSnapshots(db, log, env.SNAPSHOT_RETENTION_DAYS);
      } catch (e) {
        log.error({ err: e }, 'cleanup-old-snapshots cron');
      }
    }),
  ];

  if (untappdHttp) {
    cronJobs.push(cron.schedule('0 3 * * *', () => {
      refreshAllUntappd({ db, log, http: untappdHttp, notifyAdmin })
        .catch((e) => log.error({ err: e }, 'untappd cron'));
    }));
  }

  await registerCommandMenu(bot, log);

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
