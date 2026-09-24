import type { DB } from '../src/storage/db';
import type { GithubCloseoutClient } from '../src/infra/github-closeout';
import { createGithubCloseoutClient } from '../src/infra/github-closeout';
import { inspectOrphanIssue } from '../src/jobs/orphan-closeout';
import { loadOperatorEnv } from './operator-env';
import { loadEnv } from '../src/config/env';
import { openDb } from '../src/storage/db';

export function parseCloseArgs(argv: string[]): { issue: number; close: boolean } {
  if ((argv.length !== 2 && argv.length !== 3) || argv[0] !== '--issue'
    || !/^[1-9]\d*$/.test(argv[1]) || (argv.length === 3 && argv[2] !== '--close')) {
    throw new Error('usage: npm run close-orphan-issue -- --issue <positive integer> [--close]');
  }
  const issue = Number(argv[1]);
  if (!Number.isSafeInteger(issue)) throw new Error('issue number is too large');
  return { issue, close: argv.length === 3 };
}

export async function runCloseOrphanIssue(argv: string[], deps: {
  db: DB; github: GithubCloseoutClient; print: (line: string) => void;
}): Promise<number> {
  const args = parseCloseArgs(argv);
  const version = (deps.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as
    { v: number | null }).v ?? 0;
  if (version < 37) throw new Error(`schema v37 required before closeout (current v${version})`);
  const inspect = async (expectedState: 'open' | 'closed') => {
    const issue = await deps.github.getIssue(args.issue);
    const report = inspectOrphanIssue(deps.db, args.issue);
    const ready = issue.number === args.issue && !issue.isPullRequest
      && issue.state === expectedState && issue.labels.includes('orphan-triage') && report.ready;
    return { ...report, github: issue, ready };
  };
  try {
    const first = await inspect('open');
    deps.print(JSON.stringify(first, null, 2));
    if (!first.ready || !args.close) return first.ready ? 0 : 1;
    const second = await inspect('open');
    if (!second.ready) { deps.print(JSON.stringify(second, null, 2)); return 1; }
    await deps.github.closeIssue(args.issue);
    const after = await inspect('closed');
    deps.print(JSON.stringify({ ...after, closed: after.github.state === 'closed' }, null, 2));
    return after.ready ? 0 : 1;
  } catch (error) {
    deps.print(`closeout refused: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  parseCloseArgs(argv); // usage must not depend on production config or DB
  loadOperatorEnv();
  const env = loadEnv();
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN required for orphan issue closeout');
  const db = openDb(env.DATABASE_PATH);
  try {
    const github = createGithubCloseoutClient({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO });
    return await runCloseOrphanIssue(argv, { db, github, print: console.log });
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
