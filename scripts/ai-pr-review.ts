import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { buildReviewContext } from './ai-review/context';
import { runFind } from './ai-review/find';
import { applyGate, changedLineRanges } from './ai-review/gate';
import { renderBody } from './ai-review/render';
import { verifyAll } from './ai-review/verify';

export const INCLUDE_PATTERNS = [
  'src/**/*.ts',
  'tests/**/*.ts',
  'scripts/**/*.ts',
  'extension/**/*.ts',
  '.github/workflows/*.yml',
];

export const IGNORE_PATTERNS = ['package-lock.json', '*.md', 'docs/**'];

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

export function filterReviewableFiles(files: string[]): string[] {
  return files.filter(
    (f) => matchesAny(f, INCLUDE_PATTERNS) && !matchesAny(f, IGNORE_PATTERNS),
  );
}

export interface Config {
  openaiApiKey: string;
  openaiEndpoint: string;
  findModel: string;
  verifyModel: string;
  githubToken: string;
  repo: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
  prTitle: string;
  prBody: string;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const required = (name: string): string => {
    const v = env[name];
    if (!v || v.trim() === '') throw new Error(`Missing required env: ${name}`);
    return v;
  };
  return {
    openaiApiKey: required('OPENAI_API_KEY'),
    openaiEndpoint: env.OPENAI_API_ENDPOINT?.trim() || 'https://api.openai.com/v1',
    findModel: env.AI_REVIEW_MODEL?.trim() || 'gpt-5.4-mini',
    verifyModel: env.AI_REVIEW_VERIFY_MODEL?.trim() || 'gpt-5.5',
    githubToken: required('GITHUB_TOKEN'),
    repo: required('REPO'),
    prNumber: Number(required('PR_NUMBER')),
    baseRef: required('BASE_REF'),
    headRef: env.HEAD_REF?.trim() || '',
    prTitle: env.PR_TITLE ?? '',
    prBody: env.PR_BODY ?? '',
  };
}

export const MARKER = '<!-- ai-pr-review -->';

export function wrapBody(summary: string): string {
  return `${MARKER}\n\n## 🤖 AI PR Review\n\n${summary.trim()}\n`;
}

export interface GithubDeps {
  repo: string;
  prNumber: number;
  token: string;
  fetchFn?: typeof fetch;
}

interface ReviewRow {
  id: number;
  body?: string;
  user?: { type?: string };
}

// Surfaces the GitHub response status AND body so a failed post fails loudly with a
// clear, actionable reason (mirrors the OpenAI non-ok path) rather than a bare code.
async function githubError(action: string, res: Response): Promise<Error> {
  const text = await res.text().catch(() => '');
  return new Error(`GitHub ${action} HTTP ${res.status}: ${text.slice(0, 300)}`);
}

export async function upsertReview(deps: GithubDeps, body: string): Promise<'created' | 'updated'> {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = `https://api.github.com/repos/${deps.repo}/pulls/${deps.prNumber}/reviews`;
  const headers = {
    Authorization: `Bearer ${deps.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'warsaw-beer-bot-ai-review',
    'Content-Type': 'application/json',
  };

  // The bot's marker review is created on the first run, so it is among the
  // earliest reviews and stays on the first page; per_page=100 is enough to find
  // it without pagination on this repo's PRs.
  const listRes = await fetchFn(`${base}?per_page=100`, { headers });
  if (!listRes.ok) throw await githubError('list reviews', listRes);
  const reviews = (await listRes.json()) as ReviewRow[];
  const existing = reviews.find(
    (r) => r.user?.type === 'Bot' && (r.body ?? '').includes(MARKER),
  );

  if (existing) {
    const res = await fetchFn(`${base}/${existing.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw await githubError('update review', res);
    return 'updated';
  }

  const res = await fetchFn(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body, event: 'COMMENT' }),
  });
  if (!res.ok) throw await githubError('create review', res);
  return 'created';
}

function listChangedFiles(baseRef: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', `origin/${baseRef}...HEAD`], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getDiff(baseRef: string, files: string[]): string {
  return execFileSync('git', ['diff', `origin/${baseRef}...HEAD`, '--', ...files], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
}

const FIND_INSTRUCTIONS_PATH = '.github/ai-review/AGENTS.md';
const VERIFY_INSTRUCTIONS_PATH = '.github/ai-review/VERIFY.md';

function readInstructions(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing`);
  return readFileSync(path, 'utf8');
}

async function main(): Promise<void> {
  const cfg = readConfig(process.env);

  const reviewable = filterReviewableFiles(listChangedFiles(cfg.baseRef));
  if (reviewable.length === 0) {
    console.log('::notice::AI review skipped: no changed files are in the reviewer scope.');
    return;
  }

  const findInstructions = readInstructions(FIND_INSTRUCTIONS_PATH);
  const verifyInstructions = readInstructions(VERIFY_INSTRUCTIONS_PATH);

  const diff = getDiff(cfg.baseRef, reviewable);
  const readFile = (path: string): string | null =>
    existsSync(path) ? readFileSync(path, 'utf8') : null;

  const { text: context, diffOnly } = buildReviewContext({ diff, reviewable, readFile });
  if (diffOnly.length > 0) {
    console.log(`::notice::Context budget: ${diffOnly.length} file(s) sent as diff only.`);
  }

  const raised = await runFind(
    { endpoint: cfg.openaiEndpoint, apiKey: cfg.openaiApiKey, model: cfg.findModel },
    { instructions: findInstructions, context, prTitle: cfg.prTitle, prBody: cfg.prBody },
  );

  const { kept, dropped } = applyGate({
    findings: raised,
    reviewable,
    changed: changedLineRanges(diff),
    fileContent: readFile,
  });
  for (const d of dropped) {
    console.log(`::notice::gate dropped [${d.reason}] ${d.finding.file}: ${d.finding.claim}`);
  }

  const { confirmed, rejected } = await verifyAll(
    { endpoint: cfg.openaiEndpoint, apiKey: cfg.openaiApiKey, model: cfg.verifyModel },
    { instructions: verifyInstructions, findings: kept, fileContent: readFile },
  );
  for (const r of rejected) {
    console.log(`::notice::verify withheld [${r.verdict}] ${r.finding.file}: ${r.evidence}`);
  }

  const body = renderBody({
    confirmed,
    counts: { raised: raised.length, gated: kept.length, verified: confirmed.length },
  });

  const how = await upsertReview(
    { repo: cfg.repo, prNumber: cfg.prNumber, token: cfg.githubToken },
    wrapBody(body),
  );

  console.log(
    `AI review ${how} on PR #${cfg.prNumber}: ` +
      `${raised.length} raised → ${kept.length} gated → ${confirmed.length} verified ` +
      `(${reviewable.length} file(s) in scope).`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`::error::AI review failed: ${msg}`);
    process.exit(1);
  });
}
