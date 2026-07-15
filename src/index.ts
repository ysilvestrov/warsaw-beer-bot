import 'dotenv/config';
import cron from 'node-cron';
import pino from 'pino';
import { loadEnv, missingExpectedKeys } from './config/env';
import { openDb } from './storage/db';
import { migrate } from './storage/schema';
import { createHttp } from './sources/http';
import { createRotatingDispatcher } from './sources/proxy-rotator';
import { isBlockStatus, isBlockPage } from './sources/untappd/block';
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
import { cityCommand } from './bot/commands/city';
import { extensionCommand } from './bot/commands/extension';
import { extensionReleaseCommand } from './bot/commands/extension-release';
import { helpCommand } from './bot/commands/help';
import { statusCommand } from './bot/commands/status';
import { createApiApp, createApiServer } from './api';
import { registerCommandMenu } from './bot/register-command-menu';
import { createRefreshCommand } from './bot/commands/refresh';
import { refreshOntap } from './jobs/refresh-ontap';
import { refreshAllUntappd } from './jobs/refresh-untappd';
import { dedupeBreweryAliases } from './jobs/dedupe-brewery-aliases';
import { backfillNormalizedBrewery } from './jobs/backfill-normalized-brewery';
import { backfillCheckinAt } from './jobs/backfill-checkin-at';
import { cleanupPollutedOntap } from './jobs/cleanup-polluted-ontap';
import { enrichOrphans } from './jobs/enrich-orphans';
import { refreshTapRatings } from './jobs/refresh-tap-ratings';
import { cleanupOldSnapshots } from './jobs/cleanup-old-snapshots';
import { dailyStatus } from './jobs/daily-status';
import { orphanTriage } from './jobs/orphan-triage';
import { createTriageLlm } from './infra/triage-llm';
import { createTriageArchive } from './infra/triage-archive';
import { createGithubIssuesClient } from './infra/github-issues';
import { createPersistentCircuitBreaker } from './domain/untappd-circuit';
import { ALGOLIA_DEFAULTS, createAlgoliaSearch, extractAlgoliaKeys } from './sources/untappd/algolia';
import { buildSearchUrl } from './sources/untappd/search';
import { createShutdown } from './shutdown';
import { interruptActiveProgress } from './bot/active-progress';
import { createTranslator } from './i18n';

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const log = pino({ level: env.LOG_LEVEL });
  for (const { key, disables } of missingExpectedKeys(env)) {
    log.warn({ key }, `env ${key} unset — ${disables} disabled`);
  }
  const db = openDb(env.DATABASE_PATH);
  migrate(db);
  backfillNormalizedBrewery(db, log);
  backfillCheckinAt(db, log);
  dedupeBreweryAliases(db, log);
  await cleanupPollutedOntap(db, log);
  cleanupOldSnapshots(db, log, env.SNAPSHOT_RETENTION_DAYS);

  const http = createHttp({ userAgent: env.NOMINATIM_USER_AGENT });

  const untappdBlock = (status: number, body: string | null) =>
    isBlockStatus(status) || (body !== null && isBlockPage(body));

  // Untappd search/lookup goes through the Webshare proxy (when configured) on a
  // dedicated, cookie-less client; shop scraping keeps the direct `http`.
  // Cookieless search/lookup client: rotate the WebShare exit IP on EVERY
  // request (HTTPS CONNECT tunnels pin one IP per tunnel, so a fresh agent per
  // request is the only way to actually rotate). See #222.
  const untappdSearchHttp = createHttp({
    userAgent: env.NOMINATIM_USER_AGENT,
    rotator: env.WEBSHARE_PROXY
      ? createRotatingDispatcher({
          proxyUrl: env.WEBSHARE_PROXY,
          mode: 'per-request',
          onRotate: (reason) => log.warn({ reason, client: 'untappd-search' }, 'untappd proxy rotate-on-block'),
        })
      : undefined,
    isBlock: untappdBlock,
    maxBlockRetries: env.UNTAPPD_BLOCK_RETRIES,
  });
  const algoliaSearch = createAlgoliaSearch({
    appId: env.UNTAPPD_ALGOLIA_APP_ID ?? ALGOLIA_DEFAULTS.appId,
    searchKey: env.UNTAPPD_ALGOLIA_SEARCH_KEY ?? ALGOLIA_DEFAULTS.searchKey,
    proxyUrl: env.WEBSHARE_PROXY,
    refreshKeys: async () => {
      // Pull fresh keys from the live search page via the cookie-less proxied client.
      const html = await untappdSearchHttp.get(buildSearchUrl('beer'));
      return extractAlgoliaKeys(html);
    },
  });
  const geocoder = createGeocoder({ userAgent: env.NOMINATIM_USER_AGENT });

  const untappdHttp = env.UNTAPPD_SESSION_COOKIE
    ? createHttp({
        userAgent: env.NOMINATIM_USER_AGENT,
        cookie: env.UNTAPPD_SESSION_COOKIE,
        redirect: 'manual',
        // Cookie'd session: keep one exit IP (rapid country-hopping of a
        // logged-in session looks like account takeover) and only rotate when
        // actually blocked. See #222.
        rotator: env.WEBSHARE_PROXY
          ? createRotatingDispatcher({
              proxyUrl: env.WEBSHARE_PROXY,
              mode: 'on-block',
              onRotate: (reason) => log.warn({ reason, client: 'untappd-profile' }, 'untappd proxy rotate-on-block'),
            })
          : undefined,
        isBlock: untappdBlock,
        maxBlockRetries: env.UNTAPPD_BLOCK_RETRIES,
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

  // Orphan-triage clients. Either may be null (missing key) — the job then
  // records a "disabled" result once per day instead of crashing.
  const triageLlm = createTriageLlm(env);
  const triageArchive = createTriageArchive({ dir: env.TRIAGE_LOG_DIR ?? '' }, log);
  const triageGithub = env.GITHUB_TOKEN
    ? createGithubIssuesClient({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO })
    : null;
  if (!triageLlm) log.warn('orphan-triage LLM disabled (missing provider API key)');
  if (!triageGithub) log.warn('orphan-triage GitHub disabled (GITHUB_TOKEN not set)');

  const adminAlert = (msg: string) => { notifyAdmin?.(msg)?.catch(() => {}); };
  // Two independent Untappd breakers. The Algolia search path (enrich /
  // ontap refresh) and the HTML-scrape path (profile had-list + tap ratings)
  // fail for different reasons (see #298) and must not gate each other.
  // blockThreshold counts CONSECUTIVE blocks WITHIN each path; a healthy
  // success in that path resets its count.
  // The Algolia breaker keeps the legacy key 'untappd_circuit_open_until' so
  // stats.untappdSearchHealthy (which reads that key) stays correct and the
  // live open_until state survives deploys.
  const algoliaBreaker = createPersistentCircuitBreaker({
    db,
    key: 'untappd_circuit_open_until',
    cooldownMs: 6 * 60 * 60 * 1000,
    blockThreshold: env.UNTAPPD_BLOCK_THRESHOLD,
    onTrip: () => adminAlert('⚠️ Untappd Algolia: можливий бан IP (403/429 або captcha). Енрич призупинено на ~6 год.'),
    onRecover: () => adminAlert('✅ Untappd Algolia: доступ відновлено, енрич продовжено.'),
  });
  const profileHttpBreaker = createPersistentCircuitBreaker({
    db,
    key: 'untappd_profile_http_open_until',
    cooldownMs: 6 * 60 * 60 * 1000,
    blockThreshold: env.UNTAPPD_BLOCK_THRESHOLD,
    onTrip: () => adminAlert('⚠️ Untappd профіль-скрейп: 403/блок — скрейп профілів/рейтингів призупинено на ~6 год.'),
    onRecover: () => adminAlert('✅ Untappd профіль-скрейп: доступ відновлено.'),
  });

  bot.use(
    startCommand,
    linkCommand,
    // Must precede importCommand: import's on('document') consumes every
    // document (and .zip is a valid import format). The release handler falls
    // through (next) for anything that isn't an admin release-zip upload.
    extensionReleaseCommand,
    importCommand,
    newbeersCommand,
    beersCommand,
    pubsCommand,
    routeCommand,
    filtersCommand,
    langCommand,
    cityCommand,
    extensionCommand,
    statusCommand,
    helpCommand,
    createRefreshCommand(
      async (notify, opts) => {
        await refreshOntap({
          db, log, http, geocoder, onProgress: notify,
          lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
          pubSlugs: opts?.pubSlugs,
          breaker: algoliaBreaker,
          search: algoliaSearch,
        });
        // Scoped refresh (a specific pub) is ontap-only: the Untappd had-list
        // is not pub-specific and is refreshed daily + on a full /refresh.
        if (!opts?.pubSlugs && untappdHttp) {
          await refreshAllUntappd({
            db, log, http: untappdHttp, onProgress: notify, notifyAdmin,
            breaker: profileHttpBreaker,
          });
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
        breaker: algoliaBreaker,
        search: algoliaSearch,
      }).catch((e) => log.error({ err: e }, 'ontap cron'));
    }),
    // enrich-orphans runs every 3h at xx:30 (offset to avoid the busy
    // on-the-hour slot used by refreshOntap and refreshAllUntappd).
    // 8 runs/day × LIMIT 20 = 160 lookups/day; 287-orphan backlog drains
    // in ~1.8 days. Burst signature unchanged (20 calls × 500ms = ~10s).
    // Bumped from '0 6,18 * * *' (12h) in PR-D-throughput-bump 2026-05-29.
    cron.schedule('30 */3 * * *', () => {
      enrichOrphans({
        db, log, search: algoliaSearch,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
        breaker: algoliaBreaker,
        notifyAdmin,
      }).catch((e) => log.error({ err: e }, 'enrich-orphans cron'));
    }),
    // refresh-tap-ratings runs every 3h at xx:30 too, but on hours
    // 1/4/7/10/13/16/19/22 — offset 1h from enrich-orphans so the two
    // jobs never burst Untappd simultaneously. 8 runs/day × LIMIT 20.
    // Bumped from '0 9,21 * * *' (12h) in PR-D-throughput-bump 2026-05-29.
    cron.schedule('30 1,4,7,10,13,16,19,22 * * *', () => {
      refreshTapRatings({
        db, log, http: untappdSearchHttp,
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
        breaker: profileHttpBreaker,
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
    // daily-status: admin health digest, ~09:00 Warsaw. We run a plain UTC tick
    // every 15 min instead of a node-cron timezone schedule — node-cron's
    // timezone tick proved flaky (silently skipped 2026-06-21) while UTC ticks
    // are reliable. dailyStatus itself checks the Warsaw [09:00,12:00) window and
    // an idempotency date in job_state, so it sends exactly once per Warsaw day
    // and catches up if the bot was down at 09:00. Self-noops when
    // ADMIN_TELEGRAM_ID is unset.
    cron.schedule('*/15 * * * *', () => {
      dailyStatus({ db, log, notifyAdmin })
        .catch((e) => log.error({ err: e }, 'daily-status cron'));
    }),
    // orphan-triage: daily LLM triage of enrich_failures, Warsaw [06:00,09:00)
    // window + job_state idempotency inside the job. Same UTC-tick pattern as
    // daily-status.
    cron.schedule('*/15 * * * *', () => {
      orphanTriage({ db, log, llm: triageLlm, github: triageGithub, archive: triageArchive })
        .catch((e) => log.error({ err: e }, 'orphan-triage cron'));
    }),
  ];

  if (untappdHttp) {
    cronJobs.push(cron.schedule('0 3 * * *', () => {
      refreshAllUntappd({
        db, log, http: untappdHttp, notifyAdmin,
        breaker: profileHttpBreaker,
      }).catch((e) => log.error({ err: e }, 'untappd cron'));
    }));
  }

  await registerCommandMenu(bot, log);

  bot.launch();
  log.info('bot launched');

  // Startup catch-up: if the bot was down/redeploying at 06:00 Warsaw but is up
  // within the triage window, run today's triage now instead of waiting for the
  // next 15-min tick. Idempotent via job_state, so a normal start is a no-op once
  // the day's triage already ran.
  orphanTriage({ db, log, llm: triageLlm, github: triageGithub, archive: triageArchive })
    .catch((e) => log.error({ err: e }, 'orphan-triage startup'));

  // Startup catch-up: if the bot was down/redeploying at 09:00 Warsaw but is up
  // within the morning window, emit today's digest now instead of waiting for the
  // next 15-min tick. Idempotent via job_state, so a normal start is a no-op once
  // the day's digest already went out.
  dailyStatus({ db, log, notifyAdmin })
    .catch((e) => log.error({ err: e }, 'daily-status startup'));

  const apiApp = createApiApp({ db, env, log });
  const apiServer = createApiServer(apiApp, env, log);

  // Without an explicit exit, node-cron schedules and the SQLite handle keep
  // the event loop alive — systemd then SIGKILLs us at TimeoutStopSec (90s
  // default), which risks a non-clean SQLite WAL flush.
  const shutdown = createShutdown({
    bot,
    cronJobs,
    db,
    httpServer: apiServer,
    log,
    interruptActiveProgress: () => interruptActiveProgress(bot.telegram, createTranslator),
  });
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
