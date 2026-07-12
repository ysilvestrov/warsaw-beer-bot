# Orphan-Triage Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily in-process job that sends the newest 50 untriaged `enrich_failures` rows plus the open `orphan-triage` GitHub issues to an LLM, files/updates issues for actionable patterns, writes `review_class`/`review_note` back, and reports one line in the daily-status digest.

**Architecture:** Follows the daily-status pattern — UTC cron tick every 15 min + pure Warsaw-window decision + `job_state` idempotency. LLM and GitHub are injected behind interfaces (`TriageLlm`, `GithubIssuesClient`); a pure planner (`planTriageActions`) validates the LLM output before any side effect; side-effect order per orphan is GitHub-first-DB-second. The digest job reads the triage result from `job_state`, so the two jobs stay decoupled.

**Tech Stack:** TypeScript (CommonJS — no top-level await), better-sqlite3, node-cron, zod, Vitest (globals enabled — bare `test`/`expect`), `@anthropic-ai/sdk` (new dep), plain `fetch` for OpenAI + GitHub REST.

**Spec:** `docs/superpowers/specs/2026-07-05-orphan-triage-agent-design.md`

**Deviation from spec (deliberate):** the spec sketched `Verdict.action` as a discriminated union and `new_issues` as a `Record<string, …>`. Anthropic strict tool schemas require `additionalProperties: false` + all-props-required, which a record-keyed object can't satisfy. The plan flattens: every verdict carries nullable `issue_number` / `new_issue_key`, and `new_issues` is an array of `{key, …}` objects. Semantics are identical.

**Worktree note:** execute in an isolated worktree (`superpowers:using-git-worktrees`). EnterWorktree branches from `origin/main` — cherry-pick the spec commit (`7bde476`) and the plan commit into the branch first (see `reference_worktree_docs_cherrypick` memory).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config/env.ts` (modify) | New env vars: provider, model, API keys, GitHub token/repo |
| `.env.example` (modify) | Document the new vars |
| `src/storage/enrich_failures.ts` (modify) | `selectUntriagedFailures(db, limit)` |
| `src/domain/triage-analysis.ts` (create) | `Analysis`/`Verdict` types, zod schema, strict JSON schema const, `buildTriagePrompt` |
| `src/domain/triage-plan.ts` (create) | Pure `planTriageActions`: validate verdicts, cap new issues, force labels, group comments |
| `src/infra/github-issues.ts` (create) | `GithubIssuesClient` via GitHub REST (fetch) |
| `src/infra/triage-llm.ts` (create) | `TriageLlm` interface, Anthropic + OpenAI implementations, env factory |
| `src/jobs/orphan-triage.ts` (create) | Orchestrator: window check, select → analyze → plan → execute → job_state |
| `src/jobs/daily-status.ts` (modify) | Render triage line from `job_state` |
| `src/index.ts` (modify) | Build clients, cron tick + startup catch-up |
| `spec.md` (modify) | New §5.11 |
| `docs/debug-orphan-matching.md` (modify) | Note that first-pass triage is automated |

---

### Task 1: Env config

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing tests**

Append to `src/config/env.test.ts` (match the file's existing style for building a base env object — reuse its existing valid-env fixture/helper if one exists):

```ts
test('triage env: defaults', () => {
  const env = loadEnv({ ...validBase });
  expect(env.TRIAGE_LLM_PROVIDER).toBe('anthropic');
  expect(env.TRIAGE_LLM_MODEL).toBe('claude-opus-4-8');
  expect(env.GITHUB_REPO).toBe('ysilvestrov/warsaw-beer-bot');
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
});

test('triage env: rejects unknown provider', () => {
  expect(() => loadEnv({ ...validBase, TRIAGE_LLM_PROVIDER: 'gemini' })).toThrow();
});

test('missingExpectedKeys reports GITHUB_TOKEN', () => {
  const env = loadEnv({ ...validBase });
  expect(missingExpectedKeys(env).map((k) => k.key)).toContain('GITHUB_TOKEN');
});
```

(`validBase` = whatever minimal valid env object the existing tests in this file already use; do not invent a new one.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL (unknown keys stripped / defaults missing).

- [ ] **Step 3: Implement**

In `src/config/env.ts` add to `Schema`:

```ts
  // Orphan-triage job (all optional; missing keys disable the job, never crash startup)
  TRIAGE_LLM_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  TRIAGE_LLM_MODEL: z.string().min(1).default('claude-opus-4-8'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().min(1).default('ysilvestrov/warsaw-beer-bot'),
```

Add to `EXPECTED_PROD_KEYS`:

```ts
  { key: 'GITHUB_TOKEN', disables: 'orphan-triage job (GitHub issue filing)' },
  { key: 'ANTHROPIC_API_KEY', disables: 'orphan-triage job (LLM analysis; not needed if TRIAGE_LLM_PROVIDER=openai)' },
```

Append to `.env.example`:

```
# --- Orphan-triage job (daily LLM triage of enrich_failures → GitHub issues) ---
# LLM provider + model. Provider: anthropic | openai. Model id is passed verbatim.
TRIAGE_LLM_PROVIDER=anthropic
TRIAGE_LLM_MODEL=claude-opus-4-8
# API key for the chosen provider. Missing key = triage job disabled (digest says so).
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# Repo-scoped token for creating/commenting orphan-triage issues.
# GITHUB_TOKEN=
GITHUB_REPO=ysilvestrov/warsaw-beer-bot
```

Also update the `.env.example` comment "the four \"expected in prod\" optional keys" → "the \"expected in prod\" optional keys" (the list is now longer).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts .env.example
git commit -m "feat(triage): env config for orphan-triage job"
```

---

### Task 2: Storage — select untriaged failures

**Files:**
- Modify: `src/storage/enrich_failures.ts`
- Modify: `src/storage/enrich_failures.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/storage/enrich_failures.test.ts` (reuse the file's existing in-memory-db helper and its way of inserting `beers` rows — `enrich_failures.beer_id` FK-references `beers(id)`):

```ts
test('selectUntriagedFailures: newest-first, cap, excludes blocked and reviewed', () => {
  const db = testDb(); // existing helper in this file
  // three orphans (beers must exist first; reuse existing insert helper)
  insertBeer(db, 1); insertBeer(db, 2); insertBeer(db, 3); insertBeer(db, 4);
  recordEnrichFailure(db, { beer_id: 1, brewery: 'A', name: 'a', search_url: 'u1',
    source_url: '', outcome: 'not_found', candidates_count: 0, candidates_summary: '',
    at: '2026-07-01T00:00:00Z' });
  recordEnrichFailure(db, { beer_id: 2, brewery: 'B', name: 'b', search_url: 'u2',
    source_url: '', outcome: 'not_found', candidates_count: 2, candidates_summary: 'x|y',
    at: '2026-07-03T00:00:00Z' });
  recordEnrichFailure(db, { beer_id: 3, brewery: 'C', name: 'c', search_url: 'u3',
    source_url: '', outcome: 'blocked', candidates_count: 0, candidates_summary: '',
    at: '2026-07-04T00:00:00Z' }); // blocked → excluded
  recordEnrichFailure(db, { beer_id: 4, brewery: 'D', name: 'd', search_url: 'u4',
    source_url: '', outcome: 'not_found', candidates_count: 0, candidates_summary: '',
    at: '2026-07-02T00:00:00Z' });
  setEnrichFailureReview(db, 4, 'wontfix', null, '2026-07-02T01:00:00Z'); // reviewed → excluded

  const rows = selectUntriagedFailures(db, 10);
  expect(rows.map((r) => r.beer_id)).toEqual([2, 1]); // newest first
  expect(selectUntriagedFailures(db, 1).map((r) => r.beer_id)).toEqual([2]); // cap
  expect(rows[0]).toMatchObject({
    brewery: 'B', name: 'b', search_url: 'u2', candidates_count: 2,
    candidates_summary: 'x|y', fail_count: 1, last_at: '2026-07-03T00:00:00Z',
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: FAIL — `selectUntriagedFailures` not exported.

- [ ] **Step 3: Implement**

Append to `src/storage/enrich_failures.ts`:

```ts
export interface UntriagedFailure {
  beer_id: number;
  brewery: string;
  name: string;
  search_url: string;
  source_url: string;
  candidates_count: number;
  candidates_summary: string;
  fail_count: number;
  last_at: string;
}

// Newest untriaged not_found failures for the daily triage job. `blocked` rows
// are proxy/ban trouble, not matching trouble, and are excluded. Newest-first so
// fresh signal is triaged before the stale backlog.
export function selectUntriagedFailures(db: DB, limit: number): UntriagedFailure[] {
  return db
    .prepare(
      `SELECT beer_id, brewery, name, search_url, source_url,
              candidates_count, candidates_summary, fail_count, last_at
         FROM enrich_failures
        WHERE review_class IS NULL AND outcome = 'not_found'
        ORDER BY last_at DESC
        LIMIT ?`,
    )
    .all(limit) as UntriagedFailure[];
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts
git commit -m "feat(triage): selectUntriagedFailures query"
```

---

### Task 3: Domain — analysis types, schema, prompt

**Files:**
- Create: `src/domain/triage-analysis.ts`
- Create: `src/domain/triage-analysis.test.ts`

- [ ] **Step 1: Write failing tests**

`src/domain/triage-analysis.test.ts`:

```ts
import {
  AnalysisSchema, buildTriagePrompt, ANALYSIS_TOOL_SCHEMA,
} from './triage-analysis';
import type { UntriagedFailure } from '../storage/enrich_failures';

const orphan: UntriagedFailure = {
  beer_id: 7, brewery: 'Nepomucen', name: 'Hazy Disco', search_url: 'https://s',
  source_url: 'https://shop.example', candidates_count: 3,
  candidates_summary: 'Nepo Brewing Hazy Disco|Other Beer', fail_count: 4,
  last_at: '2026-07-04T10:00:00Z',
};

test('AnalysisSchema: accepts a valid payload', () => {
  const a = AnalysisSchema.parse({
    verdicts: [{
      beer_id: 7, review_class: 'matcher_bug', review_note: 'alias gap',
      issue_number: null, new_issue_key: 'alias-nepomucen',
    }],
    new_issues: [{ key: 'alias-nepomucen', title: 'Alias: Nepomucen → Nepo Brewing',
      body: 'examples…', labels: ['orphan-triage'] }],
  });
  expect(a.verdicts[0].beer_id).toBe(7);
});

test('AnalysisSchema: rejects unknown review_class', () => {
  expect(() => AnalysisSchema.parse({
    verdicts: [{ beer_id: 1, review_class: 'meh', review_note: 'x',
      issue_number: null, new_issue_key: null }],
    new_issues: [],
  })).toThrow();
});

test('buildTriagePrompt: contains orphans, issues and class definitions', () => {
  const p = buildTriagePrompt({
    orphans: [orphan],
    openIssues: [{ number: 228, title: 'nano-noise tokens', body: 'strip nano', labels: ['orphan-triage'] }],
  });
  expect(p).toContain('"beer_id": 7');
  expect(p).toContain('#228');
  for (const cls of ['parser_bug', 'matcher_bug', 'not_on_untappd', 'wontfix']) {
    expect(p).toContain(cls);
  }
});

test('ANALYSIS_TOOL_SCHEMA: strict-compatible (no open objects)', () => {
  const check = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const o = node as Record<string, unknown>;
    if (o.type === 'object') {
      expect(o.additionalProperties).toBe(false);
      expect(Object.keys(o.properties as object).sort())
        .toEqual([...(o.required as string[])].sort());
    }
    for (const v of Object.values(o)) check(v);
  };
  check(ANALYSIS_TOOL_SCHEMA);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/triage-analysis.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/domain/triage-analysis.ts`:

```ts
import { z } from 'zod';
import type { UntriagedFailure } from '../storage/enrich_failures';

export const REVIEW_CLASSES = ['parser_bug', 'matcher_bug', 'not_on_untappd', 'wontfix'] as const;

export const VerdictSchema = z.object({
  beer_id: z.number().int(),
  review_class: z.enum(REVIEW_CLASSES),
  review_note: z.string().min(1).max(500),
  // At most one of these is non-null. parser_bug/matcher_bug verdicts point at
  // an existing open issue OR a new_issues entry; not_on_untappd/wontfix use neither.
  issue_number: z.number().int().nullable(),
  new_issue_key: z.string().nullable(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const AnalysisSchema = z.object({
  verdicts: z.array(VerdictSchema),
  new_issues: z.array(z.object({
    key: z.string().min(1),
    title: z.string().min(1).max(200),
    body: z.string().min(1),
    labels: z.array(z.string()),
  })),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export interface OpenIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface TriageInput {
  orphans: UntriagedFailure[];
  openIssues: OpenIssue[];
}

// JSON Schema mirror of AnalysisSchema for Anthropic strict tool use.
// Strict mode requires additionalProperties:false and every property required
// (hence nullable fields instead of optional ones). Keep in sync with the zod
// schema above — the strict-compat test guards the shape invariants.
export const ANALYSIS_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          beer_id: { type: 'integer' },
          review_class: { type: 'string', enum: [...REVIEW_CLASSES] },
          review_note: { type: 'string' },
          issue_number: { type: ['integer', 'null'] },
          new_issue_key: { type: ['string', 'null'] },
        },
        required: ['beer_id', 'review_class', 'review_note', 'issue_number', 'new_issue_key'],
        additionalProperties: false,
      },
    },
    new_issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
        },
        required: ['key', 'title', 'body', 'labels'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts', 'new_issues'],
  additionalProperties: false,
} as const;

const ISSUE_BODY_CAP = 2000; // bound prompt tokens; titles carry most signal

export function buildTriagePrompt(input: TriageInput): string {
  const issues = input.openIssues.map((i) =>
    `#${i.number} [${i.labels.join(', ')}] ${i.title}\n${i.body.slice(0, ISSUE_BODY_CAP)}`,
  ).join('\n---\n') || '(none)';
  return [
    'You are the triage analyst for a Warsaw beer-catalog → Untappd matching pipeline.',
    'Each orphan below is a beer our matcher failed to match. `candidates_summary` lists',
    'what the Untappd search returned (empty = the search query itself found nothing);',
    '`source_url` is the shop the beer was scraped from ("" = internal cron);',
    '`fail_count` is how many attempts have failed.',
    '',
    'Classify EVERY orphan with exactly one review_class:',
    '- parser_bug: the shop adapter produced a garbage row — merch/glassware/wine/food,',
    '  brewery and name split wrongly, HTML noise in fields. The fix is in the adapter.',
    '- matcher_bug: the beer plausibly exists on Untappd but we missed it — brewery alias',
    '  gap (e.g. rebrand), noise tokens in the query, name divergence between shop and',
    '  Untappd. The fix is in the matcher/aliases. Candidates that nearly match are a',
    '  strong hint.',
    '- not_on_untappd: a real beer that simply is not listed on Untappd. No fix possible.',
    '- wontfix: not worth fixing (one-off collab long gone, non-beer that is not the',
    '  adapter\'s fault, hopeless data).',
    '',
    'Cluster actionable orphans (parser_bug / matcher_bug) into patterns:',
    '- If an open issue below already covers the pattern, set issue_number to it.',
    '- Otherwise define an entry in new_issues (stable key, title, markdown body with the',
    '  examples and your hypothesis) and reference it via new_issue_key.',
    '- AT MOST 3 new_issues. Prefer fewer, broader patterns over many narrow ones.',
    '- not_on_untappd / wontfix verdicts must have issue_number: null and new_issue_key: null.',
    'review_note: one short sentence naming the pattern (English, ≤200 chars).',
    'Submit via the submit_triage tool. Do not invent issue numbers not listed below.',
    '',
    '## Open triage issues',
    issues,
    '',
    '## Orphans',
    JSON.stringify(input.orphans, null, 1),
  ].join('\n');
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/domain/triage-analysis.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-analysis.ts src/domain/triage-analysis.test.ts
git commit -m "feat(triage): analysis types, strict schema, prompt builder"
```

---

### Task 4: Domain — pure action planner

**Files:**
- Create: `src/domain/triage-plan.ts`
- Create: `src/domain/triage-plan.test.ts`

- [ ] **Step 1: Write failing tests**

`src/domain/triage-plan.test.ts`:

```ts
import { planTriageActions } from './triage-plan';
import type { Analysis, Verdict } from './triage-analysis';

const v = (over: Partial<Verdict>): Verdict => ({
  beer_id: 1, review_class: 'matcher_bug', review_note: 'note',
  issue_number: null, new_issue_key: null, ...over,
});
const issue = (key: string) => ({ key, title: `t-${key}`, body: 'b', labels: ['wrong'] });

test('routes verdicts: existing issue, new issue, quiet', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, issue_number: 228 }),
      v({ beer_id: 2, new_issue_key: 'k1', review_class: 'parser_bug' }),
      v({ beer_id: 3, review_class: 'not_on_untappd' }),
      v({ beer_id: 4, review_class: 'wontfix' }),
    ],
    new_issues: [issue('k1')],
  };
  const plan = planTriageActions(a, [228]);
  expect(plan.comments).toEqual([{ issueNumber: 228, verdicts: [a.verdicts[0]] }]);
  expect(plan.newIssues).toHaveLength(1);
  expect(plan.newIssues[0].verdicts.map((x) => x.beer_id)).toEqual([2]);
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([3, 4]);
  expect(plan.skipped).toBe(0);
});

test('forces labels from verdict classes, ignoring model labels', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, new_issue_key: 'k1', review_class: 'parser_bug' }),
      v({ beer_id: 2, new_issue_key: 'k1', review_class: 'matcher_bug' }),
    ],
    new_issues: [issue('k1')],
  };
  const plan = planTriageActions(a, []);
  expect(plan.newIssues[0].labels.sort())
    .toEqual(['matcher-bug', 'orphan-triage', 'parser-bug']);
});

test('skips invalid verdicts: unknown issue, unknown key, both refs, actionable without ref', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, issue_number: 999 }),                       // not open
      v({ beer_id: 2, new_issue_key: 'ghost' }),                  // no such entry
      v({ beer_id: 3, issue_number: 228, new_issue_key: 'k1' }),  // both refs
      v({ beer_id: 4 }),                                          // actionable, no ref
      v({ beer_id: 5, review_class: 'not_on_untappd', issue_number: 228 }), // quiet class ignores refs
    ],
    new_issues: [issue('k1')],
  };
  const plan = planTriageActions(a, [228]);
  expect(plan.skipped).toBe(4);
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([5]);
  expect(plan.newIssues).toHaveLength(0); // k1 unused → not created
  expect(plan.comments).toHaveLength(0);
});

test('caps new issues at 3 in array order; overflow verdicts are skipped', () => {
  const a: Analysis = {
    verdicts: [1, 2, 3, 4].map((n) => v({ beer_id: n, new_issue_key: `k${n}` })),
    new_issues: [issue('k1'), issue('k2'), issue('k3'), issue('k4')],
  };
  const plan = planTriageActions(a, []);
  expect(plan.newIssues.map((i) => i.key)).toEqual(['k1', 'k2', 'k3']);
  expect(plan.skipped).toBe(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/triage-plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/domain/triage-plan.ts`:

```ts
import type { Analysis, Verdict } from './triage-analysis';

export interface PlannedNewIssue {
  key: string;
  title: string;
  body: string;
  labels: string[];
  verdicts: Verdict[];
}

export interface PlannedComment {
  issueNumber: number;
  verdicts: Verdict[];
}

export interface TriagePlan {
  newIssues: PlannedNewIssue[];   // capped, labels forced, only keys actually referenced
  comments: PlannedComment[];     // grouped per existing issue
  quiet: Verdict[];               // not_on_untappd / wontfix — DB write only
  skipped: number;                // invalid verdicts left untriaged for tomorrow
}

export const MAX_NEW_ISSUES_PER_RUN = 3;

const classLabel: Record<string, string> = {
  parser_bug: 'parser-bug',
  matcher_bug: 'matcher-bug',
};

// Pure validation/routing of the LLM proposal. The LLM only proposes — this is
// where hallucinated issue numbers, ghost keys and issue spam get filtered.
// Skipped verdicts keep review_class NULL and re-enter tomorrow's selection.
export function planTriageActions(analysis: Analysis, openIssueNumbers: number[]): TriagePlan {
  const open = new Set(openIssueNumbers);
  const allowedKeys = new Set(
    analysis.new_issues.slice(0, MAX_NEW_ISSUES_PER_RUN).map((i) => i.key),
  );
  const byKey = new Map<string, Verdict[]>();
  const byIssue = new Map<number, Verdict[]>();
  const quiet: Verdict[] = [];
  let skipped = 0;

  for (const verdict of analysis.verdicts) {
    const actionable = verdict.review_class === 'parser_bug' || verdict.review_class === 'matcher_bug';
    if (!actionable) {
      quiet.push(verdict); // quiet classes never touch GitHub; stray refs are ignored
      continue;
    }
    const hasIssue = verdict.issue_number !== null;
    const hasKey = verdict.new_issue_key !== null;
    if (hasIssue === hasKey) { skipped++; continue; } // both or neither
    if (hasIssue) {
      if (!open.has(verdict.issue_number!)) { skipped++; continue; }
      const list = byIssue.get(verdict.issue_number!) ?? [];
      list.push(verdict);
      byIssue.set(verdict.issue_number!, list);
    } else {
      if (!allowedKeys.has(verdict.new_issue_key!)) { skipped++; continue; }
      const list = byKey.get(verdict.new_issue_key!) ?? [];
      list.push(verdict);
      byKey.set(verdict.new_issue_key!, list);
    }
  }

  const newIssues: PlannedNewIssue[] = analysis.new_issues
    .filter((i) => byKey.has(i.key))
    .map((i) => {
      const verdicts = byKey.get(i.key)!;
      const labels = ['orphan-triage', ...new Set(verdicts.map((x) => classLabel[x.review_class]))];
      return { key: i.key, title: i.title, body: i.body, labels, verdicts };
    });

  const comments: PlannedComment[] = [...byIssue.entries()]
    .map(([issueNumber, verdicts]) => ({ issueNumber, verdicts }));

  return { newIssues, comments, quiet, skipped };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/domain/triage-plan.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-plan.ts src/domain/triage-plan.test.ts
git commit -m "feat(triage): pure action planner with validation and issue cap"
```

---

### Task 5: Infra — GitHub issues client

**Files:**
- Create: `src/infra/github-issues.ts`
- Create: `src/infra/github-issues.test.ts`

- [ ] **Step 1: Write failing tests**

`src/infra/github-issues.test.ts` (mock global `fetch` with `vi.stubGlobal`; unstub in `afterEach`):

```ts
import { afterEach, expect, test, vi } from 'vitest';
import { createGithubIssuesClient } from './github-issues';

afterEach(() => vi.unstubAllGlobals());

const client = () => createGithubIssuesClient({ token: 'tkn', repo: 'o/r' });

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

test('listOpenIssues: filters by label, maps fields, sends auth', async () => {
  const fn = stubFetch(200, [
    { number: 228, title: 'nano-noise', body: 'strip', labels: [{ name: 'orphan-triage' }, { name: 'matcher-bug' }] },
    { number: 229, title: 'nullbody', body: null, labels: [] },
  ]);
  const issues = await client().listOpenIssues('orphan-triage');
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe(
    'https://api.github.com/repos/o/r/issues?state=open&labels=orphan-triage&per_page=100',
  );
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tkn');
  expect(issues).toEqual([
    { number: 228, title: 'nano-noise', body: 'strip', labels: ['orphan-triage', 'matcher-bug'] },
    { number: 229, title: 'nullbody', body: '', labels: [] },
  ]);
});

test('createIssue: POSTs title/body/labels, returns number', async () => {
  const fn = stubFetch(201, { number: 231 });
  const n = await client().createIssue({ title: 't', body: 'b', labels: ['orphan-triage'] });
  expect(n).toBe(231);
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe('https://api.github.com/repos/o/r/issues');
  expect(JSON.parse(init.body as string)).toEqual({ title: 't', body: 'b', labels: ['orphan-triage'] });
});

test('commentOnIssue: POSTs to comments endpoint', async () => {
  const fn = stubFetch(201, { id: 1 });
  await client().commentOnIssue(228, 'hello');
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe('https://api.github.com/repos/o/r/issues/228/comments');
  expect(JSON.parse(init.body as string)).toEqual({ body: 'hello' });
});

test('non-2xx throws with status', async () => {
  stubFetch(403, { message: 'forbidden' });
  await expect(client().listOpenIssues('orphan-triage')).rejects.toThrow(/403/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/infra/github-issues.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/infra/github-issues.ts`:

```ts
import type { OpenIssue } from '../domain/triage-analysis';

export interface GithubIssuesClient {
  listOpenIssues(label: string): Promise<OpenIssue[]>;
  createIssue(i: { title: string; body: string; labels: string[] }): Promise<number>;
  commentOnIssue(issueNumber: number, body: string): Promise<void>;
}

// Minimal GitHub REST client (plain fetch, same style as scripts/ai-pr-review.ts).
// The triage job files at most a handful of requests per day, so no pagination
// beyond per_page=100 and no rate-limit handling — a failure surfaces in the
// digest and retries tomorrow.
export function createGithubIssuesClient(cfg: { token: string; repo: string }): GithubIssuesClient {
  const base = `https://api.github.com/repos/${cfg.repo}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'warsaw-beer-bot-triage',
  };

  async function call<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) throw new Error(`GitHub ${init?.method ?? 'GET'} ${url}: ${res.status}`);
    return res.json() as Promise<T>;
  }

  return {
    async listOpenIssues(label) {
      type Raw = { number: number; title: string; body: string | null; labels: { name: string }[] };
      const raw = await call<Raw[]>(`${base}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`);
      return raw.map((r) => ({
        number: r.number, title: r.title, body: r.body ?? '',
        labels: r.labels.map((l) => l.name),
      }));
    },
    async createIssue(i) {
      const r = await call<{ number: number }>(`${base}/issues`, {
        method: 'POST', body: JSON.stringify(i),
      });
      return r.number;
    },
    async commentOnIssue(issueNumber, body) {
      await call(`${base}/issues/${issueNumber}/comments`, {
        method: 'POST', body: JSON.stringify({ body }),
      });
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/infra/github-issues.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/infra/github-issues.ts src/infra/github-issues.test.ts
git commit -m "feat(triage): GitHub issues REST client"
```

---

### Task 6: Infra — TriageLlm providers

**Files:**
- Create: `src/infra/triage-llm.ts`
- Create: `src/infra/triage-llm.test.ts`
- Modify: `package.json` (new dep)

- [ ] **Step 1: Install the Anthropic SDK**

Run: `npm install @anthropic-ai/sdk`
Expected: added to `dependencies` in `package.json`.

- [ ] **Step 2: Write failing tests**

`src/infra/triage-llm.test.ts` — the Anthropic implementation takes the SDK client via an injectable factory so tests never construct the real client; the OpenAI implementation is fetch-based and tested with a stubbed `fetch`:

```ts
import { afterEach, expect, test, vi } from 'vitest';
import { createOpenAiTriageLlm, createAnthropicTriageLlm, createTriageLlm } from './triage-llm';
import type { TriageInput } from '../domain/triage-analysis';

afterEach(() => vi.unstubAllGlobals());

const input: TriageInput = { orphans: [], openIssues: [] };
const validAnalysis = { verdicts: [], new_issues: [] };

test('openai: sends JSON-mode request, parses and validates content', async () => {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(validAnalysis) } }],
  }), { status: 200 }));
  vi.stubGlobal('fetch', fn);
  const llm = createOpenAiTriageLlm({ apiKey: 'k', model: 'gpt-4o-mini' });
  const out = await llm.analyze(input);
  expect(out).toEqual(validAnalysis);
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
  const body = JSON.parse(init.body as string);
  expect(body.model).toBe('gpt-4o-mini');
  expect(body.response_format).toEqual({ type: 'json_object' });
});

test('openai: schema-violating content throws', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: '{"verdicts": [{"beer_id": "oops"}]}' } }],
  }), { status: 200 })));
  const llm = createOpenAiTriageLlm({ apiKey: 'k', model: 'gpt-4o-mini' });
  await expect(llm.analyze(input)).rejects.toThrow();
});

test('anthropic: extracts tool_use input and validates', async () => {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: 'submit_triage', input: validAnalysis }],
  });
  const llm = createAnthropicTriageLlm(
    { apiKey: 'k', model: 'claude-opus-4-8' },
    () => ({ messages: { create } }) as never,
  );
  const out = await llm.analyze(input);
  expect(out).toEqual(validAnalysis);
  expect(create.mock.calls[0][0].tool_choice).toEqual({ type: 'tool', name: 'submit_triage' });
});

test('anthropic: missing tool_use block throws', async () => {
  const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'nope' }] });
  const llm = createAnthropicTriageLlm(
    { apiKey: 'k', model: 'claude-opus-4-8' },
    () => ({ messages: { create } }) as never,
  );
  await expect(llm.analyze(input)).rejects.toThrow(/tool_use/);
});

test('factory: null when key for the chosen provider is missing', () => {
  const base = { TRIAGE_LLM_PROVIDER: 'anthropic', TRIAGE_LLM_MODEL: 'm' };
  expect(createTriageLlm({ ...base } as never)).toBeNull();
  expect(createTriageLlm({ ...base, ANTHROPIC_API_KEY: 'k' } as never)).not.toBeNull();
  expect(createTriageLlm({
    TRIAGE_LLM_PROVIDER: 'openai', TRIAGE_LLM_MODEL: 'm', OPENAI_API_KEY: 'k',
  } as never)).not.toBeNull();
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/infra/triage-llm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/infra/triage-llm.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import {
  ANALYSIS_TOOL_SCHEMA, AnalysisSchema, buildTriagePrompt,
  type Analysis, type TriageInput,
} from '../domain/triage-analysis';
import type { Env } from '../config/env';

export interface TriageLlm {
  /** Throws on transport error, missing/invalid structured output. */
  analyze(input: TriageInput): Promise<Analysis>;
}

const TOOL_NAME = 'submit_triage';
const MAX_TOKENS = 8000;

type AnthropicFactory = (apiKey: string) => Pick<Anthropic, 'messages'>;

export function createAnthropicTriageLlm(
  cfg: { apiKey: string; model: string },
  factory: AnthropicFactory = (apiKey) => new Anthropic({ apiKey }),
): TriageLlm {
  const client = factory(cfg.apiKey);
  return {
    async analyze(input) {
      const res = await client.messages.create({
        model: cfg.model,
        max_tokens: MAX_TOKENS,
        tools: [{
          name: TOOL_NAME,
          description: 'Submit the triage verdicts for all orphans.',
          input_schema: ANALYSIS_TOOL_SCHEMA as never,
          strict: true,
        } as never],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [{ role: 'user', content: buildTriagePrompt(input) }],
      });
      const block = res.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') {
        throw new Error(`triage LLM: no tool_use block in response (stop_reason=${res.stop_reason})`);
      }
      return AnalysisSchema.parse(block.input);
    },
  };
}

export function createOpenAiTriageLlm(
  cfg: { apiKey: string; model: string; endpoint?: string },
): TriageLlm {
  const endpoint = cfg.endpoint ?? 'https://api.openai.com/v1';
  return {
    async analyze(input) {
      const res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Respond with a single JSON object matching the requested shape: {"verdicts": [...], "new_issues": [...]}.' },
            { role: 'user', content: buildTriagePrompt(input) },
          ],
        }),
      });
      if (!res.ok) throw new Error(`triage LLM: OpenAI HTTP ${res.status}`);
      const data = await res.json() as { choices: { message: { content: string } }[] };
      return AnalysisSchema.parse(JSON.parse(data.choices[0].message.content));
    },
  };
}

// null ⇒ triage disabled (missing key for the chosen provider); the job reports
// this in the digest rather than crashing startup.
export function createTriageLlm(env: Env): TriageLlm | null {
  if (env.TRIAGE_LLM_PROVIDER === 'openai') {
    return env.OPENAI_API_KEY
      ? createOpenAiTriageLlm({ apiKey: env.OPENAI_API_KEY, model: env.TRIAGE_LLM_MODEL })
      : null;
  }
  return env.ANTHROPIC_API_KEY
    ? createAnthropicTriageLlm({ apiKey: env.ANTHROPIC_API_KEY, model: env.TRIAGE_LLM_MODEL })
    : null;
}
```

Note: the two `as never` casts on the tool definition are there because the SDK's non-beta types may lag the `strict` field; if `npx tsc --noEmit` passes without them, remove them.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/infra/triage-llm.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/infra/triage-llm.ts src/infra/triage-llm.test.ts package.json package-lock.json
git commit -m "feat(triage): TriageLlm with Anthropic and OpenAI providers"
```

---

### Task 7: Job — orchestrator

**Files:**
- Create: `src/jobs/orphan-triage.ts`
- Create: `src/jobs/orphan-triage.test.ts`

- [ ] **Step 1: Write failing tests**

`src/jobs/orphan-triage.test.ts`:

```ts
import pino from 'pino';
import { expect, test, vi } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { getJobState } from '../storage/job_state';
import { recordEnrichFailure } from '../storage/enrich_failures';
import {
  orphanTriage, shouldRunTriage, buildTriageLine,
  TRIAGE_LAST_RUN_KEY, TRIAGE_LAST_RESULT_KEY,
} from './orphan-triage';
import type { Analysis } from '../domain/triage-analysis';

const log = pino({ level: 'silent' });
// Warsaw 07:30 on 2026-07-05 (CEST = UTC+2) → 05:30Z
const inWindow = () => new Date('2026-07-05T05:30:00Z');

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}
// Insert a beers row + enrich failure (adapt the INSERT to the actual beers
// schema — copy from enrich_failures.test.ts).
function seedOrphan(d: ReturnType<typeof db>, beerId: number) {
  insertBeer(d, beerId);
  recordEnrichFailure(d, {
    beer_id: beerId, brewery: `Br${beerId}`, name: `Beer${beerId}`,
    search_url: 'u', source_url: '', outcome: 'not_found',
    candidates_count: 0, candidates_summary: '', at: `2026-07-0${beerId}T00:00:00Z`,
  });
}

const gh = (over = {}) => ({
  listOpenIssues: vi.fn().mockResolvedValue([{ number: 228, title: 't', body: 'b', labels: [] }]),
  createIssue: vi.fn().mockResolvedValue(231),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  ...over,
});
const llm = (analysis: Analysis) => ({ analyze: vi.fn().mockResolvedValue(analysis) });

test('shouldRunTriage: window and idempotency', () => {
  expect(shouldRunTriage({ now: inWindow(), lastRunDate: null }))
    .toEqual({ run: true, dateKey: '2026-07-05' });
  expect(shouldRunTriage({ now: inWindow(), lastRunDate: '2026-07-05' }).run).toBe(false);
  // 10:30 Warsaw = 08:30Z → outside [6,9)
  expect(shouldRunTriage({ now: new Date('2026-07-05T08:30:00Z'), lastRunDate: null }).run).toBe(false);
});

test('happy path: comment + new issue + quiet; DB and job_state written', async () => {
  const d = db();
  [1, 2, 3].forEach((n) => seedOrphan(d, n));
  const analysis: Analysis = {
    verdicts: [
      { beer_id: 3, review_class: 'matcher_bug', review_note: 'alias', issue_number: 228, new_issue_key: null },
      { beer_id: 2, review_class: 'parser_bug', review_note: 'merch', issue_number: null, new_issue_key: 'k1' },
      { beer_id: 1, review_class: 'not_on_untappd', review_note: 'small batch', issue_number: null, new_issue_key: null },
    ],
    new_issues: [{ key: 'k1', title: 'Adapter noise', body: 'b', labels: [] }],
  };
  const github = gh();
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });

  expect(github.commentOnIssue).toHaveBeenCalledTimes(1);
  expect(github.createIssue).toHaveBeenCalledWith(
    expect.objectContaining({ labels: ['orphan-triage', 'parser-bug'] }),
  );
  const rows = d.prepare(
    'SELECT beer_id, review_class, review_note FROM enrich_failures ORDER BY beer_id',
  ).all() as { beer_id: number; review_class: string; review_note: string }[];
  expect(rows.map((r) => r.review_class)).toEqual(['not_on_untappd', 'parser_bug', 'matcher_bug']);
  expect(rows[1].review_note).toBe('merch → #231');
  expect(rows[2].review_note).toBe('alias → #228');
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.date).toBe('2026-07-05');
  expect(result.line).toContain('3 нових');
});

test('github comment failure: affected orphan stays untriaged, others proceed', async () => {
  const d = db();
  [1, 2].forEach((n) => seedOrphan(d, n));
  const analysis: Analysis = {
    verdicts: [
      { beer_id: 1, review_class: 'matcher_bug', review_note: 'x', issue_number: 228, new_issue_key: null },
      { beer_id: 2, review_class: 'wontfix', review_note: 'y', issue_number: null, new_issue_key: null },
    ],
    new_issues: [],
  };
  const github = gh({ commentOnIssue: vi.fn().mockRejectedValue(new Error('boom')) });
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });
  const cls = (id: number) => (d.prepare(
    'SELECT review_class FROM enrich_failures WHERE beer_id = ?',
  ).get(id) as { review_class: string | null }).review_class;
  expect(cls(1)).toBeNull();   // GitHub failed → no DB write
  expect(cls(2)).toBe('wontfix');
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.line).toContain('пропущено');
});

test('LLM failure: nothing written except error result line', async () => {
  const d = db();
  seedOrphan(d, 1);
  const github = gh();
  await orphanTriage({
    db: d, log, github, now: inWindow,
    llm: { analyze: vi.fn().mockRejectedValue(new Error('invalid json')) },
  });
  expect(github.createIssue).not.toHaveBeenCalled();
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('помилка');
  // run is still marked so we don't hammer a broken LLM every 15 min
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
});

test('disabled (no llm/github): skip line written once', async () => {
  const d = db();
  await orphanTriage({ db: d, log, llm: null, github: null, now: inWindow });
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('вимкнено');
});

test('no untriaged orphans: nothing-to-do line, no LLM call', async () => {
  const d = db();
  const theLlm = llm({ verdicts: [], new_issues: [] });
  const github = gh();
  await orphanTriage({ db: d, log, llm: theLlm, github, now: inWindow });
  expect(theLlm.analyze).not.toHaveBeenCalled();
  expect(github.listOpenIssues).not.toHaveBeenCalled();
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('0 нових');
});

test('buildTriageLine formats counts', () => {
  expect(buildTriageLine({
    total: 7, commented: [{ issueNumber: 228, count: 2 }], created: [{ issueNumber: 232, count: 1 }],
    notOnUntappd: 3, wontfix: 0, skipped: 1, error: null, disabledReason: null,
  })).toBe('Тріаж: 7 нових → 2 до #228, 1 нова #232, 3 not_on_untappd, 1 пропущено');
  expect(buildTriageLine({
    total: 0, commented: [], created: [], notOnUntappd: 0, wontfix: 0,
    skipped: 0, error: 'invalid json', disabledReason: null,
  })).toBe('Тріаж: помилка (invalid json)');
  expect(buildTriageLine({
    total: 0, commented: [], created: [], notOnUntappd: 0, wontfix: 0,
    skipped: 0, error: null, disabledReason: 'нема GITHUB_TOKEN',
  })).toBe('Тріаж: вимкнено (нема GITHUB_TOKEN)');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/jobs/orphan-triage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/jobs/orphan-triage.ts`:

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import { getJobState, setJobState } from '../storage/job_state';
import {
  selectUntriagedFailures, setEnrichFailureReview, type UntriagedFailure,
} from '../storage/enrich_failures';
import type { TriageLlm } from '../infra/triage-llm';
import type { GithubIssuesClient } from '../infra/github-issues';
import { planTriageActions } from '../domain/triage-plan';
import type { Verdict } from '../domain/triage-analysis';

export const TRIAGE_LAST_RUN_KEY = 'orphan_triage_last_run';
export const TRIAGE_LAST_RESULT_KEY = 'orphan_triage_last_result';
export const TRIAGE_LABEL = 'orphan-triage';
export const TRIAGE_BATCH_LIMIT = 50;

// Same Warsaw-window pattern as daily-status, but earlier — [06:00,09:00) — so
// the result line is ready before the digest window [09:00,12:00).
function warsawDateAndHour(d: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)!.value;
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

export function shouldRunTriage(args: {
  now: Date; lastRunDate: string | null;
  windowStartHour?: number; windowEndHour?: number;
}): { run: boolean; dateKey: string } {
  const { now, lastRunDate, windowStartHour = 6, windowEndHour = 9 } = args;
  const { date, hour } = warsawDateAndHour(now);
  const inWindow = hour >= windowStartHour && hour < windowEndHour;
  return { run: inWindow && lastRunDate !== date, dateKey: date };
}

export interface TriageOutcome {
  total: number;
  commented: { issueNumber: number; count: number }[];
  created: { issueNumber: number; count: number }[];
  notOnUntappd: number;
  wontfix: number;
  skipped: number;
  error: string | null;
  disabledReason: string | null;
}

export function buildTriageLine(o: TriageOutcome): string {
  if (o.disabledReason) return `Тріаж: вимкнено (${o.disabledReason})`;
  if (o.error) return `Тріаж: помилка (${o.error})`;
  const parts: string[] = [
    ...o.commented.map((c) => `${c.count} до #${c.issueNumber}`),
    ...o.created.map((c) => `${c.count} нова #${c.issueNumber}`),
  ];
  if (o.notOnUntappd > 0) parts.push(`${o.notOnUntappd} not_on_untappd`);
  if (o.wontfix > 0) parts.push(`${o.wontfix} wontfix`);
  if (o.skipped > 0) parts.push(`${o.skipped} пропущено`);
  return `Тріаж: ${o.total} нових${parts.length ? ` → ${parts.join(', ')}` : ''}`;
}

function exampleTable(verdicts: Verdict[], orphans: Map<number, UntriagedFailure>): string {
  const rows = verdicts.map((v) => {
    const o = orphans.get(v.beer_id);
    return `| ${v.beer_id} | ${o?.brewery ?? '?'} | ${o?.name ?? '?'} | ${v.review_class} | ${v.review_note} |`;
  });
  return ['| beer_id | brewery | name | class | note |', '|---|---|---|---|---|', ...rows].join('\n');
}

export interface OrphanTriageDeps {
  db: DB;
  log: pino.Logger;
  llm: TriageLlm | null;
  github: GithubIssuesClient | null;
  now?: () => Date;
}

// Daily orphan triage. Cron-safe: window + job_state make it run once per Warsaw
// day. The LLM proposes; planTriageActions validates; this function executes with
// GitHub-first-DB-second ordering so a GitHub failure leaves orphans untriaged
// (they re-enter tomorrow's batch). Result line is persisted for the digest.
export async function orphanTriage(deps: OrphanTriageDeps): Promise<void> {
  const { db, log, llm, github } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const { run, dateKey } = shouldRunTriage({ now, lastRunDate: getJobState(db, TRIAGE_LAST_RUN_KEY) });
  if (!run) return;

  const finish = (outcome: TriageOutcome): void => {
    setJobState(db, TRIAGE_LAST_RUN_KEY, dateKey);
    setJobState(db, TRIAGE_LAST_RESULT_KEY,
      JSON.stringify({ date: dateKey, line: buildTriageLine(outcome) }));
    log.info({ outcome, dateKey }, 'orphan-triage finished');
  };
  const empty: TriageOutcome = {
    total: 0, commented: [], created: [], notOnUntappd: 0, wontfix: 0,
    skipped: 0, error: null, disabledReason: null,
  };

  if (!llm || !github) {
    finish({ ...empty, disabledReason: !llm ? 'нема ключа LLM' : 'нема GITHUB_TOKEN' });
    return;
  }

  const orphans = selectUntriagedFailures(db, TRIAGE_BATCH_LIMIT);
  if (orphans.length === 0) {
    finish(empty);
    return;
  }
  const byId = new Map(orphans.map((o) => [o.beer_id, o]));
  const outcome: TriageOutcome = { ...empty, total: orphans.length };
  const nowIso = now.toISOString();

  let plan;
  try {
    const openIssues = await github.listOpenIssues(TRIAGE_LABEL);
    const analysis = await llm.analyze({ orphans, openIssues });
    plan = planTriageActions(analysis, openIssues.map((i) => i.number));
  } catch (e) {
    log.error({ err: e }, 'orphan-triage: analysis failed');
    finish({ ...outcome, error: (e as Error).message.slice(0, 120) });
    return;
  }
  outcome.skipped = plan.skipped;

  const review = (v: Verdict, issueNumber: number | null): void => {
    const note = issueNumber === null ? v.review_note : `${v.review_note} → #${issueNumber}`;
    setEnrichFailureReview(db, v.beer_id, v.review_class, note, nowIso);
  };

  for (const issue of plan.newIssues) {
    try {
      const number = await github.createIssue({ title: issue.title, body: issue.body, labels: issue.labels });
      issue.verdicts.forEach((v) => review(v, number));
      outcome.created.push({ issueNumber: number, count: issue.verdicts.length });
    } catch (e) {
      log.error({ err: e, key: issue.key }, 'orphan-triage: createIssue failed');
      outcome.skipped += issue.verdicts.length;
    }
  }

  for (const c of plan.comments) {
    try {
      const body = `Автотріаж ${dateKey}: +${c.verdicts.length} нових прикладів\n\n${exampleTable(c.verdicts, byId)}`;
      await github.commentOnIssue(c.issueNumber, body);
      c.verdicts.forEach((v) => review(v, c.issueNumber));
      outcome.commented.push({ issueNumber: c.issueNumber, count: c.verdicts.length });
    } catch (e) {
      log.error({ err: e, issue: c.issueNumber }, 'orphan-triage: comment failed');
      outcome.skipped += c.verdicts.length;
    }
  }

  for (const v of plan.quiet) {
    review(v, null);
    if (v.review_class === 'not_on_untappd') outcome.notOnUntappd++;
    else outcome.wontfix++;
  }

  finish(outcome);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/jobs/orphan-triage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts
git commit -m "feat(triage): orphan-triage job orchestrator"
```

---

### Task 8: Daily-status digest line

**Files:**
- Modify: `src/jobs/daily-status.ts`
- Modify: `src/jobs/daily-status.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/jobs/daily-status.test.ts`:

```ts
test('buildStatusMessage: includes triage line when provided', () => {
  const out = buildStatusMessage(base, '2026-07-05 09:00', 'Тріаж: 7 нових → 2 до #228');
  const lines = out.split('\n');
  const enrichIdx = lines.findIndex((l) => l.startsWith('• Enrich:'));
  expect(lines[enrichIdx + 1]).toBe('• Тріаж: 7 нових → 2 до #228');
});

test('buildStatusMessage: no triage line when null/omitted', () => {
  expect(buildStatusMessage(base, '2026-07-05 09:00')).not.toContain('Тріаж');
  expect(buildStatusMessage(base, '2026-07-05 09:00', null)).not.toContain('Тріаж');
});

test('dailyStatus: picks up today\'s triage result from job_state', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const now = () => new Date('2026-07-05T07:30:00Z'); // 09:30 Warsaw
  setJobState(db, 'orphan_triage_last_result',
    JSON.stringify({ date: '2026-07-05', line: 'Тріаж: 1 нових' }));
  await dailyStatus({ db, log: silentLog, notifyAdmin: async (m) => { sent.push(m); }, now });
  expect(sent[0]).toContain('• Тріаж: 1 нових');
});

test('dailyStatus: stale (yesterday) triage result is ignored', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const now = () => new Date('2026-07-05T07:30:00Z');
  setJobState(db, 'orphan_triage_last_result',
    JSON.stringify({ date: '2026-07-04', line: 'Тріаж: 9 нових' }));
  await dailyStatus({ db, log: silentLog, notifyAdmin: async (m) => { sent.push(m); }, now });
  expect(sent[0]).not.toContain('Тріаж');
});
```

(Import `setJobState` and `TRIAGE_LAST_RESULT_KEY`-style literal as shown; `emptyDb`/`silentLog`/`base` already exist in this test file.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/jobs/daily-status.test.ts`
Expected: FAIL — new tests fail (extra param ignored / no triage line).

- [ ] **Step 3: Implement**

In `src/jobs/daily-status.ts`:

1. Extend the signature: `export function buildStatusMessage(m: StatusMetrics, date: string, triageLine?: string | null): string` and insert after the `• Enrich:` line:

```ts
    ...(triageLine ? [`• ${triageLine}`] : []),
```

(i.e. change the static array literal to include this spread between the Enrich and БД lines.)

2. In `dailyStatus`, after computing `dateKey`, read the triage result:

```ts
import { TRIAGE_LAST_RESULT_KEY } from './orphan-triage';
```

```ts
  // Triage line: written by the orphan-triage job (earlier Warsaw window) into
  // job_state; only shown when it belongs to today's digest date.
  let triageLine: string | null = null;
  const rawTriage = getJobState(db, TRIAGE_LAST_RESULT_KEY);
  if (rawTriage) {
    try {
      const parsed = JSON.parse(rawTriage) as { date: string; line: string };
      if (parsed.date === dateKey) triageLine = parsed.line;
    } catch { /* malformed state — ignore */ }
  }
  const text = buildStatusMessage(metrics, warsawStamp(now), triageLine);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/jobs/daily-status.test.ts`
Expected: PASS (existing exact-string tests untouched — the new param is optional).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "feat(triage): triage line in daily-status digest"
```

---

### Task 9: Wiring in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Wire the job**

Imports:

```ts
import { orphanTriage } from './jobs/orphan-triage';
import { createTriageLlm } from './infra/triage-llm';
import { createGithubIssuesClient } from './infra/github-issues';
```

After `notifyAdmin` is defined (near the other client setup, ~line 125):

```ts
  // Orphan-triage clients. Either may be null (missing key) — the job then
  // records a "disabled" result once per day instead of crashing.
  const triageLlm = createTriageLlm(env);
  const triageGithub = env.GITHUB_TOKEN
    ? createGithubIssuesClient({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO })
    : null;
  if (!triageLlm) log.warn('orphan-triage LLM disabled (missing provider API key)');
  if (!triageGithub) log.warn('orphan-triage GitHub disabled (GITHUB_TOKEN not set)');
```

In the `cronJobs` array, next to the daily-status tick (same UTC-tick rationale — node-cron timezone schedules are flaky):

```ts
    // orphan-triage: daily LLM triage of enrich_failures, Warsaw [06:00,09:00)
    // window + job_state idempotency inside the job. Same UTC-tick pattern as
    // daily-status.
    cron.schedule('*/15 * * * *', () => {
      orphanTriage({ db, log, llm: triageLlm, github: triageGithub })
        .catch((e) => log.error({ err: e }, 'orphan-triage cron'));
    }),
```

Next to the daily-status startup catch-up (~line 251):

```ts
  orphanTriage({ db, log, llm: triageLlm, github: triageGithub })
    .catch((e) => log.error({ err: e }, 'orphan-triage startup'));
```

- [ ] **Step 2: Typecheck + full test suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(triage): schedule orphan-triage job"
```

---

### Task 10: Documentation

**Files:**
- Modify: `spec.md`
- Modify: `docs/debug-orphan-matching.md`

- [ ] **Step 1: spec.md — new §5.11**

Add after §5.10, following the spec's existing tone/structure:

```markdown
### 5.11 Щоденний тріаж orphans (LLM-агент)

- Раз на день (варшавське вікно 06:00–09:00, UTC-тік + `job_state` ідемпотентність,
  як у daily-status) джоба `orphan-triage` бере **50 найновіших** рядків
  `enrich_failures` з `review_class IS NULL AND outcome='not_found'`
  (`blocked` — проблема проксі, не матчингу) і віддає їх LLM разом із відкритими
  GitHub-issues з міткою `orphan-triage`.
- LLM класифікує кожен orphan (`parser_bug` / `matcher_bug` / `not_on_untappd` /
  `wontfix`) і кластеризує actionable-класи в патерни: коментар до наявної issue
  або нова issue (**≤3 нових за запуск**; мітки примусово `orphan-triage` +
  `parser-bug`/`matcher-bug`).
- **LLM лише пропонує** — скрипт валідує (клас із CHECK-списку, номер issue з
  відкритого списку) і виконує. Порядок на orphan: спочатку GitHub, потім запис
  `review_class`/`review_note` у БД; збій GitHub лишає orphan нетріаженим на завтра.
- Класи `not_on_untappd`/`wontfix` — тихі: лише запис у БД, без GitHub. Людське
  рішення відбувається на рівні GitHub-issues, не сирих помилок.
- Провайдер/модель конфігуруються: `TRIAGE_LLM_PROVIDER` (`anthropic`|`openai`),
  `TRIAGE_LLM_MODEL` (дефолт `claude-opus-4-8`), ключі `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY`, `GITHUB_TOKEN` + `GITHUB_REPO`. Відсутній ключ = джоба
  вимкнена (не падає), що видно в digest.
- Результат запуску — рядок у daily-status digest (через `job_state`,
  ключ `orphan_triage_last_result`): «Тріаж: 7 нових → 2 до #228, 1 нова #232,
  3 not_on_untappd, 1 пропущено», або «помилка (…)» / «вимкнено (…)».
- Мітки `orphan-triage`, `parser-bug`, `matcher-bug` мають існувати в репо
  (джоба їх не створює).
```

- [ ] **Step 2: docs/debug-orphan-matching.md — note**

Add near the top (after the intro paragraph):

```markdown
> **Автоматичний первинний тріаж (з 2026-07):** джоба `orphan-triage` щодня
> класифікує нові orphans (`review_class`/`review_note`) і створює/оновлює
> GitHub-issues з міткою `orphan-triage`. Цей ранбук лишається для глибших
> розслідувань, перевірки вердиктів агента та спірних випадків — але починати
> варто з відкритих `orphan-triage` issues, а не з сирої таблиці.
```

- [ ] **Step 3: Commit**

```bash
git add spec.md docs/debug-orphan-matching.md
git commit -m "docs(triage): spec §5.11 + runbook note for automated triage"
```

---

### Task 11: Finish

- [ ] **Step 1: Full verification**

Run: `npx tsc --noEmit && npm test`
Expected: clean.

- [ ] **Step 2: Create the GitHub labels (one-time op, from the main checkout or any machine with gh)**

Put the commands in `./tmp/create-labels.sh` for the user (per CLAUDE.md the user runs shell commands from files under `./tmp/`):

```bash
#!/usr/bin/env bash
set -euo pipefail
gh label create orphan-triage --color 5319e7 --description "Auto-filed orphan triage patterns" || true
gh label create parser-bug   --color d93f0b --description "Shop adapter produced garbage rows" || true
gh label create matcher-bug  --color 0e8a16 --description "Matcher/alias missed an existing Untappd beer" || true
```

- [ ] **Step 3: Integrate**

Use `superpowers:finishing-a-development-branch`: push branch, open PR, then follow the PR review loop (wait for AI review, critically assess, fix/push back — per `feedback_pr_review_loop`).

**PR checklist reminders:**
- spec.md updated in same PR ✅ (Task 10)
- No `extension/**` changes ⇒ `docs/extension-install-uk.md` not needed
- After merge+deploy: add `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` to prod `.env` **as the bot user, additively via scripts/set-env.sh** (see `reference_env_config_ops`); run `./tmp/create-labels.sh` once; clean `./tmp/` when done.

---

## Self-review notes

- **Spec coverage:** selection (Task 2), LLM analysis + structured output (Tasks 3, 6), validation/cap/labels (Task 4), GitHub ops (Task 5), GitHub-first-DB-second + digest result + error handling (Task 7), digest line (Task 8), scheduling UTC-tick/window/catch-up (Tasks 7, 9), env/provider abstraction (Tasks 1, 6), docs (Task 10), ops notes (Task 11).
- **Type consistency:** `Verdict`/`Analysis`/`TriageInput`/`OpenIssue` defined once in `triage-analysis.ts` and imported everywhere; `UntriagedFailure` from storage; `TriageLlm`/`GithubIssuesClient` interfaces consumed by the job via DI.
- **Known judgment calls:** flattened verdict shape (documented deviation, top of plan); `error`-path still stamps `orphan_triage_last_run` so a broken LLM isn't hammered every 15 minutes (retry is next day, matching the spec's "retry is tomorrow's run").
