import { writeFileSync, readFileSync } from 'node:fs';
import pino from 'pino';
import { loadEnv } from '../src/config/env';
import { openDb } from '../src/storage/db';
import { loadOperatorEnv } from './operator-env';
import { probeIssueRows, summarizeProbe } from '../src/jobs/adjudicate-issue-rows';
import {
  parseVerdictFile, applyVerdicts, isVerdictFileStale, summarizeVerdictFile,
} from '../src/jobs/adjudicate-apply';
import { parseAdjudicateArgs } from '../src/jobs/adjudicate-args';
import { lookupBeer } from '../src/domain/untappd-lookup';
import { CANARY_QUERY } from '../src/jobs/enrich-orphans';
import { ALGOLIA_DEFAULTS, createAlgoliaSearch } from '../src/sources/untappd/algolia';
import { isCircuitOpen } from '../src/domain/untappd-circuit';

loadOperatorEnv();

async function main(argv: string[]): Promise<number> {
  const parsed = parseAdjudicateArgs(argv);
  const log = pino({ level: 'info' });
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    if (parsed.mode === 'usage') { console.error(parsed.reason); return 2; }

    if (parsed.mode === 'apply') {
      const file = parseVerdictFile(JSON.parse(readFileSync(parsed.path, 'utf8')));
      const nowIso = new Date().toISOString();
      // #576 I3: show the operator exactly what they are about to apply BEFORE writing anything —
      // which run, how old, what it contains. A bare "marked N, already marked M" after the fact
      // told them nothing about which file they'd just trusted.
      console.log(summarizeVerdictFile(file, nowIso));
      if (isVerdictFileStale(file, nowIso) && !parsed.force) {
        console.error(
          'refusing: this verdict file is older than the staleness window — a row it names may '
          + 'have moved since (re-armed, re-triaged, retired). Re-probe the issue, or pass '
          + '--force to apply it anyway.',
        );
        return 1;
      }
      const report = applyVerdicts(db, file, nowIso);
      console.log(`marked ${report.marked}, already marked ${report.alreadyMarked}`);
      for (const s of report.skipped) console.log(`  skipped ${s.beer_id}: ${s.reason}`);
      return 0;
    }

    // parsed.mode === 'probe'
    const { issue, limit } = parsed;
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
    // #576 I1: this tool performs NO WRITES AT ALL — not "it only skips onResult", which was the
    // wrong framing that let the bug through review twice. `createPersistentCircuitBreaker`'s
    // `canAttempt` is not a pure read (it calls `deleteJobState` on a malformed or expired
    // persisted value, verified live: an expired `untappd_circuit_open_until` was gone after one
    // probe run). `isCircuitOpen` is the actual read-only primitive; `onResult` here is a no-op
    // only because nothing ever calls it, not because it is safe to call. Same key as the crons'
    // Algolia breaker (`src/index.ts:173-179`) so the shared circuit state stays shared.
    const breaker = {
      canAttempt: (now: Date) => !isCircuitOpen(db, 'untappd_circuit_open_until', now),
      onResult: () => {},
      state: 'closed' as const,
    };
    const out = await probeIssueRows({
      db, log, breaker,
      lookup: (beer) => lookupBeer({ ...beer, search }),
      canary: async () => (await search.search(CANARY_QUERY)).length > 0,
      limit,
    }, issue);

    if (out.status === 'circuit_open') { console.error('circuit open — refusing to probe'); return 1; }
    if (out.status === 'canary_failed') {
      console.error(`canary failed ${out.at} the run — nothing written`);
      return 1;
    }
    const path = `/tmp/adjudicate-${issue}-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify(out.file, null, 2));
    for (const v of out.file.verdicts) console.log(`  ${v.beer_id}  ${v.verdict}  ${v.brewery} / ${v.name}`);
    console.log(summarizeProbe(out.file));
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
