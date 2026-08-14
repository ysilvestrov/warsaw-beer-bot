# #408 Part A — Deterministic Verdict Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the orphan-triage agent from applying a consequence the row's own evidence contradicts, by adding four deterministic guards to `planTriageActions` and giving every triage issue a machine-readable scope.

**Architecture:** A new pure module `src/domain/triage-scope.ts` owns the scope type, its legality rule, its row-satisfaction check, and the render/parse of the ` ```triage-scope ` block we write into issue bodies. `planTriageActions` gains the issues' scopes, the batch rows and the probe map so it can judge what it is routing; it stays a pure function — all I/O (listing issues, parsing bodies, counting rows) happens at the call site in `src/jobs/orphan-triage.ts`. A new column `enrich_failures.issue_number` (migration v23) replaces the free-text `→ #N` convention so per-issue row counts become queryable.

**Tech Stack:** TypeScript, Vitest (globals enabled — bare `test()`/`expect()`), better-sqlite3, zod, Anthropic strict tool use.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-14-408-triage-verdict-guards-design.md`

---

## Before you start

This repo runs the whole suite with `npm test` (vitest run). A single file is
`npx vitest run src/domain/triage-scope.test.ts`. Type checking is `npm run typecheck`.

**Worktree guard — run this before your first commit and after every commit:**

```bash
git rev-parse --show-toplevel   # MUST be the worktree path, not /home/ysi/warsaw-beer-bot
git branch --show-current       # MUST be the feature branch, not main
```

If either is wrong, stop and report — do not commit.

The design doc for this work lives on branch `docs/408-verdict-guards-design` (PR #414), which is
not yet on `main`. Cherry-pick commit `200696f` into the worktree so the spec travels with the code.

## File structure

| file | responsibility |
|---|---|
| `src/domain/triage-scope.ts` | **new** — `Scope` type, `isLegalScope`, `rowSatisfiesScope`, `renderScopeBlock`, `parseScopeBlock`. Pure, no imports from storage or jobs. |
| `src/domain/triage-scope.test.ts` | **new** — unit tests for the above |
| `src/domain/triage-analysis.ts` | add the structured `scope` field to `AnalysisSchema.new_issues` + `ANALYSIS_TOOL_SCHEMA`; change the prompt's Scope instruction |
| `src/domain/triage-plan.ts` | the four guards; new signature; `guardHits` on the plan |
| `src/storage/schema.ts` | migration v23 |
| `src/storage/enrich_failures.ts` | write + read `issue_number` |
| `src/jobs/orphan-triage.ts` | build `ScopedIssue[]`, render the block into created bodies, log guard reasons |

---

### Task 1: Scope type, legality, and row satisfaction

**Files:**
- Create: `src/domain/triage-scope.ts`
- Test: `src/domain/triage-scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/triage-scope.test.ts
import { isLegalScope, rowSatisfiesScope, type Scope } from './triage-scope';
import type { UntriagedFailure } from '../storage/enrich_failures';

const row = (over: Partial<UntriagedFailure> = {}): UntriagedFailure => ({
  beer_id: 1, brewery: 'Mad Brew', name: 'Bulgogi', search_url: 'https://x/?q=a',
  source_url: 'https://flasker.com.ua/p/1', candidates_count: 3, candidates_summary: '',
  fail_count: 1, last_at: '2026-08-14T00:00:00.000Z', abv: 4.2, style: 'IPA', ...over,
});

test('a where-scope of review_class alone is illegal', () => {
  const scope: Scope = { beer_ids: [], where: [{ col: 'review_class', op: '=', value: 'matcher_bug' }] };
  expect(isLegalScope(scope)).toBe(false);
});

test('review_class plus one other column is legal', () => {
  const scope: Scope = {
    beer_ids: [],
    where: [
      { col: 'review_class', op: '=', value: 'matcher_bug' },
      { col: 'candidates_count', op: '=', value: 0 },
    ],
  };
  expect(isLegalScope(scope)).toBe(true);
});

test('an enumerated cohort alone is legal', () => {
  expect(isLegalScope({ beer_ids: [34005, 11952], where: [] })).toBe(true);
});

test('an empty scope is illegal', () => {
  expect(isLegalScope({ beer_ids: [], where: [] })).toBe(false);
});

test('a row in beer_ids satisfies the scope regardless of where', () => {
  const scope: Scope = { beer_ids: [1], where: [{ col: 'candidates_count', op: '=', value: 0 }] };
  expect(rowSatisfiesScope(row({ candidates_count: 9 }), 'matcher_bug', scope)).toBe(true);
});

test('a zero-candidate row does not satisfy a candidates_count > 0 scope', () => {
  const scope: Scope = { beer_ids: [], where: [{ col: 'candidates_count', op: '>', value: 0 }] };
  expect(rowSatisfiesScope(row({ candidates_count: 0 }), 'matcher_bug', scope)).toBe(false);
});

test('review_class is matched against the verdict class, not the row', () => {
  const scope: Scope = {
    beer_ids: [],
    where: [
      { col: 'review_class', op: '=', value: 'parser_bug' },
      { col: 'source_url', op: 'contains', value: 'flasker' },
    ],
  };
  expect(rowSatisfiesScope(row(), 'parser_bug', scope)).toBe(true);
  expect(rowSatisfiesScope(row(), 'matcher_bug', scope)).toBe(false);
});

test('an empty where never satisfies vacuously', () => {
  expect(rowSatisfiesScope(row(), 'matcher_bug', { beer_ids: [2], where: [] })).toBe(false);
});

test('string and null operators', () => {
  expect(rowSatisfiesScope(row({ brewery: '' }), 'matcher_bug',
    { beer_ids: [], where: [{ col: 'brewery', op: 'empty' }] })).toBe(true);
  expect(rowSatisfiesScope(row({ abv: null }), 'matcher_bug',
    { beer_ids: [], where: [{ col: 'abv', op: 'is_null' }] })).toBe(true);
  expect(rowSatisfiesScope(row({ style: 'IPA' }), 'matcher_bug',
    { beer_ids: [], where: [{ col: 'style', op: 'is_not_null' }] })).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/triage-scope.test.ts`
Expected: FAIL — cannot resolve `./triage-scope`.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/triage-scope.ts
import { z } from 'zod';
import type { UntriagedFailure } from '../storage/enrich_failures';
import { REVIEW_CLASSES } from './triage-analysis';

// The scope is a NECESSARY CONDITION, never a definition of the mechanism. Most real
// triage patterns (shop typos, packaging tokens, "the brewery field isn't a brewery")
// cannot be expressed as a column predicate at all. So a scope answers exactly one
// question — does this row provably CONTRADICT the issue? — and the guard rejects on
// contradiction. It never asserts that a row belongs.
export const NUMERIC_COLS = ['candidates_count', 'fail_count'] as const;
export const TEXT_COLS = ['source_url', 'brewery', 'name'] as const;
export const NULLABLE_COLS = ['abv', 'style'] as const;

export const ScopeTermSchema = z.union([
  z.object({
    col: z.enum(NUMERIC_COLS),
    op: z.enum(['=', '!=', '<', '<=', '>', '>=']),
    value: z.number(),
  }),
  z.object({ col: z.enum(TEXT_COLS), op: z.enum(['empty', 'non_empty']) }),
  z.object({ col: z.enum(TEXT_COLS), op: z.literal('contains'), value: z.string().min(1) }),
  z.object({ col: z.enum(NULLABLE_COLS), op: z.enum(['is_null', 'is_not_null']) }),
  z.object({ col: z.literal('review_class'), op: z.literal('='), value: z.enum(REVIEW_CLASSES) }),
]);
export type ScopeTerm = z.infer<typeof ScopeTermSchema>;

export const ScopeSchema = z.object({
  beer_ids: z.array(z.number().int()),
  where: z.array(ScopeTermSchema),
});
export type Scope = z.infer<typeof ScopeSchema>;

// Legality: an enumerated cohort is the narrowest scope there is, so it always
// qualifies. A `where` qualifies only if it constrains something other than the class
// itself — "all orphans in this class" is the exact shape that turned #347 into a
// dumping ground, and four open issues still carry it verbatim.
export function isLegalScope(scope: Scope): boolean {
  if (scope.beer_ids.length > 0) return true;
  return scope.where.some((t) => t.col !== 'review_class');
}

function termMatches(
  row: UntriagedFailure,
  verdictClass: (typeof REVIEW_CLASSES)[number],
  term: ScopeTerm,
): boolean {
  // review_class is evaluated against the VERDICT, not the row: every row in the batch
  // is untriaged by construction (listUntriagedFailures filters review_class IS NULL),
  // so matching it against the row would make every such term false.
  if (term.col === 'review_class') return verdictClass === term.value;

  if (term.op === 'is_null' || term.op === 'is_not_null') {
    const v = row[term.col];
    return term.op === 'is_null' ? v === null : v !== null;
  }
  if (term.op === 'empty' || term.op === 'non_empty' || term.op === 'contains') {
    const v = row[term.col];
    if (term.op === 'empty') return v === '';
    if (term.op === 'non_empty') return v !== '';
    return v.toLowerCase().includes(term.value.toLowerCase());
  }
  const v = row[term.col];
  switch (term.op) {
    case '=': return v === term.value;
    case '!=': return v !== term.value;
    case '<': return v < term.value;
    case '<=': return v <= term.value;
    case '>': return v > term.value;
    case '>=': return v >= term.value;
  }
}

export function rowSatisfiesScope(
  row: UntriagedFailure,
  verdictClass: (typeof REVIEW_CLASSES)[number],
  scope: Scope,
): boolean {
  if (scope.beer_ids.includes(row.beer_id)) return true;
  // An empty `where` must NOT pass vacuously — `[].every(...)` is true, which would
  // turn a cohort-only scope into "accepts everything" the moment a row falls outside
  // the cohort. That is the opposite of what a cohort scope means.
  if (scope.where.length === 0) return false;
  return scope.where.every((t) => termMatches(row, verdictClass, t));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/domain/triage-scope.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-scope.ts src/domain/triage-scope.test.ts
git commit -m "feat(#408): scope type, legality rule and row-satisfaction check"
```

---

### Task 2: Render and parse the `triage-scope` block

**Files:**
- Modify: `src/domain/triage-scope.ts`
- Test: `src/domain/triage-scope.test.ts`

- [ ] **Step 1: Write the failing test** (append to the existing test file)

```ts
import { renderScopeBlock, parseScopeBlock } from './triage-scope';

test('render then parse round-trips a scope', () => {
  const scope: Scope = {
    beer_ids: [34005, 11952],
    where: [{ col: 'candidates_count', op: '=', value: 0 }],
  };
  const body = `Some prose about the pattern.\n\n${renderScopeBlock(scope)}\n\nMore prose.`;
  expect(parseScopeBlock(body)).toEqual(scope);
});

test('a body with no block is unscoped', () => {
  expect(parseScopeBlock('Scope: all orphans in this class — enrich_failures WHERE review_class=\'matcher_bug\'.'))
    .toBeNull();
});

test('a malformed or unknown-column block is unscoped, never a throw', () => {
  expect(parseScopeBlock('```triage-scope\n{not json\n```')).toBeNull();
  expect(parseScopeBlock('```triage-scope\n{"beer_ids":[],"where":[{"col":"secret","op":"=","value":1}]}\n```'))
    .toBeNull();
});

test('the rendered block carries a human-readable Scope line next to it', () => {
  const out = renderScopeBlock({ beer_ids: [7], where: [{ col: 'brewery', op: 'empty' }] });
  expect(out).toContain('```triage-scope');
  expect(out).toContain('Scope:');
  expect(out).toContain('brewery empty');
  expect(out).toContain('7');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/triage-scope.test.ts`
Expected: FAIL — `renderScopeBlock` is not exported.

- [ ] **Step 3: Write the implementation** (append to `src/domain/triage-scope.ts`)

```ts
const BLOCK_RE = /```triage-scope\s*\n([\s\S]*?)\n?```/;

function describeTerm(t: ScopeTerm): string {
  return 'value' in t ? `${t.col} ${t.op} ${t.value}` : `${t.col} ${t.op}`;
}

// We render this ourselves and parse our own output back on the next run. The model
// never authors the text — it submits the structured field, which the tool schema
// already validates. That is the whole point: a parser exists, but its input is not
// model prose.
export function renderScopeBlock(scope: Scope): string {
  const parts: string[] = [];
  if (scope.beer_ids.length > 0) parts.push(`beer_ids ${scope.beer_ids.join(', ')}`);
  if (scope.where.length > 0) parts.push(scope.where.map(describeTerm).join(' AND '));
  return [
    `Scope: ${parts.join(' OR ')}`,
    '',
    '```triage-scope',
    JSON.stringify(scope),
    '```',
  ].join('\n');
}

export function parseScopeBlock(body: string): Scope | null {
  const m = BLOCK_RE.exec(body);
  if (!m) return null;
  try {
    const parsed = ScopeSchema.safeParse(JSON.parse(m[1]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/domain/triage-scope.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-scope.ts src/domain/triage-scope.test.ts
git commit -m "feat(#408): render and parse the triage-scope block"
```

---

### Task 3: Structured `scope` on the tool schema and the prompt

**Files:**
- Modify: `src/domain/triage-analysis.ts:30-36` (zod), `:79-92` (tool schema), `:215-221` (prompt text)
- Test: `src/domain/triage-analysis.test.ts`

- [ ] **Step 1: Write the failing test** (append to `src/domain/triage-analysis.test.ts`)

```ts
import { AnalysisSchema, ANALYSIS_TOOL_SCHEMA, buildTriagePrompt } from './triage-analysis';

test('new_issues carries a structured scope', () => {
  const parsed = AnalysisSchema.parse({
    verdicts: [],
    new_issues: [{
      key: 'k', title: 't', body: 'b', labels: [],
      scope: { beer_ids: [1], where: [{ col: 'candidates_count', op: '=', value: 0 }] },
    }],
  });
  expect(parsed.new_issues[0].scope.where[0]).toEqual({ col: 'candidates_count', op: '=', value: 0 });
});

test('a new_issue without a scope fails to parse', () => {
  expect(AnalysisSchema.safeParse({
    verdicts: [], new_issues: [{ key: 'k', title: 't', body: 'b', labels: [] }],
  }).success).toBe(false);
});

test('the tool schema requires scope on every new_issue', () => {
  const item = ANALYSIS_TOOL_SCHEMA.properties.new_issues.items as {
    required: readonly string[];
  };
  expect(item.required).toContain('scope');
});

test('the prompt asks for a structured scope and no longer offers the whole-class example', () => {
  const prompt = buildTriagePrompt({ orphans: [], openIssues: [] });
  expect(prompt).not.toContain("review_class='matcher_bug'\"");
  expect(prompt).toContain('scope');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/triage-analysis.test.ts`
Expected: FAIL — `scope` is stripped by `z.object`, `required` lacks `scope`.

- [ ] **Step 3: Write the implementation**

In `src/domain/triage-analysis.ts`, import the schema and extend `new_issues`:

```ts
import { ScopeSchema } from './triage-scope';
```

Replace the `new_issues` entry of `AnalysisSchema` (currently lines 30-35) with:

```ts
  new_issues: z.array(z.object({
    key: z.string().min(1),
    title: z.string().min(1).max(200),
    body: z.string().min(1),
    labels: z.array(z.string()),
    // #408: machine-readable scope. Free-text Scope lines could not be checked against
    // a row, so every issue trivially "already covered" every future row of its class.
    scope: ScopeSchema,
  })),
```

Add to `ANALYSIS_TOOL_SCHEMA.properties.new_issues.items.properties`:

```ts
          scope: {
            type: 'object',
            properties: {
              beer_ids: { type: 'array', items: { type: 'integer' } },
              where: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    col: { type: 'string' },
                    op: { type: 'string' },
                    value: { type: ['string', 'number'] },
                  },
                  required: ['col', 'op'],
                  additionalProperties: false,
                },
              },
            },
            required: ['beer_ids', 'where'],
            additionalProperties: false,
          },
```

and add `'scope'` to that item's `required` array.

Replace the prompt's Scope instruction (currently the bullet at `:217-219`) with:

```ts
    '- Each new_issue must carry a `scope` object naming the rows it can ever cover:',
    '  `beer_ids` (the rows from today you are filing it for) and/or `where`, a list of',
    '  {col, op, value} terms ANDed together. Allowed col: candidates_count, fail_count',
    '  (= != < <= > >=); source_url, brewery, name (empty, non_empty, contains);',
    '  abv, style (is_null, is_not_null); review_class (=). A `where` made only of',
    '  review_class is REJECTED — scope the mechanism, not the whole class. The scope is a',
    '  necessary condition: a row that contradicts it can never be attached to the issue.',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/triage-analysis.test.ts`
Expected: PASS. Then `npm run typecheck` — expect errors only in `triage-plan.ts` call sites, which Task 4 fixes.

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-analysis.ts src/domain/triage-analysis.test.ts
git commit -m "feat(#408): structured scope field on new_issues (zod + tool schema + prompt)"
```

---

### Task 4: Guards 1 and 2 in `planTriageActions`, with the new signature

**Files:**
- Modify: `src/domain/triage-plan.ts`
- Modify: `src/jobs/orphan-triage.ts:245`
- Test: `src/domain/triage-plan.test.ts`

- [ ] **Step 1: Write the failing test** (append to `src/domain/triage-plan.test.ts`)

```ts
import type { UntriagedFailure } from '../storage/enrich_failures';
import type { ScopedIssue } from './triage-plan';

const row = (id: number, over: Partial<UntriagedFailure> = {}): UntriagedFailure => ({
  beer_id: id, brewery: 'B', name: 'N', search_url: '', source_url: '',
  candidates_count: 3, candidates_summary: '', fail_count: 1,
  last_at: '2026-08-14T00:00:00.000Z', abv: null, style: null, ...over,
});
test('a zero-candidate row cannot attach to an issue scoped candidates_count > 0', () => {
  const issues: ScopedIssue[] = [{
    number: 347, postCreationRows: 0,
    scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '>', value: 0 }] },
  }];
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 347 })], new_issues: [] };
  const plan = planTriageActions(a, issues, [row(1, { candidates_count: 0 })], new Map());
  expect(plan.comments).toHaveLength(0);
  expect(plan.skipped).toBe(1);
  expect(plan.guardHits.scope_violation).toBe(1);
});

test('a matching row still attaches', () => {
  const issues: ScopedIssue[] = [{
    number: 347, postCreationRows: 0,
    scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '>', value: 0 }] },
  }];
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 347 })], new_issues: [] };
  const plan = planTriageActions(a, issues, [row(1, { candidates_count: 5 })], new Map());
  expect(plan.comments[0].verdicts).toHaveLength(1);
});

test('an unscoped issue accepts nothing', () => {
  const issues: ScopedIssue[] = [{ number: 347, scope: null, postCreationRows: 0 }];
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 347 })], new_issues: [] };
  const plan = planTriageActions(a, issues, [row(1)], new Map());
  expect(plan.comments).toHaveLength(0);
  expect(plan.guardHits.scope_violation).toBe(1);
});

test('a proposed issue scoped only by review_class is dropped with its verdicts', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, new_issue_key: 'k1' })],
    new_issues: [{
      key: 'k1', title: 't', body: 'b', labels: [],
      scope: { beer_ids: [], where: [{ col: 'review_class', op: '=', value: 'matcher_bug' }] },
    }],
  };
  const plan = planTriageActions(a, [], [row(1)], new Map());
  expect(plan.newIssues).toHaveLength(0);
  expect(plan.skipped).toBe(1);
  expect(plan.guardHits.illegal_scope).toBe(1);
});

test('a proposed issue scoped by class AND another column survives', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, new_issue_key: 'k1' })],
    new_issues: [{
      key: 'k1', title: 't', body: 'b', labels: [],
      scope: { beer_ids: [], where: [
        { col: 'review_class', op: '=', value: 'matcher_bug' },
        { col: 'candidates_count', op: '=', value: 0 },
      ] },
    }],
  };
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 0 })], new Map());
  expect(plan.newIssues).toHaveLength(1);
  expect(plan.newIssues[0].scope.where).toHaveLength(2);
});
```

Also update **every existing call** in this test file from
`planTriageActions(a, [228], [1, 2, 3, 4])` to
`planTriageActions(a, [{ number: 228, scope: { beer_ids: [1, 2, 3, 4], where: [] }, postCreationRows: 0 }], [row(1), row(2), row(3), row(4)], new Map())`.
The cohort scope keeps the existing routing assertions true.

⚠️ **Cascade you must handle in the same task.** `src/jobs/orphan-triage.test.ts:48` defines

```ts
const gh = (over = {}) => ({
  listOpenIssues: vi.fn().mockResolvedValue([{ number: 228, title: 't', body: 'b', labels: [] }]),
```

Body `'b'` has no scope block, so after this change #228 is **unscoped** and every existing test
that expects a comment on #228 will fail. Update the default stub to carry a permissive cohort
block and the new `createdAt` field:

```ts
  listOpenIssues: vi.fn().mockResolvedValue([{
    number: 228, title: 't', labels: [], createdAt: '2026-01-01T00:00:00.000Z',
    body: 'b\n\n```triage-scope\n{"beer_ids":[1,2,3,4,5,6],"where":[]}\n```',
  }]),
```

Similarly, every `new_issues` entry in that file now needs a `scope` field or `AnalysisSchema` will
reject it. Run `npx vitest run src/jobs/orphan-triage.test.ts` and fix each failure — do not weaken
an assertion to make it pass; if a test goes red for a reason other than the missing scope, stop and
report it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/triage-plan.test.ts`
Expected: FAIL — `ScopedIssue` not exported, `guardHits` undefined, arity mismatch.

- [ ] **Step 3: Write the implementation**

In `src/domain/triage-plan.ts`:

```ts
import type { UntriagedFailure } from '../storage/enrich_failures';
import type { TriageProbe } from './triage-probes';
import { isLegalScope, rowSatisfiesScope, type Scope } from './triage-scope';

export interface ScopedIssue {
  number: number;
  scope: Scope | null;      // null = unscoped: accepts no new rows
  postCreationRows: number;
}

export type GuardReason = 'illegal_scope' | 'scope_violation' | 'saturated' | 'unprobed_absence';

export interface PlannedNewIssue {
  key: string;
  title: string;
  body: string;
  labels: string[];
  scope: Scope;
  verdicts: Verdict[];
}
```

Add `guardHits: Record<GuardReason, number>` to `TriagePlan`.

Replace the signature and the routing block:

```ts
export function planTriageActions(
  analysis: Analysis,
  openIssues: ScopedIssue[],
  batchRows: UntriagedFailure[],
  probes: Map<number, TriageProbe>,
): TriagePlan {
  const byNumber = new Map(openIssues.map((i) => [i.number, i]));
  const rowById = new Map(batchRows.map((r) => [r.beer_id, r]));
  const guardHits: Record<GuardReason, number> = {
    illegal_scope: 0, scope_violation: 0, saturated: 0, unprobed_absence: 0,
  };

  // Guard 1: an illegal scope kills the proposed issue before it can claim a class.
  const uniqueIssues = new Map<string, Analysis['new_issues'][number]>();
  for (const entry of analysis.new_issues) {
    if (!isLegalScope(entry.scope)) { guardHits.illegal_scope += 1; continue; }
    if (!uniqueIssues.has(entry.key)) uniqueIssues.set(entry.key, entry);
  }
  const cappedIssues = [...uniqueIssues.values()].slice(0, MAX_NEW_ISSUES_PER_RUN);
  const allowedKeys = new Set(cappedIssues.map((i) => i.key));
  // ... existing byKey/byIssue/quiet/skipped/seenBeerIds setup, with `batch` replaced by rowById
```

Inside the verdict loop, replace `if (!batch.has(verdict.beer_id))` with
`const row = rowById.get(verdict.beer_id); if (!row) { skipped++; continue; }`, and replace the
`hasIssue` branch with:

```ts
    if (hasIssue) {
      const target = byNumber.get(verdict.issue_number!);
      if (!target) { skipped++; continue; }
      // Guard 2: the row must not contradict what the issue claims to be about. We do
      // NOT re-route on failure — picking a different issue is exactly the
      // title-similarity judgement that produced the pile.
      if (target.scope === null || !rowSatisfiesScope(row, verdict.review_class, target.scope)) {
        guardHits.scope_violation += 1;
        skipped++;
        continue;
      }
      pushInto(byIssue, verdict.issue_number!, verdict);
    }
```

Carry `scope: i.scope` through in the `newIssues` map, and return `guardHits` on the plan.

Update the call site `src/jobs/orphan-triage.ts:245` to:

```ts
      plan = planTriageActions(analysis, scopedIssues, orphans, probes);
```

where `scopedIssues` is built right after `listOpenIssues`:

```ts
      const scopedIssues: ScopedIssue[] = openIssues.map((i) => ({
        number: i.number,
        scope: parseScopeBlock(i.body),
        postCreationRows: 0,   // Task 7 fills this in
      }));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/triage-plan.test.ts && npm run typecheck`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-plan.ts src/domain/triage-plan.test.ts src/jobs/orphan-triage.ts
git commit -m "feat(#408): reject illegal scopes and attachments the row contradicts"
```

---

### Task 5: Guard 3 — the class gate for `not_on_untappd`

**Files:**
- Modify: `src/domain/triage-plan.ts`
- Test: `src/domain/triage-plan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('not_on_untappd survives when a probe ran and returned nothing', () => {
  const a: Analysis = { verdicts: [v({ beer_id: 1, review_class: 'not_on_untappd' })], new_issues: [] };
  const probes = new Map([[1, { brewery: '', name: '' }]]);
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 0 })], probes);
  expect(plan.quiet[0].review_class).toBe('not_on_untappd');
  expect(plan.guardHits.unprobed_absence).toBe(0);
});

test('not_on_untappd degrades to matcher_bug when no probe ran', () => {
  const a: Analysis = { verdicts: [v({ beer_id: 1, review_class: 'not_on_untappd' })], new_issues: [] };
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 5 })], new Map());
  expect(plan.quiet[0].review_class).toBe('matcher_bug');
  expect(plan.quiet[0].review_note).toContain('no absence evidence');
  expect(plan.guardHits.unprobed_absence).toBe(1);
});

test('a probe that returned hits is not absence evidence', () => {
  const a: Analysis = { verdicts: [v({ beer_id: 1, review_class: 'not_on_untappd' })], new_issues: [] };
  const probes = new Map([[1, { brewery: 'Mad Elf, MadTree', name: 'something' }]]);
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 0 })], probes);
  expect(plan.quiet[0].review_class).toBe('matcher_bug');
  expect(plan.guardHits.unprobed_absence).toBe(1);
});

test('wontfix is untouched by the class gate', () => {
  const a: Analysis = { verdicts: [v({ beer_id: 1, review_class: 'wontfix' })], new_issues: [] };
  const plan = planTriageActions(a, [], [row(1)], new Map());
  expect(plan.quiet[0].review_class).toBe('wontfix');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/triage-plan.test.ts`
Expected: FAIL — `not_on_untappd` passes through unchanged.

- [ ] **Step 3: Write the implementation**

In the verdict loop of `planTriageActions`, immediately before the `isActionable` check:

```ts
    // Guard 3: absence is claimable only from a probe that RAN and came back empty.
    // `''` = ran, no results (strong evidence); `undefined` = never ran (no evidence).
    // triage-probes.ts keeps those distinct on purpose — collapsing them invites the
    // guessing this guard exists to stop. #377 measured the "no probe ran" cohort as
    // wrong 3 of 3.
    //
    // NOTE: collectTriageProbes skips rows with candidates_count > 0 by construction,
    // so every candidate-bearing not_on_untappd degrades here. That is the intended
    // direction; probing those rows too is #377's dropped proposal 2, tracked in #357.
    if (verdict.review_class === 'not_on_untappd') {
      const probe = probes.get(verdict.beer_id);
      const proved = probe?.brewery === '' || probe?.name === '';
      if (!proved) {
        guardHits.unprobed_absence += 1;
        // matcher_bug with no target lands in `quiet` below: the class is recorded so
        // the row leaves the untriaged pool, but it stays in the ENRICHMENT pool
        // (orphanWithoutMatchLinkPredicate excludes only wontfix/retired_at), so the
        // cron keeps retrying it. Wrong-but-recoverable replaces wrong-and-terminal.
        quiet.push({
          ...verdict,
          review_class: 'matcher_bug',
          issue_number: null,
          new_issue_key: null,
          review_note: `no absence evidence: ${verdict.review_note}`.slice(0, 500),
        });
        continue;
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/triage-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-plan.ts src/domain/triage-plan.test.ts
git commit -m "feat(#408): gate not_on_untappd on a probe that ran and returned nothing"
```

---

### Task 6: Migration v23 — `enrich_failures.issue_number`

**Files:**
- Modify: `src/storage/schema.ts:283` (append after the v22 entry)
- Modify: `src/storage/enrich_failures.ts` (`setEnrichFailureReview`, new `countRowsForIssue`)
- Modify: `src/jobs/orphan-triage.ts:284-290`
- Test: `src/storage/enrich_failures.test.ts`

- [ ] **Step 1: Write the failing test**

Use the helpers that already exist in this file: `testDb()`, `insertBeer(db, n)`, the `row()`
builder and `recordEnrichFailure`. There is no `openTestDb`/`insertFailure`.

```ts
test('setEnrichFailureReview records the issue number in its own column', () => {
  const db = testDb();
  const id = insertBeer(db, 1);
  recordEnrichFailure(db, row({ beer_id: id }));
  setEnrichFailureReview(db, id, 'matcher_bug', 'note', '2026-08-14T00:00:00.000Z', 408);
  const got = db.prepare('SELECT issue_number FROM enrich_failures WHERE beer_id = ?').get(id) as any;
  expect(got.issue_number).toBe(408);
});

test('countRowsForIssue counts only rows reviewed after the given instant', () => {
  const db = testDb();
  const a = insertBeer(db, 1);
  const b = insertBeer(db, 2);
  recordEnrichFailure(db, row({ beer_id: a }));
  recordEnrichFailure(db, row({ beer_id: b }));
  setEnrichFailureReview(db, a, 'matcher_bug', 'a', '2026-08-01T00:00:00.000Z', 408);
  setEnrichFailureReview(db, b, 'matcher_bug', 'b', '2026-08-10T00:00:00.000Z', 408);
  expect(countRowsForIssue(db, 408, '2026-08-05T00:00:00.000Z')).toBe(1);
});

test('the v23 backfill recovers issue numbers from the legacy note suffix', () => {
  const db = testDb();
  const id = insertBeer(db, 1);
  recordEnrichFailure(db, row({ beer_id: id }));
  // Simulate a pre-v23 row: legacy suffix present, column not yet populated.
  db.prepare("UPDATE enrich_failures SET review_note = 'alias gap → #347', issue_number = NULL WHERE beer_id = ?")
    .run(id);
  db.exec(V23_BACKFILL_SQL);          // the exact statement the migration runs
  const got = db.prepare('SELECT issue_number FROM enrich_failures WHERE beer_id = ?').get(id) as any;
  expect(got.issue_number).toBe(347);
});

test('the v23 backfill ignores a note with no legacy suffix', () => {
  const db = testDb();
  const id = insertBeer(db, 1);
  recordEnrichFailure(db, row({ beer_id: id }));
  db.prepare("UPDATE enrich_failures SET review_note = 'plain note' WHERE beer_id = ?").run(id);
  db.exec(V23_BACKFILL_SQL);
  const got = db.prepare('SELECT issue_number FROM enrich_failures WHERE beer_id = ?').get(id) as any;
  expect(got.issue_number).toBeNull();
});
```

**Why the backfill SQL is exported rather than re-running the migration.** `migrate()` is idempotent
per version via `schema_version`, so the obvious test — delete the row for 23 and call `migrate()`
again — would re-execute `ALTER TABLE … ADD COLUMN issue_number` and fail with "duplicate column
name". Exporting the backfill statement lets the test exercise the **exact string** the migration
runs, with no copy to drift.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: FAIL — no such column `issue_number`.

- [ ] **Step 3: Write the implementation**

In `src/storage/schema.ts`, export the backfill statement and reference it from the migration so the
test and the migration can never drift:

```ts
// Exported so the test can exercise the exact statement the migration runs. Re-running
// the whole v23 entry is impossible (ALTER TABLE ADD COLUMN would hit "duplicate column
// name"), and a copy in the test would silently drift.
export const V23_BACKFILL_SQL = `
  UPDATE enrich_failures
     SET issue_number = CAST(
           replace(substr(review_note, instr(review_note, '→ #') + 4), ' ', '') AS INTEGER)
   WHERE review_note LIKE '%→ #%'
     AND CAST(replace(substr(review_note, instr(review_note, '→ #') + 4), ' ', '') AS INTEGER) > 0;
`;
```

Append to `MIGRATIONS`:

```ts
  {
    version: 23,
    // #408: the row -> issue link existed only as a free-text suffix appended by
    // orphan-triage ("… → #123"), which nothing could query and which re-routing notes
    // written on 2026-08-14 already broke ("→ #405 (re-routed …)"). Without the column
    // the saturation guard cannot count rows per issue, and neither #408 nor #381 can
    // be audited after the fact. The backfill takes the FIRST "→ #<digits>" occurrence,
    // which is the one the job wrote; CAST stops at the first non-digit, so the
    // re-routing notes written on 2026-08-14 ("→ #405 (re-routed …)") still resolve.
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN issue_number INTEGER;
      ${V23_BACKFILL_SQL}
    `,
  },
```

In `src/storage/enrich_failures.ts`, add the parameter and the counter:

```ts
export function setEnrichFailureReview(
  db: DB, beerId: number, reviewClass: ReviewClass,
  note: string | null, atIso: string, issueNumber: number | null = null,
): boolean {
  const info = db
    .prepare(
      `UPDATE enrich_failures
         SET review_class = ?, review_note = ?, reviewed_at = ?, issue_number = ?
       WHERE beer_id = ?`,
    )
    .run(reviewClass, note, atIso, issueNumber, beerId);
  return info.changes > 0;
}

// Rows attached to an issue AFTER a given instant. Saturation deliberately ignores the
// cohort an issue was born with: #405 was created with 15 enumerated rows, exactly the
// proposed threshold, so counting lifetime rows would reject the very shape we want.
export function countRowsForIssue(db: DB, issueNumber: number, sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM enrich_failures
        WHERE issue_number = ? AND reviewed_at > ?`,
    )
    .get(issueNumber, sinceIso) as { n: number };
  return row.n;
}
```

In `src/jobs/orphan-triage.ts`, change `review` to pass the number through and drop the suffix:

```ts
    const review = (v: Verdict, issueNumber: number | null): void => {
      if (!setEnrichFailureReview(db, v.beer_id, v.review_class, v.review_note, nowIso, issueNumber)) {
        log.warn({ beerId: v.beer_id }, 'orphan-triage: review write no-op (row gone)');
      }
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/storage/enrich_failures.test.ts src/storage/schema.test.ts && npm test`
Expected: PASS across the suite.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts src/jobs/orphan-triage.ts
git commit -m "feat(#408): migration v23 — enrich_failures.issue_number with legacy backfill"
```

---

### Task 7: Guard 4 — saturation

**Files:**
- Modify: `src/domain/triage-plan.ts`
- Modify: `src/jobs/orphan-triage.ts` (fill `postCreationRows`)
- Test: `src/domain/triage-plan.test.ts`

`MAX_ROWS_PER_ISSUE = 12`. Rationale to put in the comment: the measured non-magnet issues sit at
≤7 lifetime rows while the magnets ran to 36 (#347) and 90 (#254); 12 separates them with room, and
because the count is post-creation only, an issue born with 15 enumerated rows (#405) is unaffected.

- [ ] **Step 1: Write the failing test**

```ts
test('a saturated issue refuses further attachment', () => {
  const issues: ScopedIssue[] = [{
    number: 347, postCreationRows: 12,
    scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '>', value: 0 }] },
  }];
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 347 })], new_issues: [] };
  const plan = planTriageActions(a, issues, [row(1)], new Map());
  expect(plan.comments).toHaveLength(0);
  expect(plan.guardHits.saturated).toBe(1);
});

test('an issue born with a large cohort but no post-creation rows still accepts', () => {
  const issues: ScopedIssue[] = [{
    number: 405, postCreationRows: 0,
    scope: { beer_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], where: [] },
  }];
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 405 })], new_issues: [] };
  const plan = planTriageActions(a, issues, [row(1)], new Map());
  expect(plan.comments[0].verdicts).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/triage-plan.test.ts`
Expected: FAIL — the saturated issue still receives a comment.

- [ ] **Step 3: Write the implementation**

In `src/domain/triage-plan.ts`:

```ts
// Post-creation rows only — see countRowsForIssue. Non-magnet issues measured at <=7
// lifetime rows; the magnets ran to 36 (#347) and 90 (#254).
export const MAX_ROWS_PER_ISSUE = 12;
```

In the `hasIssue` branch, before the scope check:

```ts
      if (target.postCreationRows >= MAX_ROWS_PER_ISSUE) {
        guardHits.saturated += 1;
        skipped++;
        continue;
      }
```

In `src/jobs/orphan-triage.ts`, fill the field — the issue's own creation instant is not available
from `listOpenIssues`, so count everything the job itself attached, which is by definition
post-creation:

```ts
      const scopedIssues: ScopedIssue[] = openIssues.map((i) => ({
        number: i.number,
        scope: parseScopeBlock(i.body),
        postCreationRows: countRowsForIssue(db, i.number, i.createdAt),
      }));
```

Add `createdAt: string` to the `OpenIssue` interface in `src/domain/triage-analysis.ts` and map it
from `created_at` in `src/infra/github-issues.ts:46`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/triage-plan.test.ts && npm run typecheck`
Expected: PASS and clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/domain/triage-plan.ts src/domain/triage-plan.test.ts src/domain/triage-analysis.ts src/infra/github-issues.ts src/jobs/orphan-triage.ts
git commit -m "feat(#408): saturation guard counting post-creation rows only"
```

---

### Task 8: Render the scope into created issues, and log guard reasons

**Files:**
- Modify: `src/jobs/orphan-triage.ts:292-296` and `:278-280`
- Test: `src/jobs/orphan-triage.test.ts`

- [ ] **Step 1: Write the failing test**

There is no `harness()` helper in this file. Use the real ones: `db()`, `seedOrphan()`, `gh()`,
`llm()`, `inWindow`, and the `spyLog` pattern already used by the "logs one evidence summary per
run" test at `src/jobs/orphan-triage.test.ts:445`.

```ts
test('a created issue body carries the triage-scope block', async () => {
  const d = db();
  seedOrphan(d, 1);
  const github = gh();
  const analysis: Analysis = {
    verdicts: [{ beer_id: 1, review_class: 'matcher_bug', review_note: 'n',
      issue_number: null, new_issue_key: 'k1', proposed_query: null, expected_target: null }],
    new_issues: [{ key: 'k1', title: 't', body: 'prose', labels: [],
      scope: { beer_ids: [1], where: [] } }],
  };
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });

  const body = github.createIssue.mock.calls[0][0].body as string;
  expect(body).toContain('```triage-scope');
  expect(parseScopeBlock(body)).toEqual({ beer_ids: [1], where: [] });
});

test('the shortfall log carries per-guard counts', async () => {
  const d = db();
  seedOrphan(d, 1);
  seedOrphan(d, 2);
  const warns: Record<string, unknown>[] = [];
  const spyLog = { ...log, info: () => {}, error: () => {}, debug: () => {},
    warn: (o: unknown) => { warns.push(o as Record<string, unknown>); } } as unknown as typeof log;
  // Verdict for beer 2 only, and it points at an issue whose scope it violates.
  const analysis: Analysis = {
    verdicts: [{ beer_id: 2, review_class: 'matcher_bug', review_note: 'n',
      issue_number: 228, new_issue_key: null, proposed_query: null, expected_target: null }],
    new_issues: [],
  };
  await orphanTriage({
    db: d, log: spyLog, llm: llm(analysis),
    github: gh({ listOpenIssues: vi.fn().mockResolvedValue([{
      number: 228, title: 't', labels: [], createdAt: '2026-01-01T00:00:00.000Z',
      body: '```triage-scope\n{"beer_ids":[],"where":[{"col":"candidates_count","op":">","value":0}]}\n```',
    }]) }),
    now: inWindow,
  });

  const line = warns.find((l) => 'guardHits' in l);
  expect(line).toBeDefined();
  expect((line!.guardHits as Record<string, number>).scope_violation).toBe(1);
});
```

`seedOrphan` writes `candidates_count: 0`, so the row genuinely violates a `candidates_count > 0`
scope — the assertion is real, not staged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/jobs/orphan-triage.test.ts`
Expected: FAIL — body has no block, log line has no `guardHits`.

- [ ] **Step 3: Write the implementation**

```ts
    for (const issue of plan.newIssues) {
      try {
        const body = `${issue.body}\n\n${renderScopeBlock(issue.scope)}`;
        const number = await github.createIssue({ title: issue.title, body, labels: issue.labels });
```

and extend the shortfall log:

```ts
    if (covered < orphans.length) {
      // Three of the four guards end in `skipped`, and a skipped row keeps
      // review_class NULL and returns tomorrow. A model that keeps proposing the same
      // illegal scope would recirculate the same rows forever while the batch silently
      // fills with repeat offenders — so the reason must be visible in one line.
      log.warn({ covered, batch: orphans.length, guardHits: plan.guardHits },
        'orphan-triage: verdict shortfall');
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/jobs/orphan-triage.test.ts && npm test`
Expected: PASS across the suite.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts
git commit -m "feat(#408): render the scope block into created issues, log guard reasons"
```

---

### Task 9: Update `spec.md` and back-fill the open issues

**Files:**
- Modify: `spec.md`
- Create: `tmp/backfill-scopes.md` (the block to paste per issue — ops, not committed)

- [ ] **Step 1: Update the spec**

`spec.md` is the OpenSpec source of truth and CLAUDE.md requires it to change in the same PR when
behaviour changes. Find the orphan-triage section and document: the `scope` field on new issues, the
four guards, `MAX_ROWS_PER_ISSUE`, and migration v23's `issue_number` column.

- [ ] **Step 2: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(#408): record the verdict guards and v23 in spec.md"
```

- [ ] **Step 4: Write the backfill blocks (ops step, after the PR merges and deploys)**

For each of the 15 open `orphan-triage` issues, append a rendered `triage-scope` block. Four
(#404, #401, #388, #370) currently carry the whole-class Scope line and need a real `where`; the
rest get their enumerated cohort. Until an issue has a block it is unscoped and accepts no new rows,
so this backfill is part of shipping, not follow-up.

Generate the list with:

```bash
gh issue list --label orphan-triage --state open --json number,title
```

---

## Notes for the reviewer

- Guard 2 never re-routes. That is deliberate: choosing a different issue is the
  title-similarity judgement that produced the pile in the first place.
- Guard 3 will degrade **every** candidate-bearing `not_on_untappd`, because
  `collectTriageProbes` skips those rows by construction (`triage-probes.ts:47`). Intended; the
  relief is #377's dropped proposal 2, tracked in #357. Do not "fix" it here.
- `MAX_ROWS_PER_ISSUE = 12` is a judgement call on measured data, not a derived constant.
- Every guard must be demonstrable by deletion: remove the guard, watch a named test go red.
