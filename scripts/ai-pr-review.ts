import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';

import { buildReviewContext } from './ai-review/context';
import { runFind } from './ai-review/find';
import { applyGate, changedLineRanges, findingKey } from './ai-review/gate';
import { decideMode, reconcileFindings, type ClosedFinding } from './ai-review/incremental';
import { renderBody, type OpenFinding } from './ai-review/render';
import { parseState, toStored, type StoredFinding } from './ai-review/state';
import { EMPTY_USAGE, addUsage, costUsd, formatCostLine } from './ai-review/usage';
import { verifyAll } from './ai-review/verify';
import type { GatedFinding, VerifyRequest } from './ai-review/types';

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

/**
 * Chosen by replay measurement on 2026-07-28, not by preference — see
 * docs/superpowers/specs/2026-07/2026-07-28-ai-review-measurement.md.
 * gpt-5.5 as finder published 0 fabrications across the precision set;
 * gpt-5.4-mini published 5 of 10. The verifier is the same model because no
 * asymmetric pairing measured better.
 *
 * Exported so the replay tool measures the configuration CI runs instead of a
 * second copy of these strings that can drift away from it.
 */
export const DEFAULT_FIND_MODEL = 'gpt-5.5';
export const DEFAULT_VERIFY_MODEL = 'gpt-5.5';

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const required = (name: string): string => {
    const v = env[name];
    if (!v || v.trim() === '') throw new Error(`Missing required env: ${name}`);
    return v;
  };
  return {
    openaiApiKey: required('OPENAI_API_KEY'),
    openaiEndpoint: env.OPENAI_API_ENDPOINT?.trim() || 'https://api.openai.com/v1',
    findModel: env.AI_REVIEW_MODEL?.trim() || DEFAULT_FIND_MODEL,
    verifyModel: env.AI_REVIEW_VERIFY_MODEL?.trim() || DEFAULT_VERIFY_MODEL,
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

interface IssueCommentRow {
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

export interface ExistingReview {
  id: number;
  body: string;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'warsaw-beer-bot-ai-review',
    'Content-Type': 'application/json',
  };
}

/**
 * The bot's own marker review, if it has one.
 *
 * Read before the review runs, not only when posting: its body carries the
 * state block that decides whether this run is full, incremental or a free
 * republish. The result is handed to `upsertReview` so the list call is paid
 * for once.
 *
 * The marker review is created on the first run, so it is among the earliest
 * reviews and stays on the first page; per_page=100 finds it without paging.
 */
export async function findExistingReview(deps: GithubDeps): Promise<ExistingReview | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = `https://api.github.com/repos/${deps.repo}/pulls/${deps.prNumber}/reviews`;
  const res = await fetchFn(`${base}?per_page=100`, { headers: githubHeaders(deps.token) });
  if (!res.ok) throw await githubError('list reviews', res);
  const reviews = (await res.json()) as ReviewRow[];
  const existing = reviews.find((r) => r.user?.type === 'Bot' && (r.body ?? '').includes(MARKER));
  return existing ? { id: existing.id, body: existing.body ?? '' } : null;
}

export async function upsertReview(
  deps: GithubDeps,
  body: string,
  existing?: ExistingReview | null,
): Promise<'created' | 'updated'> {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = `https://api.github.com/repos/${deps.repo}/pulls/${deps.prNumber}/reviews`;
  const headers = githubHeaders(deps.token);
  const target = existing === undefined ? await findExistingReview(deps) : existing;

  if (target) {
    const res = await fetchFn(`${base}/${target.id}`, {
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

export const FAILURE_MARKER = '<!-- ai-pr-review-failure -->';
const FAILURE_COMMENT_LOOKUP_TIMEOUT_MS = 2_000;
const FAILURE_COMMENT_WRITE_TIMEOUT_MS = 8_000;

function failureCommentBody(message: string, headSha: string): string {
  const detail = message.trim().slice(0, 1_000).replace(/\r?\n/g, '\n> ');
  return [
    FAILURE_MARKER,
    '',
    '## ⚠️ AI PR Review failed',
    '',
    `The required AI review did not complete for commit \`${headSha}\`.`,
    'The failing check remains authoritative. No new AI review was published for this run.',
    '',
    `> ${detail}`,
  ].join('\n');
}

async function postFailureComment(
  deps: GithubDeps,
  message: string,
  headSha: string,
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `https://api.github.com/repos/${deps.repo}/issues/${deps.prNumber}/comments`;
  const headers = githubHeaders(deps.token);
  const lookupSignal = AbortSignal.timeout(FAILURE_COMMENT_LOOKUP_TIMEOUT_MS);
  const body = failureCommentBody(message, headSha);
  let pageUrl: string | null = `${url}?per_page=100`;
  let existing: IssueCommentRow | undefined;
  while (pageUrl) {
    let list: Response;
    try {
      list = await fetchFn(pageUrl, { headers, signal: lookupSignal });
    } catch {
      break;
    }
    if (!list.ok) break;
    const comments = (await list.json()) as IssueCommentRow[];
    existing = comments.find(
      (comment) => comment.user?.type === 'Bot' && (comment.body ?? '').includes(FAILURE_MARKER),
    );
    if (existing) break;
    pageUrl = list.headers?.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  if (existing?.body === body) return;

  const updateUrl = `https://api.github.com/repos/${deps.repo}/issues/comments/${existing?.id}`;
  const res = await fetchFn(existing ? updateUrl : url, {
    method: existing ? 'PATCH' : 'POST',
    headers,
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(FAILURE_COMMENT_WRITE_TIMEOUT_MS),
  });
  if (!res.ok) throw await githubError(existing ? 'update failure comment' : 'create failure comment', res);
}

/**
 * Reads a changed file for review context, or null if it cannot be reviewed.
 *
 * Uses `lstat` and refuses anything that is not a regular file, so a symlink is
 * reported as unreadable instead of being followed. `filterReviewableFiles`
 * matches on pathname only, so without this a PR could add an in-scope `.ts`
 * symlink pointing at `/etc/passwd` or `.git/config` and have the target's
 * contents shipped to the model as "the changed file". We want the blob the PR
 * actually adds, never what it points at.
 */
export function readReviewableFile(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const FIND_INSTRUCTIONS_PATH = '.github/ai-review/AGENTS.md';
const VERIFY_INSTRUCTIONS_PATH = '.github/ai-review/VERIFY.md';

function readInstructions(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing`);
  return readFileSync(path, 'utf8');
}

/**
 * Everything `runReview` touches outside itself. Injected so the whole
 * orchestration — including the incremental path, which otherwise needs a git
 * fixture with real ancestry — is testable without a network or a repository.
 */
export interface ReviewDeps {
  headSha: string;
  hasCommit: (sha: string) => boolean;
  isAncestor: (ancestor: string, descendant: string) => boolean;
  listChangedFiles: (diffSpec: string) => string[];
  getDiff: (diffSpec: string, files: string[]) => string;
  readFile: (path: string) => string | null;
  readInstructions: (path: string) => string;
  log: (message: string) => void;
  openaiFetch?: typeof fetch;
  githubFetch?: typeof fetch;
}

function toVerifyRequest(id: string, f: GatedFinding | StoredFinding): VerifyRequest {
  return {
    id,
    file: f.file,
    matchedLine: f.matchedLine,
    matchedEndLine: f.matchedEndLine,
    quote: f.quote,
    claim: f.claim,
    why_it_breaks: f.why_it_breaks,
  };
}

async function runReviewOnce(cfg: Config, deps: ReviewDeps): Promise<void> {
  const gh: GithubDeps = {
    repo: cfg.repo,
    prNumber: cfg.prNumber,
    token: cfg.githubToken,
    fetchFn: deps.githubFetch,
  };

  const existing = await findExistingReview(gh);
  const state = parseState(existing?.body);

  const decision = decideMode({
    state,
    headSha: deps.headSha,
    baseRef: cfg.baseRef,
    hasCommit: deps.hasCommit,
    isAncestor: deps.isAncestor,
  });
  deps.log(`::notice::AI review mode: ${decision.mode} — ${decision.reason}`);

  // Nothing new to say and nothing new to charge for: put back exactly what is
  // already there, so the review (and its state) survives a workflow re-run.
  if (decision.mode === 'republish' && existing) {
    await upsertReview(gh, existing.body, existing);
    deps.log(`AI review republished unchanged on PR #${cfg.prNumber} (0 API calls).`);
    return;
  }

  const reviewable = filterReviewableFiles(deps.listChangedFiles(decision.diffSpec));

  // A first review with nothing in scope has nothing to publish. An incremental
  // one still does — the previous run's findings are open until proven closed.
  if (reviewable.length === 0 && !state) {
    deps.log('::notice::AI review skipped: no changed files are in the reviewer scope.');
    return;
  }

  const openaiDeps = {
    endpoint: cfg.openaiEndpoint,
    apiKey: cfg.openaiApiKey,
    fetchFn: deps.openaiFetch,
  };

  // Deliberately runs in `full` mode too, not only incremental: the mode decides
  // what this run re-reads, never what it forgets. A published finding is retired
  // by evidence — its file gone, or a re-check refuting it — and after a
  // force-push the quote it was published against no longer anchors, so it lands
  // in `recheck` and is adjudicated rather than carried. Dropping the state on a
  // force-push would instead delete open findings the maintainer is mid-fix on.
  const { carried, recheck, closed: obsolete } = reconcileFindings({
    stored: state?.findings ?? [],
    fileContent: deps.readFile,
  });

  let findUsage = EMPTY_USAGE;
  let raisedCount = 0;
  let fresh: GatedFinding[] = [];

  if (reviewable.length > 0) {
    const diff = deps.getDiff(decision.diffSpec, reviewable);
    const { text: context, diffOnly } = buildReviewContext({
      diff,
      reviewable,
      readFile: deps.readFile,
    });
    if (diffOnly.length > 0) {
      deps.log(`::notice::Context budget: ${diffOnly.length} file(s) sent as diff only.`);
    }

    const found = await runFind(
      { ...openaiDeps, model: cfg.findModel },
      {
        instructions: deps.readInstructions(FIND_INSTRUCTIONS_PATH),
        context,
        prTitle: cfg.prTitle,
        prBody: cfg.prBody,
      },
    );
    findUsage = found.usage;
    raisedCount = found.findings.length;

    const gateResult = applyGate({
      findings: found.findings,
      reviewable,
      changed: changedLineRanges(diff),
      fileContent: deps.readFile,
      // Carried findings are already published; without this seed an
      // incremental pass over the same file would print each of them twice.
      knownKeys: carried.map((f) => findingKey(f.file, f.quote, f.claim)),
    });
    fresh = gateResult.kept;
    for (const d of gateResult.dropped) {
      deps.log(`::notice::gate dropped [${d.reason}] ${d.finding.file}: ${d.finding.claim}`);
    }
  } else {
    deps.log('::notice::AI review: this push changed no reviewable file; find pass skipped.');
  }

  const freshById = new Map(fresh.map((f, i) => [`f${i}`, f]));
  const recheckById = new Map(recheck.map((f, i) => [`r${i}`, f]));
  const requests = [
    ...fresh.map((f, i) => toVerifyRequest(`f${i}`, f)),
    ...recheck.map((f, i) => toVerifyRequest(`r${i}`, f)),
  ];

  const verified =
    requests.length === 0
      ? { results: [], usage: EMPTY_USAGE }
      : await verifyAll(
          { ...openaiDeps, model: cfg.verifyModel },
          {
            instructions: deps.readInstructions(VERIFY_INSTRUCTIONS_PATH),
            requests,
            fileContent: deps.readFile,
          },
        );

  const open: OpenFinding[] = carried.map((finding) => ({
    finding,
    note: 'carried from an earlier push',
  }));
  const closed: ClosedFinding[] = [...obsolete];
  let confirmedCount = 0;

  for (const r of verified.results) {
    const freshFinding = freshById.get(r.id);
    if (freshFinding) {
      // Fresh finding: fail closed. Never publish a claim nobody checked.
      if (r.verdict === 'confirmed') {
        open.push({ finding: toStored(freshFinding, r.evidence) });
        confirmedCount += 1;
      } else {
        deps.log(`::notice::verify withheld [${r.verdict}] ${freshFinding.file}: ${r.evidence}`);
      }
      continue;
    }

    // Re-check of an already published finding: fail OPEN, deliberately. It was
    // published on evidence, and dropping it on a transient API error would
    // lose information the maintainer is acting on.
    const old = recheckById.get(r.id)!;
    if (r.verdict === 'confirmed') {
      open.push({ finding: { ...old, evidence: r.evidence }, note: 'the fix did not close this' });
    } else if (r.verdict === 'error') {
      open.push({ finding: old, note: `unverified this run (${r.evidence})` });
    } else {
      closed.push({ finding: old, reason: 'fixed' });
    }
  }

  const runUsage = addUsage(findUsage, verified.usage);
  const findUsd = costUsd(cfg.findModel, findUsage);
  const verifyUsd = costUsd(cfg.verifyModel, verified.usage);
  const runUsd = findUsd === null || verifyUsd === null ? null : findUsd + verifyUsd;
  const previousSpend = state?.spend ?? { usd: 0, runs: 0, unpriced: 0 };
  const spend = {
    usd: previousSpend.usd + (runUsd ?? 0),
    runs: previousSpend.runs + 1,
    unpriced: previousSpend.unpriced + (runUsd === null ? 1 : 0),
  };
  const costLine = formatCostLine({
    find: findUsage,
    verify: verified.usage,
    runUsd,
    totalUsd: spend.usd,
    unpriced: spend.unpriced,
  });
  deps.log(`::notice::AI review cost: ${costLine}`);

  const body = renderBody({
    open,
    closed,
    counts: {
      raised: raisedCount,
      gated: fresh.length,
      verified: confirmedCount,
      carried: carried.length,
      closed: closed.length,
    },
    costLine,
    head: deps.headSha,
    spend,
  });

  const how = await upsertReview(gh, wrapBody(body), existing);

  deps.log(
    `AI review ${how} on PR #${cfg.prNumber} [${decision.mode}]: ` +
      `${raisedCount} raised → ${fresh.length} gated → ${confirmedCount} confirmed, ` +
      `${carried.length} carried, ${closed.length} closed ` +
      `(${reviewable.length} file(s) in scope, ${runUsage.calls} API call(s)).`,
  );
}

export async function runReview(cfg: Config, deps: ReviewDeps): Promise<void> {
  try {
    await runReviewOnce(cfg, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await postFailureComment(
        {
          repo: cfg.repo,
          prNumber: cfg.prNumber,
          token: cfg.githubToken,
          fetchFn: deps.githubFetch,
        },
        message,
        deps.headSha,
      );
      deps.log(`::notice::AI review failure comment posted on PR #${cfg.prNumber}.`);
    } catch (commentErr) {
      const commentMessage = commentErr instanceof Error ? commentErr.message : String(commentErr);
      deps.log(`::error::AI review failure comment could not be posted: ${commentMessage}`);
    }
    throw err;
  }
}

function gitOk(args: string[]): boolean {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cfg = readConfig(process.env);
  await runReview(cfg, {
    headSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    hasCommit: (sha) => gitOk(['cat-file', '-e', `${sha}^{commit}`]),
    isAncestor: (a, b) => gitOk(['merge-base', '--is-ancestor', a, b]),
    listChangedFiles: (diffSpec) =>
      execFileSync('git', ['diff', '--name-only', diffSpec], { encoding: 'utf8' })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    getDiff: (diffSpec, files) =>
      execFileSync('git', ['diff', diffSpec, '--', ...files], {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      }),
    readFile: readReviewableFile,
    readInstructions,
    log: (message) => console.log(message),
  });
}

if (require.main === module) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`::error::AI review failed: ${msg}`);
    process.exit(1);
  });
}
