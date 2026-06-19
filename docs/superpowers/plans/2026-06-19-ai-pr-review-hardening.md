# AI PR Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragile third-party inline-comment AI review action with our own `tsx` script that posts one top-level PR review summary, fails loudly on infra errors, and is fully unit-tested.

**Architecture:** A single CommonJS TS script `scripts/ai-pr-review.ts` exports small pure functions (config, file-filtering, diff truncation, prompt assembly) plus two injectable-`fetch` async functions (`callOpenAI`, `upsertReview`), wired by a `main()` guarded with `require.main === module`. The workflow runs it via `npx tsx`; the script owns its exit code, so the old separate "verify" step is removed.

**Tech Stack:** Node 20 (global `fetch`), TypeScript (CommonJS), `tsx`, Vitest (globals enabled, tests co-located as `*.test.ts`), GitHub Actions, OpenAI chat completions (`gpt-4o-mini`).

**Spec:** `docs/superpowers/specs/2026-06-19-ai-pr-review-hardening-design.md`

---

## File Structure

- **Create** `scripts/ai-pr-review.ts` — the whole reviewer: constants, pure helpers, two `fetch`-based async functions, and `main()`.
- **Create** `scripts/ai-pr-review.test.ts` — Vitest unit tests for every pure helper and both async functions (mocked `fetch`).
- **Modify** `.github/workflows/codex-review.yml` — drop the `anc95/ChatGPT-CodeReview` step, the prompt-builder step, and the verify step; add Node setup + `npm ci` + a single `npx tsx scripts/ai-pr-review.ts` step.
- **Unchanged** `.github/ai-review/AGENTS.md` — read verbatim by the script as the system prompt.

All TS lives in one file because the pieces are small and share constants (the include/ignore patterns must have a single source of truth, per the spec).

---

### Task 1: File filtering against include/ignore globs

**Files:**
- Create: `scripts/ai-pr-review.ts`
- Test: `scripts/ai-pr-review.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/ai-pr-review.test.ts`:

```ts
import { filterReviewableFiles, globToRegExp } from './ai-pr-review';

describe('globToRegExp', () => {
  it('matches ** across directories and * within a segment', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/deep/b.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a.js')).toBe(false);
    expect(globToRegExp('.github/workflows/*.yml').test('.github/workflows/ci.yml')).toBe(true);
    expect(globToRegExp('.github/workflows/*.yml').test('.github/workflows/sub/ci.yml')).toBe(false);
  });
});

describe('filterReviewableFiles', () => {
  it('keeps in-scope source files and drops ignored/out-of-scope ones', () => {
    const input = [
      'src/a.ts',
      'tests/b.ts',
      'scripts/c.ts',
      'extension/d.ts',
      '.github/workflows/ci.yml',
      'src/e.js',
      'README.md',
      'spec.md',
      'docs/guide.md',
      'package-lock.json',
    ];
    expect(filterReviewableFiles(input)).toEqual([
      'src/a.ts',
      'tests/b.ts',
      'scripts/c.ts',
      'extension/d.ts',
      '.github/workflows/ci.yml',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: FAIL — cannot resolve module `./ai-pr-review` / exports undefined.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/ai-pr-review.ts` with exactly this content:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-pr-review.ts scripts/ai-pr-review.test.ts
git commit -m "feat(ci): file-scope filtering for AI PR review script (#143)"
```

---

### Task 2: Config reader (`readConfig`)

**Files:**
- Modify: `scripts/ai-pr-review.ts`
- Test: `scripts/ai-pr-review.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `scripts/ai-pr-review.test.ts`:

```ts
import { readConfig } from './ai-pr-review';

describe('readConfig', () => {
  const full = {
    OPENAI_API_KEY: 'sk-test',
    GITHUB_TOKEN: 'ghs-test',
    REPO: 'ysilvestrov/warsaw-beer-bot',
    PR_NUMBER: '173',
    BASE_REF: 'main',
    HEAD_REF: 'feature',
    PR_TITLE: 'Title',
    PR_BODY: 'Body',
  } as NodeJS.ProcessEnv;

  it('reads a full env and defaults the endpoint', () => {
    const cfg = readConfig(full);
    expect(cfg.openaiEndpoint).toBe('https://api.openai.com/v1');
    expect(cfg.prNumber).toBe(173);
    expect(cfg.repo).toBe('ysilvestrov/warsaw-beer-bot');
  });

  it('throws loudly when OPENAI_API_KEY is missing', () => {
    const { OPENAI_API_KEY, ...rest } = full;
    expect(() => readConfig(rest as NodeJS.ProcessEnv)).toThrow(/OPENAI_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: FAIL — `readConfig` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/ai-pr-review.ts`:

```ts
export interface Config {
  openaiApiKey: string;
  openaiEndpoint: string;
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
    githubToken: required('GITHUB_TOKEN'),
    repo: required('REPO'),
    prNumber: Number(required('PR_NUMBER')),
    baseRef: required('BASE_REF'),
    headRef: env.HEAD_REF?.trim() || '',
    prTitle: env.PR_TITLE ?? '',
    prBody: env.PR_BODY ?? '',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-pr-review.ts scripts/ai-pr-review.test.ts
git commit -m "feat(ci): config reader with fail-loud required env (#143)"
```

---

### Task 3: Diff truncation + prompt assembly

**Files:**
- Modify: `scripts/ai-pr-review.ts`
- Test: `scripts/ai-pr-review.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `scripts/ai-pr-review.test.ts`:

```ts
import { truncateDiff, buildMessages } from './ai-pr-review';

describe('truncateDiff', () => {
  it('returns the diff unchanged when within budget', () => {
    expect(truncateDiff('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
  it('cuts to the budget and flags truncation when over', () => {
    expect(truncateDiff('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
  });
});

describe('buildMessages', () => {
  it('puts instructions in system and PR context + diff in user, noting truncation', () => {
    const msgs = buildMessages({
      instructions: 'REVIEW RULES',
      prTitle: 'My PR',
      prBody: 'desc',
      baseRef: 'main',
      headRef: 'feat',
      diff: 'diff-body',
      truncated: true,
    });
    expect(msgs[0]).toEqual({ role: 'system', content: 'REVIEW RULES' });
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('Title: My PR');
    expect(msgs[1].content).toContain('diff-body');
    expect(msgs[1].content).toContain('truncated');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: FAIL — `truncateDiff` / `buildMessages` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/ai-pr-review.ts`:

```ts
export const DIFF_BUDGET = 100_000;

export function truncateDiff(diff: string, budget: number): { text: string; truncated: boolean } {
  if (diff.length <= budget) return { text: diff, truncated: false };
  return { text: diff.slice(0, budget), truncated: true };
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export function buildMessages(p: {
  instructions: string;
  prTitle: string;
  prBody: string;
  baseRef: string;
  headRef: string;
  diff: string;
  truncated: boolean;
}): ChatMessage[] {
  const user = [
    '# Pull request',
    `Title: ${p.prTitle}`,
    `Base: ${p.baseRef}`,
    `Head: ${p.headRef}`,
    '',
    '## Body',
    p.prBody || '(no description)',
    '',
    `## Diff${p.truncated ? ' (truncated — only the first part is shown)' : ''}`,
    '```diff',
    p.diff,
    '```',
  ].join('\n');
  return [
    { role: 'system', content: p.instructions },
    { role: 'user', content: user },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-pr-review.ts scripts/ai-pr-review.test.ts
git commit -m "feat(ci): diff truncation + prompt assembly for AI review (#143)"
```

---

### Task 4: OpenAI call with retry/backoff (`callOpenAI`)

**Files:**
- Modify: `scripts/ai-pr-review.ts`
- Test: `scripts/ai-pr-review.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `scripts/ai-pr-review.test.ts`:

```ts
import { callOpenAI } from './ai-pr-review';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const completion = { choices: [{ message: { content: 'LGTM' } }] };
const deps = (fetchFn: typeof fetch) => ({
  endpoint: 'https://api.openai.com/v1',
  apiKey: 'sk',
  fetchFn,
  sleep: async () => {},
});

describe('callOpenAI', () => {
  it('returns the completion content on success', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(completion)) as unknown as typeof fetch;
    await expect(callOpenAI(deps(fetchFn), [])).resolves.toBe('LGTM');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse(completion)) as unknown as typeof fetch;
    await expect(callOpenAI(deps(fetchFn), [])).resolves.toBe('LGTM');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('fails loudly after exhausting retries on persistent 429', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch;
    await expect(callOpenAI({ ...deps(fetchFn), attempts: 3 }, [])).rejects.toThrow(/429|attempts/);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 401 auth error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401)) as unknown as typeof fetch;
    await expect(callOpenAI(deps(fetchFn), [])).rejects.toThrow(/401/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: FAIL — `callOpenAI` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/ai-pr-review.ts`:

```ts
class NonRetryableError extends Error {}

export interface OpenAiDeps {
  endpoint: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

export async function callOpenAI(deps: OpenAiDeps, messages: ChatMessage[]): Promise<string> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = deps.attempts ?? 3;
  const url = `${deps.endpoint.replace(/\/$/, '')}/chat/completions`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0,
          top_p: 1,
          max_tokens: 10000,
          messages,
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`OpenAI HTTP ${res.status}`);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new NonRetryableError(`OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new NonRetryableError('OpenAI returned an empty completion');
      return content;
    } catch (err) {
      if (err instanceof NonRetryableError) throw err;
      lastErr = err;
      if (attempt < attempts) await sleep(2 ** attempt * 100);
    }
  }
  throw new Error(`OpenAI request failed after ${attempts} attempts: ${String(lastErr)}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-pr-review.ts scripts/ai-pr-review.test.ts
git commit -m "feat(ci): OpenAI call with retry/backoff + fail-loud classification (#143)"
```

---

### Task 5: Top-level review upsert with marker (`upsertReview`)

**Files:**
- Modify: `scripts/ai-pr-review.ts`
- Test: `scripts/ai-pr-review.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `scripts/ai-pr-review.test.ts`:

```ts
import { upsertReview, wrapBody, MARKER } from './ai-pr-review';

describe('wrapBody', () => {
  it('embeds the hidden marker', () => {
    expect(wrapBody('hello')).toContain(MARKER);
    expect(wrapBody('hello')).toContain('hello');
  });
});

describe('upsertReview', () => {
  const ghDeps = (fetchFn: typeof fetch) => ({
    repo: 'o/r',
    prNumber: 7,
    token: 't',
    fetchFn,
  });

  it('creates a new top-level COMMENT review when none exists', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]); // list
      return jsonResponse({ id: 1 }); // create
    }) as unknown as typeof fetch;

    await expect(upsertReview(ghDeps(fetchFn), wrapBody('x'))).resolves.toBe('created');
    const create = calls[1];
    expect(create.init?.method).toBe('POST');
    expect(JSON.parse(create.init!.body as string).event).toBe('COMMENT');
  });

  it('updates the existing marker review instead of stacking a new one', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) {
        return jsonResponse([{ id: 42, body: `${MARKER}\nold`, user: { type: 'Bot' } }]);
      }
      return jsonResponse({ id: 42 });
    }) as unknown as typeof fetch;

    await expect(upsertReview(ghDeps(fetchFn), wrapBody('new'))).resolves.toBe('updated');
    const update = calls[1];
    expect(update.init?.method).toBe('PUT');
    expect(update.url).toContain('/reviews/42');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: FAIL — `upsertReview` / `wrapBody` / `MARKER` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/ai-pr-review.ts`:

```ts
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

  const listRes = await fetchFn(`${base}?per_page=100`, { headers });
  if (!listRes.ok) throw new Error(`GitHub list reviews HTTP ${listRes.status}`);
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
    if (!res.ok) throw new Error(`GitHub update review HTTP ${res.status}`);
    return 'updated';
  }

  const res = await fetchFn(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body, event: 'COMMENT' }),
  });
  if (!res.ok) throw new Error(`GitHub create review HTTP ${res.status}`);
  return 'created';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: PASS (14 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-pr-review.ts scripts/ai-pr-review.test.ts
git commit -m "feat(ci): marker-based top-level review upsert (no inline lines) (#143)"
```

---

### Task 6: Wire `main()` orchestration

**Files:**
- Modify: `scripts/ai-pr-review.ts`

No new unit tests (this is glue over already-tested units + git/`fetch` I/O). Verified by typecheck + the workflow run.

- [ ] **Step 1: Add imports at the very top of `scripts/ai-pr-review.ts`**

Insert as the first lines of the file (above `INCLUDE_PATTERNS`):

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
```

- [ ] **Step 2: Append the orchestration + entrypoint at the end of the file**

```ts
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

const INSTRUCTIONS_PATH = '.github/ai-review/AGENTS.md';

export async function main(): Promise<void> {
  const cfg = readConfig(process.env);

  const reviewable = filterReviewableFiles(listChangedFiles(cfg.baseRef));
  if (reviewable.length === 0) {
    console.log('::notice::AI review skipped: no changed files are in the reviewer scope.');
    return;
  }

  if (!existsSync(INSTRUCTIONS_PATH)) {
    throw new Error(`${INSTRUCTIONS_PATH} is missing`);
  }
  const instructions = readFileSync(INSTRUCTIONS_PATH, 'utf8');

  const { text: diff, truncated } = truncateDiff(getDiff(cfg.baseRef, reviewable), DIFF_BUDGET);

  const messages = buildMessages({
    instructions,
    prTitle: cfg.prTitle,
    prBody: cfg.prBody,
    baseRef: cfg.baseRef,
    headRef: cfg.headRef,
    diff,
    truncated,
  });

  const summary = await callOpenAI(
    { endpoint: cfg.openaiEndpoint, apiKey: cfg.openaiApiKey },
    messages,
  );

  const how = await upsertReview(
    { repo: cfg.repo, prNumber: cfg.prNumber, token: cfg.githubToken },
    wrapBody(summary),
  );

  console.log(`AI review ${how} on PR #${cfg.prNumber} (${reviewable.length} file(s) in scope).`);
}

if (require.main === module) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`::error::AI review failed: ${msg}`);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Typecheck and full test run**

Run: `npm run typecheck && npx vitest run scripts/ai-pr-review.test.ts`
Expected: typecheck clean; 14 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/ai-pr-review.ts
git commit -m "feat(ci): wire AI PR review orchestration (#143)"
```

---

### Task 7: Replace the workflow

**Files:**
- Modify: `.github/workflows/codex-review.yml`

- [ ] **Step 1: Overwrite the file with the new content**

Replace the entire contents of `.github/workflows/codex-review.yml` with:

```yaml
name: AI PR Review

on:
  pull_request:
    types: [opened, reopened, synchronize]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ai-pr-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout PR head
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: AI code review
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_ENDPOINT: https://api.openai.com/v1
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          PR_TITLE: ${{ github.event.pull_request.title }}
          PR_BODY: ${{ github.event.pull_request.body }}
          BASE_REF: ${{ github.base_ref }}
          HEAD_REF: ${{ github.event.pull_request.head.ref }}
        run: |
          set -euo pipefail
          # Full base history is needed for the triple-dot (origin/base...HEAD) diffs
          # the script runs; the checkout above already used fetch-depth: 0.
          git fetch origin "$BASE_REF"
          npx tsx scripts/ai-pr-review.ts
```

- [ ] **Step 2: Validate YAML parses**

Run: `npx js-yaml .github/workflows/codex-review.yml >/dev/null && echo OK`
Expected: `OK` (if `js-yaml` CLI is unavailable, run `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/codex-review.yml')); print('OK')"`).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/codex-review.yml
git commit -m "ci: replace inline-comment action with own top-level review script (#143)"
```

---

### Task 8: Final verification + PR

**Files:** none (verification only)

- [ ] **Step 1: Full test suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 2: Confirm the old action is fully gone**

Run: `grep -rn "anc95\|ChatGPT-CodeReview\|Verify review was posted\|github-env-multiline" .github/workflows/`
Expected: no matches in `codex-review.yml` (the multiline helper script + its test may still exist elsewhere; that's fine — they're just no longer referenced by this workflow).

- [ ] **Step 3: Push branch and open PR**

```bash
git push -u origin HEAD
gh pr create --fill --base main
```

- [ ] **Step 4: Follow the PR review loop**

Wait for the AI review (now our own script) to run on this PR, read its feedback, verify/triage each point, and address valid findings before merge.

---

## Self-Review

**1. Spec coverage:**
- Top-level review, no inline → Task 5 (`event: COMMENT`, body only). ✅
- Own TS script via `tsx` → Tasks 1–6 + Task 7 workflow. ✅
- Fail-loud classification table → Task 2 (config errors), Task 4 (OpenAI retry-then-fail, non-retryable 4xx), Task 5 (GitHub post failure), Task 6 (`main().catch` → `exit(1)`); clean-skip path in Task 6 (`::notice::`, return). ✅
- Marker-based update vs. spam → Task 5. ✅
- Single source of truth for scope globs → Task 1 constants, consumed in Task 6. ✅
- Verify step removed → Task 7 (absent from new YAML). ✅
- Diff budget + truncation note → Task 3. ✅
- Testing list (filtering, truncation, prompt, marker upsert, error classifier) → Tasks 1,3,5,4. ✅
- Retries = 3 attempts w/ exponential backoff → Task 4 (`attempts ?? 3`, `2 ** attempt * 100`). ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every run step shows the command + expected output. ✅

**3. Type consistency:** `ChatMessage` defined in Task 3, consumed by `callOpenAI` (Task 4) and `buildMessages` (Task 3). `Config` (Task 2) consumed in Task 6. `OpenAiDeps`/`GithubDeps` defined and consumed in Tasks 4/5/6. `filterReviewableFiles`, `truncateDiff`, `DIFF_BUDGET`, `wrapBody`, `upsertReview`, `callOpenAI`, `readConfig` names match across definition and use. ✅
