# Verify Corpus + Runner — Stage 1 (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure a `verify`-stage model against human-checked ground truth — a labelled corpus of claims with known-correct verdicts, plus a runner that scores any model against it.

**Architecture:** A committed JSON corpus (`scripts/ai-review/verify-corpus.json`), validated by zod on load. A runner groups entries by the pair `(sha, file)`, reads each group's file body from git at that sha, and calls the existing `verifyAll` once per group. File bodies are never committed — they are read with `git show <sha>:<path>`. The report scores per draw and as a union, split by provenance and by expected verdict, and counts `error` as a third outcome rather than a wrong answer.

**Tech Stack:** TypeScript, tsx, zod, Vitest. Reuses `scripts/ai-review/verify.ts` (`verifyAll`) and `scripts/ai-review/usage.ts` (`costUsd`, `addUsage`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-23-verify-corpus-and-runner-design.md`

## Global Constraints

- **`out_of_scope` is not a valid `expected` value in v1.** Loading a corpus entry with it must fail, not be skipped.
- **An invalid entry fails the whole load.** A silently skipped entry is a mark the candidate did not earn.
- **Group by the pair `(sha, file)`, never by `file`.** Two entries on the same path at different shas have different bodies.
- **`error` is a third outcome, never a wrong answer.** It is reported in its own column. (Measured 2026-09-23: a harness failure made `gpt-6-sol` look blind — #691.)
- **The report never prints a single overall percentage.** The corpus is skewed 6 `confirmed` to 13 `refuted` when complete; a judge answering `refuted` to everything would score 68%. Counts are per expected verdict and per provenance.
- **Agreement with the incumbent judge is a secondary column, never the metric.**
- **File bodies are read from git, never committed.**
- **No live API calls in tests.** `fetchFn` and the git reader are injected.
- **Every plan task runs the FULL gate**: `npm test && npm run typecheck`. Never a scoped test run.
- **Every new test must be mutation-proven**: delete the line it guards, watch that exact test fail, restore.

---

### Task 1: Corpus schema, loader, and the six seed entries

**Files:**
- Create: `scripts/ai-review/verify-corpus.ts`
- Create: `scripts/ai-review/verify-corpus.json`
- Create: `scripts/ai-review/verify-corpus.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface CorpusEntry { id: string; provenance: 'harvested' | 'constructed'; source: string; sha: string; file: string; matchedLine: number; matchedEndLine: number; quote: string; quoteOrigin: 'original' | 'reconstructed'; claim: string; why_it_breaks: string; expected: 'confirmed' | 'refuted'; why_expected: string; }`
  - `export function parseCorpus(raw: unknown): CorpusEntry[]` — throws on any invalid entry.
  - `export function loadCorpus(readJson?: () => unknown): CorpusEntry[]` — defaults to reading `verify-corpus.json` beside this module.

- [ ] **Step 1: Write the failing tests**

Create `scripts/ai-review/verify-corpus.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { loadCorpus, parseCorpus, type CorpusEntry } from './verify-corpus';

const entry = (over: Partial<CorpusEntry> = {}): CorpusEntry => ({
  id: '0726-348-4',
  provenance: 'harvested',
  source: 'PR #348 AI review 2026-07-26',
  sha: 'eb20128c2875',
  file: 'src/storage/web_search_quota.ts',
  matchedLine: 8,
  matchedEndLine: 16,
  quote: 'export function tryConsumeWebSearchQuota(db: DB, day: string, cap: number): boolean {',
  quoteOrigin: 'reconstructed',
  claim: 'the quota can exceed the cap under quick successive requests',
  why_it_breaks: 'two concurrent requests both read the count before either writes',
  expected: 'refuted',
  why_expected: 'one atomic UPSERT with ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < ? — the max stored count is exactly cap',
  ...over,
});

describe('parseCorpus', () => {
  it('accepts a well-formed entry', () => {
    expect(parseCorpus([entry()])).toEqual([entry()]);
  });

  // Global constraint: out_of_scope is not a v1 label. Its ground truth depends on
  // the diff, and a label we cannot defend poisons the corpus.
  it('rejects out_of_scope as an expected verdict', () => {
    expect(() => parseCorpus([entry({ expected: 'out_of_scope' as never })])).toThrow();
  });

  // A label without its evidence is the "counter in the evidence column" the spec
  // rule forbids.
  it('rejects an entry whose why_expected is empty', () => {
    expect(() => parseCorpus([entry({ why_expected: '   ' })])).toThrow();
  });

  it('rejects an entry with an unknown provenance', () => {
    expect(() => parseCorpus([entry({ provenance: 'invented' as never })])).toThrow();
  });

  // The quote carries the code's own indentation and must survive validation
  // byte-for-byte: it is what the judge is shown. Prose fields may be trimmed.
  it('preserves the quote\'s leading whitespace while trimming prose', () => {
    const [parsed] = parseCorpus([
      entry({ quote: '      if (target.postCreationRows >= MAX) {', why_expected: '  padded  ' }),
    ]);
    expect(parsed.quote).toBe('      if (target.postCreationRows >= MAX) {');
    expect(parsed.why_expected).toBe('padded');
  });

  it('still rejects a whitespace-only quote', () => {
    expect(() => parseCorpus([entry({ quote: '    ' })])).toThrow();
  });

  // One bad entry fails the load. Skipping it would hand the candidate a mark it
  // never earned, and the score would silently be out of a smaller denominator.
  it('fails the whole load when any entry is invalid, naming the id', () => {
    expect(() => parseCorpus([entry(), entry({ id: 'bad-1', why_expected: '' })])).toThrow(/bad-1/);
  });

  it('rejects duplicate ids', () => {
    expect(() => parseCorpus([entry(), entry()])).toThrow(/0726-348-4/);
  });
});

describe('loadCorpus — the committed seed', () => {
  it('loads and validates the shipped corpus', () => {
    const corpus = loadCorpus();
    expect(corpus.length).toBe(6);
  });

  // The seed is not an arbitrary sample: each of these properties is what makes a
  // later task's grouping test provable with real data rather than a fixture.
  it('carries both provenances and both expected verdicts', () => {
    const corpus = loadCorpus();
    expect(new Set(corpus.map((e) => e.provenance))).toEqual(new Set(['harvested', 'constructed']));
    expect(new Set(corpus.map((e) => e.expected))).toEqual(new Set(['confirmed', 'refuted']));
  });

  it('contains two entries sharing one (sha, file) — the batching case', () => {
    const corpus = loadCorpus();
    const same = corpus.filter(
      (e) => e.sha === '584aa66183e55e4371819c9c5b19b2662ddaa6a2' && e.file === 'src/domain/triage-plan.ts',
    );
    expect(same.map((e) => e.id).sort()).toEqual(['0923-418-D3', '0923-418-D4']);
  });

  it('contains one file path at two different shas — the grouping-key case', () => {
    const corpus = loadCorpus();
    const shas = corpus.filter((e) => e.file === 'src/domain/triage-plan.ts').map((e) => e.sha);
    expect(new Set(shas).size).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-review/verify-corpus.test.ts`
Expected: FAIL — `Failed to resolve import "./verify-corpus"`.

- [ ] **Step 3: Write the schema and loader**

Create `scripts/ai-review/verify-corpus.ts`:

```typescript
/**
 * The labelled corpus for the `verify` stage: claims whose correct verdict we
 * checked against the tree ourselves.
 *
 * Why this exists rather than a judge-vs-judge comparison: comparing two judges
 * measures similarity to the incumbent, not correctness — if they disagree,
 * agreement cannot say who is right. And the incumbent has been wrong: its 16
 * `refuted` verdicts on DeepSeek's claims are its own labels, checked by nobody.
 *
 * Design: docs/superpowers/specs/2026-09/2026-09-23-verify-corpus-and-runner-design.md
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Prose fields: trimming them is harmless and whitespace-only must be rejected.
const nonEmpty = z.string().trim().min(1);

// `quote` is NOT trimmed. It carries the code's own indentation, which is what the
// judge is shown, and `.trim()` would silently strip the leading whitespace of a
// single-line quote and the outer edges of a multi-line one. Probed against zod
// 4.6.5 on 2026-09-23: `z.string().trim()` does transform the parsed value, so this
// distinction is load-bearing, not stylistic.
const codeQuote = z.string().min(1).refine((v) => v.trim().length > 0, {
  message: 'quote must contain something other than whitespace',
});

const entrySchema = z.object({
  id: nonEmpty,
  provenance: z.enum(['harvested', 'constructed']),
  source: nonEmpty,
  sha: nonEmpty,
  file: nonEmpty,
  matchedLine: z.number().int().positive(),
  matchedEndLine: z.number().int().positive(),
  quote: codeQuote,
  quoteOrigin: z.enum(['original', 'reconstructed']),
  claim: nonEmpty,
  why_it_breaks: nonEmpty,
  // `out_of_scope` is deliberately absent: its ground truth depends on the diff,
  // and a label we cannot defend against the tree poisons the corpus.
  expected: z.enum(['confirmed', 'refuted']),
  why_expected: nonEmpty,
});

export type CorpusEntry = z.infer<typeof entrySchema>;

/**
 * Validate every entry, or throw.
 *
 * Fails the whole load rather than skipping a bad entry: a skipped entry is a
 * mark the candidate did not earn, and it shrinks the denominator invisibly.
 */
export function parseCorpus(raw: unknown): CorpusEntry[] {
  const list = z.array(z.unknown()).parse(raw);
  const out: CorpusEntry[] = [];
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const parsed = entrySchema.safeParse(item);
    if (!parsed.success) {
      const id = (item as { id?: unknown })?.id;
      const named = typeof id === 'string' ? id : `index ${i}`;
      throw new Error(`verify corpus entry ${named} is invalid: ${parsed.error.message}`);
    }
    if (seen.has(parsed.data.id)) {
      throw new Error(`verify corpus has a duplicate id: ${parsed.data.id}`);
    }
    seen.add(parsed.data.id);
    out.push(parsed.data);
  });
  return out;
}

export function loadCorpus(readJson?: () => unknown): CorpusEntry[] {
  const read =
    readJson ?? (() => JSON.parse(readFileSync(join(__dirname, 'verify-corpus.json'), 'utf8')));
  return parseCorpus(read());
}
```

- [ ] **Step 4: Write the six seed entries**

Create `scripts/ai-review/verify-corpus.json`. Every `sha`, line number and quote below was read out of the tree it names on 2026-09-23 — do not retype them from memory:

```json
[
  {
    "id": "0726-348-4",
    "provenance": "harvested",
    "source": "PR #348 AI review 2026-07-26, finding 4 (labelled `false` in docs/superpowers/specs/2026-07/2026-07-28-ai-review-baseline-labels.md)",
    "sha": "eb20128c2875",
    "file": "src/storage/web_search_quota.ts",
    "matchedLine": 8,
    "matchedEndLine": 16,
    "quote": "export function tryConsumeWebSearchQuota(db: DB, day: string, cap: number): boolean {",
    "quoteOrigin": "reconstructed",
    "claim": "The quota management logic allows for increments beyond the cap if multiple requests are made in quick succession, which could lead to exceeding the intended daily cap.",
    "why_it_breaks": "Two requests arriving together both read the current count before either writes, so both are allowed and the stored count passes the cap.",
    "expected": "refuted",
    "why_expected": "There is no read-then-write: a single atomic UPSERT does `ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < ?`, so the increment only happens while the count is under the cap and the maximum stored count is exactly `cap`."
  },
  {
    "id": "0728-358-4",
    "provenance": "harvested",
    "source": "PR #358 AI review 2026-07-28, finding 4 (labelled `false` in the 2026-07 baseline)",
    "sha": "429e337a80d9",
    "file": "src/domain/triage-verify.ts",
    "matchedLine": 55,
    "matchedEndLine": 55,
    "quote": "      out.set(verdict.beer_id, resultKeys(await args.search.search(query)).has(expected));",
    "quoteOrigin": "reconstructed",
    "claim": "`verifyCauses` ignores results that do not match the expected target, so a query returning unrelated beers is recorded as a successful verification.",
    "why_it_breaks": "The function stores a truthy result for any non-empty search response, so an unrelated hit counts as evidence for the proposed cause.",
    "expected": "refuted",
    "why_expected": "The stored value *is* the match test: `resultKeys(await args.search.search(query)).has(expected)` is false unless the expected key is among the results, so unrelated hits record `false`."
  },
  {
    "id": "0723-344-1",
    "provenance": "harvested",
    "source": "PR #344 AI review 2026-07-23, finding 1 (the only `real` in the 2026-07 baseline)",
    "sha": "6deab1704998",
    "file": "src/domain/pin-match.ts",
    "matchedLine": 29,
    "matchedEndLine": 29,
    "quote": "      db.prepare('DELETE FROM beers WHERE id = ?').run(beerId); // enrich_failures CASCADE-drop",
    "quoteOrigin": "original",
    "claim": "Merging an orphan into a canonical beer deletes the orphan row without redirecting its check-ins, so those check-ins are lost.",
    "why_it_breaks": "The merge redirects `match_links` to the canonical id and then deletes the orphan beer, but nothing redirects rows that reference the orphan by `checkins.beer_id`.",
    "expected": "confirmed",
    "why_expected": "In this tree the transaction updates `match_links` and then runs `DELETE FROM beers WHERE id = ?` with no statement touching `checkins`, and `checkins.beer_id` has no `ON DELETE CASCADE`, so the rows are orphaned by the delete. It was fixed in `ef2ebd2`, 13 minutes after the review."
  },
  {
    "id": "0923-418-D3",
    "provenance": "harvested",
    "source": "PR #418 AI review at 584aa661 — one of the five defects closed by fix commit 2170717",
    "sha": "584aa66183e55e4371819c9c5b19b2662ddaa6a2",
    "file": "src/domain/triage-plan.ts",
    "matchedLine": 192,
    "matchedEndLine": 195,
    "quote": "    } else {\n      if (!allowedKeys.has(verdict.new_issue_key!)) { skipped++; continue; }\n      pushInto(byKey, verdict.new_issue_key!, verdict);\n    }",
    "quoteOrigin": "reconstructed",
    "claim": "A verdict routed to a newly proposed issue is never checked against that issue's own scope, so a model can file an issue whose founding row contradicts it.",
    "why_it_breaks": "The consequence is applied with no row evidence, and the issue is born unable to accept the row that created it.",
    "expected": "confirmed",
    "why_expected": "The proposed-issue branch in this tree tests only `allowedKeys.has(verdict.new_issue_key!)` and then pushes; the scope check (`rowSatisfiesScope`) appears only in the `hasIssue` branch above. Fix commit 2170717 states it explicitly: \"Guard 2 now covers the proposed-issue branch too.\""
  },
  {
    "id": "0923-418-D4",
    "provenance": "harvested",
    "source": "PR #418 AI review at 584aa661 — one of the five defects closed by fix commit 2170717",
    "sha": "584aa66183e55e4371819c9c5b19b2662ddaa6a2",
    "file": "src/domain/triage-plan.ts",
    "matchedLine": 176,
    "matchedEndLine": 180,
    "quote": "      if (target.postCreationRows >= MAX_ROWS_PER_ISSUE) {\n        guardHits.saturated += 1;\n        skipped++;\n        continue;\n      }",
    "quoteOrigin": "reconstructed",
    "claim": "The saturation guard counts only rows that existed before the run, so a single batch can walk an issue sitting just under the limit straight past it.",
    "why_it_breaks": "Every verdict in the batch compares the same pre-run count against the cap, so an issue at 11 accepts every row in the batch.",
    "expected": "confirmed",
    "why_expected": "The comparison in this tree is `target.postCreationRows >= MAX_ROWS_PER_ISSUE`, where `postCreationRows` is read before the loop and nothing accumulates rows accepted earlier in the same run."
  },
  {
    "id": "0923-418-D4t",
    "provenance": "constructed",
    "source": "Time shift of 0923-418-D4: the identical claim judged against the tree that fixed it (2170717). True before the fix, false after.",
    "sha": "2170717",
    "file": "src/domain/triage-plan.ts",
    "matchedLine": 180,
    "matchedEndLine": 184,
    "quote": "      if (target.postCreationRows + accepted >= MAX_ROWS_PER_ISSUE) {\n        guardHits.saturated += 1;\n        skipped++;\n        continue;\n      }",
    "quoteOrigin": "reconstructed",
    "claim": "The saturation guard counts only rows that existed before the run, so a single batch can walk an issue sitting just under the limit straight past it.",
    "why_it_breaks": "Every verdict in the batch compares the same pre-run count against the cap, so an issue at 11 accepts every row in the batch.",
    "expected": "refuted",
    "why_expected": "This tree accumulates within the run: `const accepted = byIssue.get(verdict.issue_number!)?.length ?? 0;` and the guard compares `target.postCreationRows + accepted >= MAX_ROWS_PER_ISSUE`, so rows accepted earlier in the same batch do count. Answering `confirmed` here means the judge recognised the defect from memory instead of reading the tree."
  }
]
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-review/verify-corpus.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Mutation-prove the three constraints that matter**

1. In `verify-corpus.ts`, change `expected: z.enum(['confirmed', 'refuted'])` to
   `expected: z.enum(['confirmed', 'refuted', 'out_of_scope'])`.
   Run the test file. Expected: **`rejects out_of_scope as an expected verdict` FAILS**. Restore.
2. In `parseCorpus`, replace the `throw` inside the `!parsed.success` branch with `return;`
   (skipping the bad entry).
   Run the test file. Expected: **`fails the whole load when any entry is invalid, naming the id` FAILS**. Restore.
3. Change `quote: codeQuote` to `quote: nonEmpty`.
   Run the test file. Expected: **`preserves the quote's leading whitespace while trimming prose` FAILS**. Restore.

Record all three results in the task report.

- [ ] **Step 7: Verify every seed quote against its tree**

This step is not optional and not a formality: a corpus whose quotes do not match the
tree judges claims against the wrong code, and every later measurement is void.

For each entry, run the check and confirm the quote's first line appears at `matchedLine`:

```bash
git show eb20128c2875:src/storage/web_search_quota.ts | sed -n '8p'
git show 429e337a80d9:src/domain/triage-verify.ts | sed -n '55p'
git show 6deab1704998:src/domain/pin-match.ts | sed -n '29p'
git show 584aa66183e55e4371819c9c5b19b2662ddaa6a2:src/domain/triage-plan.ts | sed -n '176p;192p'
git show 2170717:src/domain/triage-plan.ts | sed -n '180p'
```

Expected: each printed line matches the first line of that entry's `quote` (ignoring
leading whitespace differences only if the quote records them faithfully — it should).
If any line disagrees, fix the entry, do not adjust the expectation.

- [ ] **Step 8: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: all tests pass, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add scripts/ai-review/verify-corpus.ts scripts/ai-review/verify-corpus.json scripts/ai-review/verify-corpus.test.ts
git commit -m "feat(verify-corpus): схема, валідатор і шість засіяних записів

Корпус тверджень із перевіреними людиною вердиктами — щоб міряти суддю проти
істини, а не проти іншої моделі. Невалідний запис валить увесь завантаж:
мовчки пропущений запис це бал, якого кандидат не заробив, і менший знаменник.
out_of_scope у v1 не є міткою — його істина залежить від дифу.

Кожен sha, номер рядка й цитата прочитані з названого дерева, не з пам'яті."
```

---

### Task 2: An optional completion budget on `verifyAll`

**Files:**
- Modify: `scripts/ai-review/verify.ts` (`verifyFile` and `verifyAll` signatures)
- Test: `scripts/ai-review/verify.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `verifyAll(deps, p)` where `p` gains an optional `maxCompletionTokens?: number`. When absent, behaviour is byte-identical to today: `Math.max(MIN_VERIFY_TOKENS, requests.length * TOKENS_PER_VERDICT)`.

**Why this task exists:** the runner must give every judge the same generous budget (8000
tokens, `DEFAULT_MAX_COMPLETION_TOKENS` from `openai.ts`). Half B of #691 is unfixed, so a
judge that reasons more verbosely would hit the production ceiling more often — a systematic
bias that reads as a quality difference. The budget is computed inside `verifyFile` today and
cannot be set from outside.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/ai-review/verify.test.ts`:

```typescript
describe('verifyAll — completion budget', () => {
  // The default must not move: production behaviour is out of scope for this change.
  it('asks for max(MIN_VERIFY_TOKENS, n * TOKENS_PER_VERDICT) when no budget is given', async () => {
    let body: Record<string, unknown> = {};
    const capture = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"x"},{"index":2,"verdict":"confirmed","evidence":"y"}]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await verifyAll(deps(capture), {
      instructions: 'verify',
      requests: [req(), req({ id: 'f1' })],
      fileContent: () => 'body',
    });

    // 2 requests * 1200 = 2400, which is above MIN_VERIFY_TOKENS (2000).
    expect(body.max_completion_tokens).toBe(2400);
  });

  it('uses the caller\'s budget when one is given', async () => {
    let body: Record<string, unknown> = {};
    const capture = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"x"}]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await verifyAll(deps(capture), {
      instructions: 'verify',
      requests: [req()],
      fileContent: () => 'body',
      maxCompletionTokens: 8000,
    });

    expect(body.max_completion_tokens).toBe(8000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-review/verify.test.ts`
Expected: the second test FAILS (`max_completion_tokens` is 2000, not 8000); the first passes already.

- [ ] **Step 3: Thread the optional budget through**

In `scripts/ai-review/verify.ts`, add the parameter to `verifyFile`:

```typescript
export async function verifyFile(
  deps: OpenAiDeps,
  p: {
    instructions: string;
    file: string;
    fileContent: string;
    requests: VerifyRequest[];
    maxCompletionTokens?: number;
  },
): Promise<{ ... }> {
```

and use it at the `callStructured` call, replacing the inline expression:

```typescript
    p.maxCompletionTokens ??
      Math.max(MIN_VERIFY_TOKENS, p.requests.length * TOKENS_PER_VERDICT),
```

Then add it to `verifyAll`'s params and pass it down:

```typescript
export async function verifyAll(
  deps: OpenAiDeps,
  p: {
    instructions: string;
    requests: VerifyRequest[];
    fileContent: (path: string) => string | null;
    /**
     * Override the per-call completion budget. Production leaves this unset and
     * keeps `max(MIN_VERIFY_TOKENS, n * TOKENS_PER_VERDICT)`; the corpus runner
     * sets it so that a verbose judge does not hit the ceiling more often than a
     * terse one and lose findings to #691 — a bias that reads as lower quality.
     */
    maxCompletionTokens?: number;
  },
): Promise<{ results: VerifyResult[]; usage: Usage }> {
```

and inside the loop's `verifyFile` call add `maxCompletionTokens: p.maxCompletionTokens,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-review/verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-prove the default is guarded**

Change the fallback to `p.maxCompletionTokens ?? 8000`.
Run the test file. Expected: **`asks for max(MIN_VERIFY_TOKENS, n * TOKENS_PER_VERDICT) when no budget is given` FAILS**. Restore.

Record the result in the task report.

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: all tests pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add scripts/ai-review/verify.ts scripts/ai-review/verify.test.ts
git commit -m "feat(verify): необов'язковий бюджет завершення для викликів verify

Прогонялці корпусу потрібен однаковий щедрий бюджет для всіх суддів: половина B
дефекту #691 не полагоджена, тож суддя, що міркує розлогіше, впирався б у стелю
частіше — системний зсув, який читається як нижча якість. Без параметра
поведінка прода незмінна, і на це окремий мутаційно доведений тест."
```

---

### Task 3: Grouping by `(sha, file)` and reading bodies from git

**Files:**
- Create: `scripts/ai-review/verify-corpus-run.ts`
- Test: `scripts/ai-review/verify-corpus-run.test.ts`

**Interfaces:**
- Consumes: `CorpusEntry` from `./verify-corpus` (Task 1); `verifyAll` with `maxCompletionTokens` (Task 2).
- Produces:
  - `export interface CorpusGroup { sha: string; file: string; entries: CorpusEntry[] }`
  - `export function groupEntries(entries: CorpusEntry[]): CorpusGroup[]`
  - `export interface EntryOutcome { id: string; expected: 'confirmed' | 'refuted'; actual: 'confirmed' | 'refuted' | 'out_of_scope' | 'error'; correct: boolean; evidence: string; provenance: 'harvested' | 'constructed'; }`
  - `export async function runDraw(p: { entries: CorpusEntry[]; instructions: string; readBody: (sha: string, file: string) => string | null; verify: typeof verifyAll; deps: OpenAiDeps; maxCompletionTokens?: number }): Promise<{ outcomes: EntryOutcome[]; usage: Usage }>`

- [ ] **Step 1: Write the failing tests**

Create `scripts/ai-review/verify-corpus-run.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE } from './usage';
import { groupEntries, runDraw } from './verify-corpus-run';
import type { CorpusEntry } from './verify-corpus';

const entry = (over: Partial<CorpusEntry>): CorpusEntry => ({
  id: 'x',
  provenance: 'harvested',
  source: 's',
  sha: 'aaa',
  file: 'src/a.ts',
  matchedLine: 1,
  matchedEndLine: 1,
  quote: 'q',
  claim: 'c',
  quoteOrigin: 'original',
  why_it_breaks: 'w',
  expected: 'confirmed',
  why_expected: 'because',
  ...over,
});

describe('groupEntries', () => {
  it('puts two entries on one (sha, file) in the same group', () => {
    const groups = groupEntries([entry({ id: 'a' }), entry({ id: 'b' })]);
    expect(groups.length).toBe(1);
    expect(groups[0].entries.map((e) => e.id)).toEqual(['a', 'b']);
  });

  // The whole point of the pair key. The same path at two shas is two different
  // file bodies, so judging both against one body would guarantee a wrong answer.
  it('splits the same file at different shas into two groups', () => {
    const groups = groupEntries([entry({ id: 'a', sha: 'aaa' }), entry({ id: 'b', sha: 'bbb' })]);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.sha).sort()).toEqual(['aaa', 'bbb']);
  });

  it('splits different files at the same sha into two groups', () => {
    const groups = groupEntries([entry({ id: 'a', file: 'src/a.ts' }), entry({ id: 'b', file: 'src/b.ts' })]);
    expect(groups.length).toBe(2);
  });
});

describe('runDraw', () => {
  const okVerify = (byIndex: Record<number, 'confirmed' | 'refuted' | 'out_of_scope'>) =>
    (async (_deps: unknown, p: { requests: Array<{ id: string }> }) => ({
      results: p.requests.map((r, i) => ({
        id: r.id,
        verdict: byIndex[i + 1] ?? 'confirmed',
        evidence: `e${i + 1}`,
      })),
      usage: { ...EMPTY_USAGE, calls: 1, promptTokens: 10, completionTokens: 2 },
    })) as never;

  const deps = { endpoint: 'e', apiKey: 'k', model: 'm' };

  it('scores an entry correct when the verdict matches the expectation', async () => {
    const out = await runDraw({
      entries: [entry({ id: 'a', expected: 'confirmed' })],
      instructions: 'verify',
      readBody: () => 'body',
      verify: okVerify({ 1: 'confirmed' }),
      deps,
    });
    expect(out.outcomes).toEqual([
      { id: 'a', expected: 'confirmed', actual: 'confirmed', correct: true, evidence: 'e1', provenance: 'harvested' },
    ]);
  });

  it('scores an entry wrong when the verdict differs', async () => {
    const out = await runDraw({
      entries: [entry({ id: 'a', expected: 'refuted' })],
      instructions: 'verify',
      readBody: () => 'body',
      verify: okVerify({ 1: 'confirmed' }),
      deps,
    });
    expect(out.outcomes[0].correct).toBe(false);
  });

  // #691's lesson: a harness failure made a candidate look blind. An `error` is
  // not the model answering wrongly, so it must not be scored as a wrong answer.
  it('marks an error neither correct nor incorrect', async () => {
    const errorVerify = (async (_d: unknown, p: { requests: Array<{ id: string }> }) => ({
      results: p.requests.map((r) => ({ id: r.id, verdict: 'error' as const, evidence: 'empty completion' })),
      usage: { ...EMPTY_USAGE, calls: 1 },
    })) as never;

    const out = await runDraw({
      entries: [entry({ id: 'a', expected: 'refuted' })],
      instructions: 'verify',
      readBody: () => 'body',
      verify: errorVerify,
      deps,
    });
    expect(out.outcomes[0].actual).toBe('error');
    expect(out.outcomes[0].correct).toBe(false);
  });

  // Each group must see ITS OWN sha's body. If the runner passed one body to both,
  // one of the two answers would be judged against the wrong code.
  it('gives each group the body of its own sha', async () => {
    const seen: string[] = [];
    const spy = (async (_d: unknown, p: { fileContent: (path: string) => string | null; requests: Array<{ id: string; file: string }> }) => {
      seen.push(p.fileContent(p.requests[0].file) ?? 'null');
      return {
        results: p.requests.map((r) => ({ id: r.id, verdict: 'confirmed' as const, evidence: 'e' })),
        usage: { ...EMPTY_USAGE, calls: 1 },
      };
    }) as never;

    await runDraw({
      entries: [entry({ id: 'a', sha: 'aaa' }), entry({ id: 'b', sha: 'bbb' })],
      instructions: 'verify',
      readBody: (sha) => `body-of-${sha}`,
      verify: spy,
      deps,
    });

    expect(seen.sort()).toEqual(['body-of-aaa', 'body-of-bbb']);
  });

  it('sums usage across groups', async () => {
    const out = await runDraw({
      entries: [entry({ id: 'a', sha: 'aaa' }), entry({ id: 'b', sha: 'bbb' })],
      instructions: 'verify',
      readBody: () => 'body',
      verify: okVerify({}),
      deps,
    });
    expect(out.usage.calls).toBe(2);
  });

  it('reports an unreadable body as an error rather than throwing', async () => {
    const out = await runDraw({
      entries: [entry({ id: 'a' })],
      instructions: 'verify',
      readBody: () => null,
      verify: okVerify({}),
      deps,
    });
    expect(out.outcomes[0].actual).toBe('error');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-review/verify-corpus-run.test.ts`
Expected: FAIL — `Failed to resolve import "./verify-corpus-run"`.

- [ ] **Step 3: Write the grouping and the draw**

Create `scripts/ai-review/verify-corpus-run.ts`:

```typescript
/**
 * One draw of the verify corpus: every entry adjudicated by one model, scored
 * against the verdict we checked ourselves.
 *
 * Design: docs/superpowers/specs/2026-09/2026-09-23-verify-corpus-and-runner-design.md
 */
import { execFileSync } from 'node:child_process';
import type { OpenAiDeps } from './openai';
import { EMPTY_USAGE, addUsage, type Usage } from './usage';
import type { CorpusEntry } from './verify-corpus';
import { verifyAll } from './verify';

export interface CorpusGroup {
  sha: string;
  file: string;
  entries: CorpusEntry[];
}

/**
 * Group by the PAIR `(sha, file)`, never by file alone.
 *
 * `verifyAll` batches one call per file path and its `fileContent` callback takes
 * only a path, so it cannot tell two shas apart. Handing it the whole corpus would
 * put the same path at two shas into one call against one body, and one of the two
 * answers would then be judged against code it was never about. The rule therefore
 * lives here, in the runner, and so does its test.
 */
export function groupEntries(entries: CorpusEntry[]): CorpusGroup[] {
  const groups = new Map<string, CorpusGroup>();
  for (const e of entries) {
    const key = `${e.sha}\u0000${e.file}`;
    const existing = groups.get(key);
    if (existing) existing.entries.push(e);
    else groups.set(key, { sha: e.sha, file: e.file, entries: [e] });
  }
  return [...groups.values()];
}

export interface EntryOutcome {
  id: string;
  expected: 'confirmed' | 'refuted';
  actual: 'confirmed' | 'refuted' | 'out_of_scope' | 'error';
  /** False for a wrong verdict AND for an `error`; read it with `actual`. */
  correct: boolean;
  evidence: string;
  provenance: 'harvested' | 'constructed';
}

/** Read one file body out of git at a pinned sha. Never throws. */
export function gitBody(sha: string, file: string): string | null {
  try {
    return execFileSync('git', ['show', `${sha}:${file}`], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export async function runDraw(p: {
  entries: CorpusEntry[];
  instructions: string;
  readBody: (sha: string, file: string) => string | null;
  verify: typeof verifyAll;
  deps: OpenAiDeps;
  maxCompletionTokens?: number;
}): Promise<{ outcomes: EntryOutcome[]; usage: Usage }> {
  const byId = new Map<string, EntryOutcome>();
  let usage = EMPTY_USAGE;

  for (const group of groupEntries(p.entries)) {
    const body = p.readBody(group.sha, group.file);
    const { results, usage: groupUsage } = await p.verify(p.deps, {
      instructions: p.instructions,
      requests: group.entries.map((e) => ({
        id: e.id,
        file: e.file,
        matchedLine: e.matchedLine,
        matchedEndLine: e.matchedEndLine,
        quote: e.quote,
        claim: e.claim,
        why_it_breaks: e.why_it_breaks,
      })),
      // Bound to THIS group's sha. `verifyAll` only ever asks for `group.file`
      // inside this call, so returning the same body for any path is correct here
      // and wrong anywhere else.
      fileContent: () => body,
      maxCompletionTokens: p.maxCompletionTokens,
    });
    usage = addUsage(usage, groupUsage);

    for (const entry of group.entries) {
      const result = results.find((r) => r.id === entry.id);
      const actual = (result?.verdict ?? 'error') as EntryOutcome['actual'];
      byId.set(entry.id, {
        id: entry.id,
        expected: entry.expected,
        actual,
        correct: actual === entry.expected,
        evidence: result?.evidence ?? '',
        provenance: entry.provenance,
      });
    }
  }

  return { outcomes: p.entries.map((e) => byId.get(e.id)!), usage };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-review/verify-corpus-run.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Mutation-prove the grouping key and the error handling**

1. In `groupEntries`, change the key to `const key = e.file;`.
   Run the test file. Expected: **`splits the same file at different shas into two groups` FAILS** and **`gives each group the body of its own sha` FAILS**. Restore.
2. In `runDraw`, change `correct: actual === entry.expected` to
   `correct: actual === 'error' ? true : actual === entry.expected`.
   Run the test file. Expected: **`marks an error neither correct nor incorrect` FAILS**. Restore.

Record both results in the task report.

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: all tests pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add scripts/ai-review/verify-corpus-run.ts scripts/ai-review/verify-corpus-run.test.ts
git commit -m "feat(verify-corpus): групування за парою (sha, file) і одна тяга по корпусу

verifyAll групує за ШЛЯХОМ і його fileContent не бачить sha, тож один шлях у
двох деревах він склав би в один виклик проти одного тіла — і одна з двох
відповідей судилася б проти коду, про який вона не була. Тому правило належить
прогонялці, і тут же його тест.

error не зараховується ні правильним, ні неправильним: на #691 збій харнесу
зробив кандидата схожим на сліпого, і звіт, що тихо рахував би error як хибний
вердикт, повторив би це системно."
```

---

### Task 4: The report, and the CLI

**Files:**
- Create: `scripts/ai-review/verify-corpus-report.ts`
- Create: `scripts/ai-review/verify-corpus-report.test.ts`
- Create: `scripts/ai-review/verify-corpus-cli.ts`
- Modify: `package.json` (add the `verify-corpus` script)

**Interfaces:**
- Consumes: `EntryOutcome` from `./verify-corpus-run` (Task 3); `loadCorpus` from `./verify-corpus` (Task 1); `costUsd`, `formatTokens` from `./usage`.
- Produces: `export function formatReport(p: { model: string; draws: EntryOutcome[][]; usage: Usage; costUsd: number | null }): string`

- [ ] **Step 1: Write the failing tests**

Create `scripts/ai-review/verify-corpus-report.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE } from './usage';
import { formatReport } from './verify-corpus-report';
import type { EntryOutcome } from './verify-corpus-run';

const outcome = (over: Partial<EntryOutcome>): EntryOutcome => ({
  id: 'a',
  expected: 'confirmed',
  actual: 'confirmed',
  correct: true,
  evidence: 'e',
  provenance: 'harvested',
  ...over,
});

const usage = { ...EMPTY_USAGE, calls: 1, promptTokens: 100, completionTokens: 10 };

describe('formatReport', () => {
  // Global constraint: the corpus is skewed (6 confirmed vs 13 refuted when
  // complete), so a judge answering `refuted` to everything scores 68%. A single
  // percentage would hide exactly that, so the report must not print one.
  it('reports counts per expected verdict, not one overall percentage', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [[outcome({ id: 'a', expected: 'confirmed', actual: 'confirmed', correct: true }),
               outcome({ id: 'b', expected: 'refuted', actual: 'confirmed', correct: false })]],
      usage,
      costUsd: 0.01,
    });
    expect(text).toMatch(/confirmed\D+1\/1/);
    expect(text).toMatch(/refuted\D+0\/1/);
    expect(text).not.toMatch(/\b50%/);
  });

  it('keeps provenance counts separate', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [[outcome({ id: 'a', provenance: 'harvested', correct: true }),
               outcome({ id: 'b', provenance: 'constructed', expected: 'refuted', actual: 'confirmed', correct: false })]],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/harvested/);
    expect(text).toMatch(/constructed/);
    // Provenances must not be merged into one figure.
    expect(text).not.toMatch(/all sources\D+1\/2/);
  });

  it('counts errors in their own column', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [[outcome({ id: 'a', actual: 'error', correct: false })]],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/error\D+1/);
  });

  it('prints a union line across draws', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [
        [outcome({ id: 'a', correct: false, actual: 'refuted' })],
        [outcome({ id: 'a', correct: true, actual: 'confirmed' })],
      ],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/union/i);
  });

  it('names the cost as unpriced rather than zero when the model has no price', () => {
    const text = formatReport({ model: 'mystery-1', draws: [[outcome({})]], usage, costUsd: null });
    expect(text).toMatch(/unpriced/);
    expect(text).not.toMatch(/\$0\.00/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-review/verify-corpus-report.test.ts`
Expected: FAIL — `Failed to resolve import "./verify-corpus-report"`.

- [ ] **Step 3: Write the report**

Create `scripts/ai-review/verify-corpus-report.ts`:

```typescript
/**
 * The verify-corpus scoreboard.
 *
 * Deliberately prints no single overall percentage. The corpus is skewed toward
 * `refuted` (6 known-true against 13 known-false when complete), so a judge that
 * answers `refuted` to everything would score 68% — which reads as work. Counts
 * are therefore split by expected verdict and by provenance, and a model that
 * fails the `confirmed` row is rejected whatever the `refuted` row says.
 */
import { formatTokens, type Usage } from './usage';
import type { EntryOutcome } from './verify-corpus-run';

function tally(outcomes: EntryOutcome[], pick: (o: EntryOutcome) => boolean): string {
  const rows = outcomes.filter(pick);
  const right = rows.filter((o) => o.correct).length;
  return `${right}/${rows.length}`;
}

export function formatReport(p: {
  model: string;
  draws: EntryOutcome[][];
  usage: Usage;
  costUsd: number | null;
}): string {
  const lines: string[] = [`=== verify corpus · ${p.model} · ${p.draws.length} draw(s) ===`, ''];

  p.draws.forEach((draw, i) => {
    const errors = draw.filter((o) => o.actual === 'error').length;
    lines.push(
      `draw ${i + 1}: confirmed ${tally(draw, (o) => o.expected === 'confirmed')} · ` +
        `refuted ${tally(draw, (o) => o.expected === 'refuted')} · ` +
        `harvested ${tally(draw, (o) => o.provenance === 'harvested')} · ` +
        `constructed ${tally(draw, (o) => o.provenance === 'constructed')} · ` +
        `error ${errors}`,
    );
  });

  // Union: an entry counts as answered correctly if ANY draw got it right. Reported
  // beside the per-draw rows and never instead of them — conflating the two is the
  // 2026-09-22 mistake (a union of three runs compared against a single draw).
  const ids = [...new Set(p.draws.flat().map((o) => o.id))];
  const unionRows: EntryOutcome[] = ids.map((id) => {
    const all = p.draws.flat().filter((o) => o.id === id);
    return all.find((o) => o.correct) ?? all[0];
  });
  lines.push(
    '',
    `union: confirmed ${tally(unionRows, (o) => o.expected === 'confirmed')} · ` +
      `refuted ${tally(unionRows, (o) => o.expected === 'refuted')}`,
  );

  lines.push('', '--- wrong or errored, by entry ---');
  for (const o of unionRows.filter((o) => !o.correct)) {
    lines.push(`  ${o.id}: expected ${o.expected}, got ${o.actual} — ${o.evidence.slice(0, 160)}`);
  }

  const cost = p.costUsd === null ? '(unpriced model)' : `$${p.costUsd.toFixed(4)}`;
  lines.push(
    '',
    `cost: ${p.usage.calls} call(s) ${formatTokens(p.usage.promptTokens)}→${formatTokens(p.usage.completionTokens)} · ${cost}`,
  );
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-review/verify-corpus-report.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Mutation-prove the no-single-percentage rule**

In `formatReport`, add this line just before the `return`:

```typescript
  lines.push(`overall: ${Math.round((100 * p.draws.flat().filter((o) => o.correct).length) / p.draws.flat().length)}%`);
```

Run the test file. Expected: **`reports counts per expected verdict, not one overall percentage` FAILS** (it matches `50%`). Restore.

Record the result in the task report.

- [ ] **Step 6: Write the CLI**

Create `scripts/ai-review/verify-corpus-cli.ts`:

```typescript
/**
 * `npm run verify-corpus -- --model <m> [--draws N] [--only <id-prefix>]`
 *
 * Scores one model against the labelled verify corpus. Posts nothing, writes
 * nothing, reads file bodies out of git at each entry's pinned sha.
 */
import { readFileSync } from 'node:fs';
import { costUsd } from './usage';
import { loadCorpus } from './verify-corpus';
import { gitBody, runDraw, type EntryOutcome } from './verify-corpus-run';
import { verifyAll } from './verify';
import { DEFAULT_MAX_COMPLETION_TOKENS } from './openai';

export function resolveArgs(argv: string[]): { model: string; draws: number; only?: string } {
  let model = '';
  let draws = 1;
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') model = argv[++i] ?? '';
    else if (a === '--draws') draws = Number(argv[++i]);
    else if (a === '--only') only = argv[++i];
    else throw new Error(`unrecognised argument: ${a}`);
  }
  if (!model) throw new Error('--model <name> is required');
  if (!Number.isInteger(draws) || draws < 1) throw new Error('--draws must be a positive integer');
  return { model, draws, only };
}

async function main(): Promise<void> {
  const { model, draws, only } = resolveArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const endpoint = process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com/v1';

  const all = loadCorpus();
  const entries = only ? all.filter((e) => e.id.startsWith(only)) : all;
  if (entries.length === 0) throw new Error(`--only ${only} matched no entry`);

  const instructions = readFileSync('.github/ai-review/VERIFY.md', 'utf8');
  const results: EntryOutcome[][] = [];
  let usage = (await import('./usage')).EMPTY_USAGE;

  for (let d = 0; d < draws; d++) {
    const out = await runDraw({
      entries,
      instructions,
      readBody: gitBody,
      verify: verifyAll,
      deps: { endpoint, apiKey, model },
      // Every judge gets the same generous budget so a verbose one does not hit
      // the production ceiling more often and lose findings to #691.
      maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS,
    });
    results.push(out.outcomes);
    usage = (await import('./usage')).addUsage(usage, out.usage);
  }

  const { formatReport } = await import('./verify-corpus-report');
  console.log(formatReport({ model, draws: results, usage, costUsd: costUsd(model, usage) }));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

- [ ] **Step 7: Add the argument tests**

Add to `scripts/ai-review/verify-corpus-report.test.ts`:

```typescript
import { resolveArgs } from './verify-corpus-cli';

describe('resolveArgs', () => {
  it('reads the model and the draw count', () => {
    expect(resolveArgs(['--model', 'gpt-5.5', '--draws', '3'])).toEqual({
      model: 'gpt-5.5',
      draws: 3,
      only: undefined,
    });
  });

  it('defaults to one draw', () => {
    expect(resolveArgs(['--model', 'gpt-5.5']).draws).toBe(1);
  });

  it('requires a model', () => {
    expect(() => resolveArgs([])).toThrow(/--model/);
  });

  // A typo must stop the run, not silently measure something else — the same rule
  // the replay CLI follows for unrecognised tokens.
  it('rejects an unrecognised argument', () => {
    expect(() => resolveArgs(['--modle', 'gpt-5.5'])).toThrow(/unrecognised/);
  });

  it('rejects a non-positive draw count', () => {
    expect(() => resolveArgs(['--model', 'm', '--draws', '0'])).toThrow(/--draws/);
  });
});
```

- [ ] **Step 8: Register the npm script**

In `package.json`, beside `"ai-review-replay"`, add:

```json
    "verify-corpus": "tsx scripts/ai-review/verify-corpus-cli.ts",
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-review/verify-corpus-report.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 10: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: all tests pass, typecheck clean.

- [ ] **Step 11: Confirm the CLI refuses to run without a key, without spending anything**

Run: `OPENAI_API_KEY= npm run verify-corpus -- --model gpt-5.5`
Expected: exits non-zero with `OPENAI_API_KEY is not set`. No API call is made.

Then: `npm run verify-corpus -- --modle gpt-5.5`
Expected: exits non-zero with `unrecognised argument: --modle`.

- [ ] **Step 12: Commit**

```bash
git add scripts/ai-review/verify-corpus-report.ts scripts/ai-review/verify-corpus-report.test.ts scripts/ai-review/verify-corpus-cli.ts package.json
git commit -m "feat(verify-corpus): звіт і CLI

Звіт свідомо не друкує єдиного відсотка: корпус перекошений у бік refuted
(6 відомо-справжніх проти 13 відомо-хибних, коли буде повний), тож суддя, що
каже refuted на все, набрав би 68% — і це читалося б як робота. Рахунки окремо
по очікуваному вердикту й окремо по походженню; union друкується ПОРУЧ із
рядками за тягу, ніколи замість них.

CLI: npm run verify-corpus -- --model <m> [--draws N] [--only <prefix>].
Нерозпізнаний аргумент спиняє прогін, а не міряє мовчки щось інше."
```

---

## Self-Review

**1. Spec coverage.**

| spec requirement | task |
|---|---|
| corpus data file beside the runner, zod-validated, invalid entry fails the load | Task 1 |
| `sha`, `quoteOrigin`, `why_expected` on every entry | Task 1 |
| `out_of_scope` not a valid `expected` in v1 | Task 1 (test + mutation) |
| the six seed entries, with the batching pair and the different-sha pair | Task 1 |
| grouping by `(sha, file)`, bodies via `git show <sha>:<path>` | Task 3 |
| reuse `verifyAll` per group with a sha-bound `fileContent` | Task 3 |
| the 8000-token budget the runner sets | Task 2 (parameter) + Task 4 (CLI passes it) |
| `error` as a third outcome, not a wrong answer | Task 3 (scoring) + Task 4 (its own column) |
| per-draw and union, split by provenance and expected verdict, no single percentage | Task 4 |
| agreement with the incumbent as a secondary column | **gap — see below** |
| CLI `npm run verify-corpus -- --model <m> [--draws N] [--only <id>]` | Task 4 |

**One gap, ruled rather than papered over.** The spec mentions printing agreement with the
incumbent judge as a secondary column. That requires a *second* model's outcomes in the same
report, which the CLI's one-model shape does not carry, and the spec itself says agreement is
"interesting but not the metric". Building a two-model mode for a secondary column is scope
the measurement does not need: two separate runs plus `diff` answers the same question. **Ruled:
out of stage 1.** Recorded here so the reviewer does not treat it as an oversight, and noted
for stage 2 if a real use appears.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code
step carries the code. Every seed value was read out of the named tree on 2026-09-23.

**2b. Probed while writing the plan, so the implementer does not have to.** zod is `^4.6.5`
(`package.json:50`), and in it `z.string().trim().min(1)` rejects `''` and `'   '` **and
transforms** the parsed value — which is why `quote` uses a separate non-trimming schema.
`DEFAULT_MAX_COMPLETION_TOKENS = 8000` is exported at `scripts/ai-review/openai.ts:24`,
`formatTokens` at `usage.ts:131`, and `.github/ai-review/VERIFY.md` exists (2 592 bytes).

**3. Type consistency.** `CorpusEntry` (Task 1) is consumed by `groupEntries` and `runDraw`
(Task 3) and `loadCorpus` (Task 4). `EntryOutcome` (Task 3) is consumed by `formatReport`
(Task 4). `verifyAll`'s new optional `maxCompletionTokens` (Task 2) is passed by `runDraw`
(Task 3) and set by the CLI (Task 4). `gitBody(sha, file)` matches `runDraw`'s
`readBody: (sha, file) => string | null`. `DEFAULT_MAX_COMPLETION_TOKENS` is already exported
from `openai.ts` — verified, not assumed.

**4. Ordering note for the executor.** Task 2 has no dependency on Task 1 and can run in
either order, but Task 3 needs both. Task 4 needs Tasks 1, 2 and 3.
