import { writeFileSync, readFileSync } from 'node:fs';
import pino from 'pino';
import { loadEnv } from '../src/config/env';
import { openDb } from '../src/storage/db';
import { loadOperatorEnv } from './operator-env';
import { probeIssueRows } from '../src/jobs/adjudicate-issue-rows';
import { parseVerdictFile, applyVerdicts } from '../src/jobs/adjudicate-apply';
import { lookupBeer } from '../src/domain/untappd-lookup';
import { CANARY_QUERY } from '../src/jobs/enrich-orphans';
import { ALGOLIA_DEFAULTS, createAlgoliaSearch } from '../src/sources/untappd/algolia';
import { createPersistentCircuitBreaker } from '../src/domain/untappd-circuit';

loadOperatorEnv();

const USAGE = 'usage: --issue <n> [--limit <n>] | --apply <file>';

function arg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i < 0 ? null : (argv[i + 1] ?? null);
}

async function main(argv: string[]): Promise<number> {
  const applyPath = arg(argv, '--apply');
  const issueRaw = arg(argv, '--issue');
  const limitRaw = arg(argv, '--limit');
  const log = pino({ level: 'info' });
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    if (applyPath) {
      const file = parseVerdictFile(JSON.parse(readFileSync(applyPath, 'utf8')));
      const report = applyVerdicts(db, file, new Date().toISOString());
      console.log(`marked ${report.marked}, already marked ${report.alreadyMarked}`);
      for (const s of report.skipped) console.log(`  skipped ${s.beer_id}: ${s.reason}`);
      return 0;
    }
    if (!issueRaw) { console.error(USAGE); return 2; }
    const issue = parseInt(issueRaw, 10);
    // #576: `--issue abc` must not silently become `NaN` in the row query below (which would
    // match zero rows and look like a clean, empty run instead of a rejected bad argument).
    if (!Number.isInteger(issue)) { console.error(USAGE); return 2; }
    const env = loadEnv();
    // Композиційний корінь (`src/index.ts:95`) додає сюди ще `refreshKeys`, який тягне свіжі
    // ключі зі сторінки пошуку. Тут він свідомо НЕ потрібен (#576): прогін короткий і ручний, а
    // протухлий ключ проявляється як провал канарки — тобто саме як «нічого не пишемо», що
    // й є безпечним наслідком. Тягнути сюди `untappdSearchHttp` заради цього означало б
    // копіювати половину композиційного кореня в ops-скрипт.
    const search = createAlgoliaSearch({
      appId: env.UNTAPPD_ALGOLIA_APP_ID ?? ALGOLIA_DEFAULTS.appId,
      searchKey: env.UNTAPPD_ALGOLIA_SEARCH_KEY ?? ALGOLIA_DEFAULTS.searchKey,
      proxyUrl: env.WEBSHARE_PROXY,
    });
    // #576: the SAME persistent breaker the crons trip (`src/index.ts:173-179`), so a manual
    // run cannot deepen an outage they have already detected. onTrip/onRecover are no-ops on
    // purpose: this tool only ever READS the circuit — it never calls onResult, so they can
    // never fire.
    const breaker = createPersistentCircuitBreaker({
      db,
      key: 'untappd_circuit_open_until',
      cooldownMs: 6 * 60 * 60 * 1000,
      onTrip: () => {},
      onRecover: () => {},
    });
    const out = await probeIssueRows({
      db, log, breaker,
      lookup: (beer) => lookupBeer({ ...beer, search }),
      canary: async () => (await search.search(CANARY_QUERY)).length > 0,
      limit: limitRaw ? parseInt(limitRaw, 10) : undefined,
    }, issue);

    if (out.status === 'circuit_open') { console.error('circuit open — refusing to probe'); return 1; }
    if (out.status === 'canary_failed') {
      console.error(`canary failed ${out.at} the run — nothing written`);
      return 1;
    }
    const path = `/tmp/adjudicate-${issue}-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify(out.file, null, 2));
    for (const v of out.file.verdicts) console.log(`  ${v.beer_id}  ${v.verdict}  ${v.brewery} / ${v.name}`);
    console.log(`\nverdicts written to ${path}`);
    console.log(`apply with: npm run adjudicate -- --apply ${path}`);
    return 0;
  } finally {
    db.close();
  }
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err) => { console.error(err); process.exitCode = 1; });
