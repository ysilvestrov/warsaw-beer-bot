/**
 * Run the review pipeline against a merged or open PR without posting anything.
 *
 *   npm run ai-review-replay -- 352
 *
 * Reads file bodies from the PR's head commit via `git show`, so it never
 * touches the working tree.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { buildReviewContext } from './context';
import { runFind } from './find';
import { applyGate, changedLineRanges } from './gate';
import { verifyAll } from './verify';
import {
  DEFAULT_FIND_MODEL,
  DEFAULT_VERIFY_MODEL,
  filterReviewableFiles,
} from '../ai-pr-review';

function sh(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

/**
 * The models replay runs with. Deliberately the same defaults and the same env
 * overrides as the production reviewer: a replay of a different configuration
 * measures nothing about what CI will do.
 */
export function replayModels(env: NodeJS.ProcessEnv): {
  findModel: string;
  verifyModel: string;
} {
  return {
    findModel: env.AI_REVIEW_MODEL?.trim() || DEFAULT_FIND_MODEL,
    verifyModel: env.AI_REVIEW_VERIFY_MODEL?.trim() || DEFAULT_VERIFY_MODEL,
  };
}

async function main(): Promise<void> {
  const pr = process.argv[2];
  if (!pr) throw new Error('usage: npm run ai-review-replay -- <pr-number>');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  // `baseRefOid` is not exposed by every gh version, so resolve the base from
  // its branch name instead: for a squash-merged PR the head commit is not an
  // ancestor of the base branch, so the merge-base is still the fork point.
  const meta = JSON.parse(
    gh(['pr', 'view', pr, '--json', 'title,body,headRefOid,baseRefName']),
  ) as { title: string; body: string; headRefOid: string; baseRefName: string };

  const head = meta.headRefOid;
  const mergeBase = sh(['merge-base', `origin/${meta.baseRefName}`, head]).trim();

  const changed = sh(['diff', '--name-only', `${mergeBase}..${head}`])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const reviewable = filterReviewableFiles(changed);
  if (reviewable.length === 0) {
    console.log('no reviewable files');
    return;
  }

  const diff = sh(['diff', `${mergeBase}..${head}`, '--', ...reviewable]);
  const readFile = (path: string): string | null => {
    try {
      return sh(['show', `${head}:${path}`]);
    } catch {
      return null;
    }
  };

  const { text: context } = buildReviewContext({ diff, reviewable, readFile });

  const { findModel, verifyModel } = replayModels(process.env);
  const endpoint = process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com/v1';

  const raised = await runFind(
    { endpoint, apiKey, model: findModel },
    {
      instructions: readFileSync('.github/ai-review/AGENTS.md', 'utf8'),
      context,
      prTitle: meta.title,
      prBody: meta.body,
    },
  );

  const { kept, dropped } = applyGate({
    findings: raised,
    reviewable,
    changed: changedLineRanges(diff),
    fileContent: readFile,
  });

  const { confirmed, rejected } = await verifyAll(
    { endpoint, apiKey, model: verifyModel },
    {
      instructions: readFileSync('.github/ai-review/VERIFY.md', 'utf8'),
      findings: kept,
      fileContent: readFile,
    },
  );

  console.log(`\n=== PR #${pr} (${findModel} → ${verifyModel}) ===`);
  console.log(`raised ${raised.length} → gated ${kept.length} → verified ${confirmed.length}\n`);
  for (const d of dropped) console.log(`  [gate:${d.reason}] ${d.finding.file}: ${d.finding.claim}`);
  for (const r of rejected) console.log(`  [verify:${r.verdict}] ${r.finding.file}: ${r.finding.claim}`);
  for (const c of confirmed) {
    console.log(`\n  PUBLISHED ${c.finding.severity} ${c.finding.file}:${c.finding.matchedLine}`);
    console.log(`    claim:    ${c.finding.claim}`);
    console.log(`    evidence: ${c.evidence}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
