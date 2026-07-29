# Two-stage AI PR review (greedy find + strict verify) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-pass AI PR reviewer with a greedy structured find pass, a pure mechanical evidence gate, and a per-finding verification pass, so that every published finding quotes code that provably exists in a region the PR touched.

**Architecture:** `scripts/ai-pr-review.ts` becomes a thin orchestrator over a new `scripts/ai-review/` module set. Pass 1 asks for JSON findings with verbatim quotes; a pure function drops findings whose quote is absent from the file or lands outside the PR's changed lines; pass 2 re-asks the model per surviving finding with the full file in context and publishes only `confirmed`. Model IDs come from env; the request shape uses `max_completion_tokens` and omits `temperature` (both forced by the live API probe recorded in the spec).

**Tech Stack:** TypeScript (CommonJS, `strict`), Vitest (`globals: true`, include already covers `scripts/**/*.test.ts`), `zod` (already a dependency), bare `fetch` (no OpenAI SDK — the current script uses `fetch` and we keep it that way), `tsx` for running scripts.

**Spec:** `docs/superpowers/specs/2026-07/2026-07-28-ai-review-quality-design.md`

---

## File Structure

| File | Responsibility | Network |
|---|---|---|
| `scripts/ai-review/types.ts` | shared finding types | no |
| `scripts/ai-review/gate.ts` | quote location, changed-line parsing, mechanical gate (pure) | no |
| `scripts/ai-review/context.ts` | diff + full file bodies + budget degradation | no |
| `scripts/ai-review/openai.ts` | structured chat call, retries, error classes | yes |
| `scripts/ai-review/find.ts` | pass-1 schema + call | yes |
| `scripts/ai-review/verify.ts` | pass-2 schema + per-finding call | yes |
| `scripts/ai-review/render.ts` | review body + counters | no |
| `scripts/ai-review/replay.ts` | run pipeline on a PR without posting | yes |
| `scripts/ai-pr-review.ts` | config, scope globs, git, `upsertReview`, orchestration | yes |
| `.github/ai-review/AGENTS.md` | pass-1 prompt (rewritten: coverage-first) | — |
| `.github/ai-review/VERIFY.md` | pass-2 prompt (new: adversarial) | — |

`vitest.config.ts` already includes `scripts/**/*.test.ts`, and `INCLUDE_PATTERNS` already contains `scripts/**/*.ts`, so the new directory is both tested and self-reviewed with no config change.

---

## Task 1: Label the precision baseline

No code. This produces the ground truth the whole change is measured against, and the spec explicitly defers it here rather than assuming it.

**Files:**
- Create: `docs/superpowers/specs/2026-07/2026-07-28-ai-review-baseline-labels.md`

- [ ] **Step 1: Pull the 18 existing findings**

```bash
for pr in 344 348 352 356 358; do
  echo "=== PR $pr ==="
  gh api repos/:owner/:repo/pulls/$pr/reviews \
    --jq '.[] | select(.body | contains("ai-pr-review")) | .body'
done > /tmp/claude-1000/-home-ysi-warsaw-beer-bot/*/scratchpad/baseline-reviews.txt
```

- [ ] **Step 2: Label each finding**

For every finding record: PR, ordinal, one-line summary, and a label of exactly one of:

- `real` — describes a genuine defect in that PR's diff
- `false` — contradicted by the code (e.g. #348 finding 1: `ALTER TABLE … RENAME COLUMN` preserves data; #352 findings 2–3: that PR is what adds `'merged'`)
- `unfalsifiable` — speculation about code not shown, or a generic "add error handling / add tests" with no concrete failure path

Verify each claim against the merged tree before labelling — `git show <sha> -- <file>`. Do not label from the review text alone.

- [ ] **Step 3: Write the table**

```markdown
# AI review precision baseline (pre-#175)

**Date:** 2026-07-28
**Source:** the marker reviews on PRs #344, #348, #352, #356, #358 (18 findings).

| PR | # | finding (short) | label | evidence |
|---|---|---|---|---|
| 348 | 1 | migration v20 loses data | false | `ALTER TABLE beers RENAME COLUMN` preserves data; columns empty in prod |
| 352 | 2 | `applyLookupOutcome` should return `'merged'` | false | that PR adds `EnrichOutcomeKind … 'merged'` and `return 'merged'` |
```

…one row per finding. Close with the totals (`real` / `false` / `unfalsifiable`) — those totals are the number the replay in Task 12 must beat.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07/2026-07-28-ai-review-baseline-labels.md
git commit -m "docs(#175): label the 18-finding precision baseline"
```

---

## Task 2: Shared types

**Files:**
- Create: `scripts/ai-review/types.ts`

- [ ] **Step 1: Write the types**

```typescript
export type Severity = 'P0' | 'P1' | 'P2';
export type Confidence = 'high' | 'medium' | 'low';

/** A finding exactly as pass 1 emitted it. Line numbers are NOT trusted. */
export interface RawFinding {
  file: string;
  start_line: number;
  end_line: number;
  quote: string;
  claim: string;
  why_it_breaks: string;
  severity: Severity;
  confidence: Confidence;
}

/** A finding that survived the mechanical gate, with corrected line numbers. */
export interface GatedFinding extends RawFinding {
  /** 1-based line where `quote` actually starts in the HEAD file. */
  matchedLine: number;
  /** 1-based line where `quote` actually ends. */
  matchedEndLine: number;
}

export type DropReason =
  | 'out_of_scope'
  | 'quote_not_found'
  | 'outside_changed_lines'
  | 'duplicate';

export interface DroppedFinding {
  finding: RawFinding;
  reason: DropReason;
}

export interface GateResult {
  kept: GatedFinding[];
  dropped: DroppedFinding[];
}

export type Verdict = 'confirmed' | 'refuted' | 'out_of_scope' | 'error';

export interface VerifiedFinding {
  finding: GatedFinding;
  verdict: Verdict;
  evidence: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit scripts/ai-review/types.ts`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add scripts/ai-review/types.ts
git commit -m "feat(#175): shared types for the two-stage reviewer"
```

---

## Task 3: The mechanical gate (pure, no network)

This is the highest-value, most testable unit — write it first and fully.

**Files:**
- Create: `scripts/ai-review/gate.ts`
- Test: `scripts/ai-review/gate.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { applyGate, changedLineRanges, locateQuote, normalizeWs } from './gate';
import type { RawFinding } from './types';

const base: RawFinding = {
  file: 'src/a.ts',
  start_line: 1,
  end_line: 1,
  quote: "return 'not_found';",
  claim: 'wrong outcome',
  why_it_breaks: 'merge is reported as a failure',
  severity: 'P1',
  confidence: 'medium',
};

const CONTENT = [
  'export function f() {',
  '  if (clash) {',
  "    return 'not_found';",
  '  }',
  '  return ok;',
  '}',
].join('\n');

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +2,4 @@',
  ' context',
  '+added',
  'diff --git a/src/gone.ts b/src/gone.ts',
  '--- a/src/gone.ts',
  '+++ /dev/null',
].join('\n');

describe('normalizeWs', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(normalizeWs('  a\n\t b  ')).toBe('a b');
  });
});

describe('locateQuote', () => {
  it('finds a single-line quote regardless of indentation', () => {
    expect(locateQuote(CONTENT, "return 'not_found';")).toBe(3);
  });

  it('finds a quote spanning several lines', () => {
    expect(locateQuote(CONTENT, "if (clash) {\n  return 'not_found';\n}")).toBe(2);
  });

  it('returns null when the quote is absent', () => {
    expect(locateQuote(CONTENT, "return 'merged';")).toBeNull();
  });

  it('returns null for an empty quote', () => {
    expect(locateQuote(CONTENT, '   ')).toBeNull();
  });
});

describe('changedLineRanges', () => {
  it('parses post-image hunk ranges per file and skips deletions', () => {
    const ranges = changedLineRanges(DIFF);
    expect(ranges.get('src/a.ts')).toEqual([[2, 5]]);
    expect(ranges.has('src/gone.ts')).toBe(false);
  });

  it('treats a hunk without an explicit count as one line', () => {
    const ranges = changedLineRanges('+++ b/src/b.ts\n@@ -1 +7 @@');
    expect(ranges.get('src/b.ts')).toEqual([[7, 7]]);
  });
});

describe('applyGate', () => {
  const gate = (finding: RawFinding, content: string | null = CONTENT) =>
    applyGate({
      findings: [finding],
      reviewable: ['src/a.ts'],
      changed: new Map([['src/a.ts', [[1, 6]] as Array<[number, number]>]]),
      fileContent: () => content,
    });

  it('keeps a finding whose quote exists inside the changed range', () => {
    const result = gate(base);
    expect(result.dropped).toEqual([]);
    expect(result.kept).toHaveLength(1);
  });

  it('corrects the model-reported line number to the real match', () => {
    const result = gate({ ...base, start_line: 99, end_line: 99 });
    expect(result.kept[0].matchedLine).toBe(3);
    expect(result.kept[0].matchedEndLine).toBe(3);
  });

  it('drops a hallucinated quote', () => {
    const result = gate({ ...base, quote: "return 'merged';" });
    expect(result.kept).toEqual([]);
    expect(result.dropped[0].reason).toBe('quote_not_found');
  });

  it('drops a real quote that lies outside the changed lines', () => {
    const result = applyGate({
      findings: [base],
      reviewable: ['src/a.ts'],
      changed: new Map([['src/a.ts', [[5, 6]] as Array<[number, number]>]]),
      fileContent: () => CONTENT,
    });
    expect(result.dropped[0].reason).toBe('outside_changed_lines');
  });

  it('drops a finding about a file outside the reviewed scope', () => {
    const result = gate({ ...base, file: 'docs/guide.md' });
    expect(result.dropped[0].reason).toBe('out_of_scope');
  });

  it('drops a finding whose file has no readable content', () => {
    const result = gate(base, null);
    expect(result.dropped[0].reason).toBe('out_of_scope');
  });

  it('keeps the first of two findings quoting the same code', () => {
    const result = applyGate({
      findings: [base, { ...base, claim: 'restated' }],
      reviewable: ['src/a.ts'],
      changed: new Map([['src/a.ts', [[1, 6]] as Array<[number, number]>]]),
      fileContent: () => CONTENT,
    });
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].claim).toBe('wrong outcome');
    expect(result.dropped[0].reason).toBe('duplicate');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-review/gate.test.ts`
Expected: FAIL — `Failed to resolve import "./gate"`.

- [ ] **Step 3: Implement the gate**

```typescript
import type {
  DroppedFinding,
  GateResult,
  GatedFinding,
  RawFinding,
} from './types';

/** Longest multi-line quote we will try to match, in lines. */
const MAX_QUOTE_SPAN = 40;

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 1-based line where `quote` starts in `content`, or null.
 *
 * Matching is whitespace-normalised so a re-indented or re-wrapped quote still
 * matches: line numbers are the field models get wrong most often, so we locate
 * the text and derive the position rather than trusting what was reported.
 */
export function locateQuote(content: string, quote: string): number | null {
  const needle = normalizeWs(quote);
  if (needle === '') return null;

  const lines = content.split('\n');
  const normalized = lines.map(normalizeWs);

  // Phase 1: quote fully contained within a single normalised line.
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i].includes(needle)) return i + 1;
  }

  // Phase 2: multi-line quote, anchored at the start of line i.
  // Known limitation: a multi-line quote beginning mid-line is not located, so
  // applyGate drops it as `quote_not_found` — failing closed on purpose.
  for (let i = 0; i < lines.length; i++) {
    let acc = normalized[i];
    for (let n = 1; n < MAX_QUOTE_SPAN && i + n < lines.length; n++) {
      acc = `${acc} ${normalized[i + n]}`;
      if (acc.startsWith(needle)) return i + 1;
    }
  }
  return null;
}
```

> **Correction (found during execution):** the first draft of this function used a
> single growing window with `acc.includes(needle)`. That is wrong — as soon as the
> needle appeared anywhere in the accumulated string, the function returned the
> *window start*, so a quote on line 3 was reported as line 1. The
> "corrects the model-reported line number" test above catches it. The two-phase
> version is the corrected one.

```typescript

/**
 * Post-image line ranges touched by the diff, per file.
 *
 * Hunk ranges include the surrounding context lines. That leniency is
 * deliberate: a bug on a context line immediately adjacent to a change is still
 * about this PR, and dropping it would cost us exactly the kind of finding the
 * greedy pass exists to surface.
 */
export function changedLineRanges(diff: string): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>();
  let file: string | null = null;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (file && !ranges.has(file)) ranges.set(file, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) ranges.get(file)!.push([start, start + count - 1]);
    }
  }
  return ranges;
}

function intersects(
  spans: Array<[number, number]>,
  start: number,
  end: number,
): boolean {
  return spans.some(([from, to]) => start <= to && end >= from);
}

export function applyGate(params: {
  findings: RawFinding[];
  reviewable: string[];
  changed: Map<string, Array<[number, number]>>;
  fileContent: (path: string) => string | null;
}): GateResult {
  const { findings, reviewable, changed, fileContent } = params;
  const inScope = new Set(reviewable);
  const seen = new Set<string>();
  const kept: GatedFinding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const finding of findings) {
    if (!inScope.has(finding.file)) {
      dropped.push({ finding, reason: 'out_of_scope' });
      continue;
    }

    const content = fileContent(finding.file);
    if (content === null) {
      dropped.push({ finding, reason: 'out_of_scope' });
      continue;
    }

    const matchedLine = locateQuote(content, finding.quote);
    if (matchedLine === null) {
      dropped.push({ finding, reason: 'quote_not_found' });
      continue;
    }

    const quotedLines = finding.quote.trim().split('\n').length;
    const matchedEndLine = matchedLine + quotedLines - 1;

    if (!intersects(changed.get(finding.file) ?? [], matchedLine, matchedEndLine)) {
      dropped.push({ finding, reason: 'outside_changed_lines' });
      continue;
    }

    const key = `${finding.file}::${normalizeWs(finding.quote)}`;
    if (seen.has(key)) {
      dropped.push({ finding, reason: 'duplicate' });
      continue;
    }
    seen.add(key);

    kept.push({ ...finding, matchedLine, matchedEndLine });
  }

  return { kept, dropped };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-review/gate.test.ts`
Expected: PASS — 15 tests (14 from the block above, plus the mid-line-limitation test added during execution).

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/gate.ts scripts/ai-review/gate.test.ts
git commit -m "feat(#175): mechanical evidence gate for review findings"
```

---

## Task 4: Review context (diff + full file bodies)

**Files:**
- Create: `scripts/ai-review/context.ts`
- Test: `scripts/ai-review/context.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { buildReviewContext, fileChurn } from './context';

const DIFF = [
  '--- a/src/small.ts',
  '+++ b/src/small.ts',
  '@@ -1,1 +1,2 @@',
  '+one',
  '--- a/src/big.ts',
  '+++ b/src/big.ts',
  '@@ -1,1 +1,4 @@',
  '+one',
  '+two',
  '+three',
  '-gone',
].join('\n');

describe('fileChurn', () => {
  it('counts added and removed lines per file', () => {
    const churn = fileChurn(DIFF);
    expect(churn.get('src/big.ts')).toBe(4);
    expect(churn.get('src/small.ts')).toBe(1);
  });
});

describe('buildReviewContext', () => {
  const readFile = (p: string) => (p === 'src/big.ts' ? 'BIG BODY' : 'SMALL BODY');

  it('always includes the diff', () => {
    const { text } = buildReviewContext({
      diff: DIFF,
      reviewable: ['src/big.ts', 'src/small.ts'],
      readFile,
    });
    expect(text).toContain('@@ -1,1 +1,4 @@');
  });

  it('includes full file bodies, most-changed first', () => {
    const { text, diffOnly } = buildReviewContext({
      diff: DIFF,
      reviewable: ['src/small.ts', 'src/big.ts'],
      readFile,
    });
    expect(text.indexOf('BIG BODY')).toBeLessThan(text.indexOf('SMALL BODY'));
    expect(diffOnly).toEqual([]);
  });

  it('degrades to diff-only for files that do not fit the budget', () => {
    const { text, diffOnly } = buildReviewContext({
      diff: DIFF,
      reviewable: ['src/big.ts', 'src/small.ts'],
      readFile,
      budget: DIFF.length + 60,
    });
    expect(text).toContain('BIG BODY');
    expect(text).not.toContain('SMALL BODY');
    expect(diffOnly).toEqual(['src/small.ts']);
    expect(text).toContain('you see only the diff');
  });

  it('lists a deleted file as diff-only instead of throwing', () => {
    const { diffOnly } = buildReviewContext({
      diff: DIFF,
      reviewable: ['src/big.ts', 'src/small.ts'],
      readFile: (p) => (p === 'src/big.ts' ? 'BIG BODY' : null),
    });
    expect(diffOnly).toEqual(['src/small.ts']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-review/context.test.ts`
Expected: FAIL — `Failed to resolve import "./context"`.

- [ ] **Step 3: Implement the context builder**

```typescript
/** Total context budget in characters. Roughly 60k tokens. */
export const CONTEXT_BUDGET = 240_000;

/** Added + removed lines per post-image file path. */
export function fileChurn(diff: string): Map<string, number> {
  const churn = new Map<string, number>();
  let file: string | null = null;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (file && !churn.has(file)) churn.set(file, 0);
      continue;
    }
    if (!file) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) {
      churn.set(file, (churn.get(file) ?? 0) + 1);
    }
  }
  return churn;
}

export function buildReviewContext(params: {
  diff: string;
  reviewable: string[];
  readFile: (path: string) => string | null;
  budget?: number;
}): { text: string; diffOnly: string[] } {
  const { diff, reviewable, readFile } = params;
  const budget = params.budget ?? CONTEXT_BUDGET;
  const churn = fileChurn(diff);

  const ordered = [...reviewable].sort(
    (a, b) => (churn.get(b) ?? 0) - (churn.get(a) ?? 0) || a.localeCompare(b),
  );

  const sections: string[] = ['# Diff', '```diff', diff, '```'];
  let used = diff.length;
  const bodies: string[] = [];
  const diffOnly: string[] = [];

  for (const path of ordered) {
    const content = readFile(path);
    if (content === null) {
      diffOnly.push(path);
      continue;
    }
    const block = `## ${path}\n\`\`\`\n${content}\n\`\`\``;
    if (used + block.length > budget) {
      diffOnly.push(path);
      continue;
    }
    used += block.length;
    bodies.push(block);
  }

  if (bodies.length > 0) {
    sections.push('', '# Full contents of changed files (at HEAD)', ...bodies);
  }

  if (diffOnly.length > 0) {
    sections.push(
      '',
      '# Files where you see only the diff',
      ...diffOnly.map((p) => `- ${p}`),
      '',
      'For the files above you see only the diff. Do not make any claim about the',
      'parts of those files you were not shown — if a claim would require reading',
      'code that is not in this message, do not report it.',
    );
  }

  return { text: sections.join('\n'), diffOnly };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-review/context.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/context.ts scripts/ai-review/context.test.ts
git commit -m "feat(#175): review context with full file bodies and budget degradation"
```

---

## Task 5: Structured OpenAI client

The request shape here is not a style choice — the live probe recorded in the spec shows `max_tokens` returns HTTP 400 on every `gpt-5.x` model and `temperature: 0` returns HTTP 400 on `gpt-5.5`. The tests below lock both facts in.

**Files:**
- Create: `scripts/ai-review/openai.ts`
- Test: `scripts/ai-review/openai.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { callStructured, NonRetryableError } from './openai';

const SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

const deps = (fetchFn: typeof fetch) => ({
  endpoint: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-5.4-mini',
  fetchFn,
  sleep: async () => {},
});

const ok = (content: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as Response;

describe('callStructured', () => {
  it('sends max_completion_tokens and never max_tokens or temperature', async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return ok('{}');
    }) as unknown as typeof fetch;

    await callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
      name: 'review',
      schema: SCHEMA,
    });

    expect(body.max_completion_tokens).toBe(8000);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'review', strict: true, schema: SCHEMA },
    });
  });

  it('returns the completion content on success', async () => {
    const fetchFn = (async () => ok('{"a":1}')) as unknown as typeof fetch;
    const out = await callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
      name: 'review',
      schema: SCHEMA,
    });
    expect(out).toBe('{"a":1}');
  });

  it('retries a 500 then succeeds', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response;
      return ok('{}');
    }) as unknown as typeof fetch;

    await callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
      name: 'review',
      schema: SCHEMA,
    });
    expect(calls).toBe(2);
  });

  it('does not retry a 400 and surfaces the API message', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return {
        ok: false,
        status: 400,
        text: async () => "Unsupported parameter: 'max_tokens'",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
        name: 'review',
        schema: SCHEMA,
      }),
    ).rejects.toThrow(/Unsupported parameter/);
    expect(calls).toBe(1);
  });

  it('treats an empty completion as non-retryable', async () => {
    const fetchFn = (async () =>
      ({ ok: true, status: 200, json: async () => ({ choices: [] }) }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
        name: 'review',
        schema: SCHEMA,
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-review/openai.test.ts`
Expected: FAIL — `Failed to resolve import "./openai"`.

- [ ] **Step 3: Implement the client**

```typescript
export class NonRetryableError extends Error {}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface JsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
}

export interface OpenAiDeps {
  endpoint: string;
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

export const DEFAULT_MAX_COMPLETION_TOKENS = 8000;

/**
 * One structured chat completion.
 *
 * Deliberately sends neither `temperature` nor `max_tokens`: the 2026-07-28 API
 * probe showed `max_tokens` is rejected with HTTP 400 on every gpt-5.x model,
 * and `temperature: 0` is rejected on gpt-5.5. Determinism comes from the
 * schema and the verification pass, not from sampling parameters.
 */
export async function callStructured(
  deps: OpenAiDeps,
  messages: ChatMessage[],
  format: JsonSchemaFormat,
  maxCompletionTokens: number = DEFAULT_MAX_COMPLETION_TOKENS,
): Promise<string> {
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
          model: deps.model,
          max_completion_tokens: maxCompletionTokens,
          response_format: {
            type: 'json_schema',
            json_schema: { name: format.name, strict: true, schema: format.schema },
          },
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

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-review/openai.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/openai.ts scripts/ai-review/openai.test.ts
git commit -m "feat(#175): structured OpenAI client with probe-verified request shape"
```

---

## Task 6: Pass 1 — greedy find

**Files:**
- Create: `scripts/ai-review/find.ts`
- Test: `scripts/ai-review/find.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { runFind } from './find';

const respond = (content: string) =>
  (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as unknown as Response) as unknown as typeof fetch;

const deps = (fetchFn: typeof fetch) => ({
  endpoint: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-5.4-mini',
  fetchFn,
  sleep: async () => {},
});

const payload = {
  findings: [
    {
      file: 'src/a.ts',
      start_line: 3,
      end_line: 3,
      quote: "return 'not_found';",
      claim: 'merge reported as failure',
      why_it_breaks: 'cron stats count a success as a miss',
      severity: 'P1',
      confidence: 'medium',
    },
  ],
};

describe('runFind', () => {
  it('parses findings out of the structured response', async () => {
    const findings = await runFind(deps(respond(JSON.stringify(payload))), {
      instructions: 'find things',
      context: '# Diff',
      prTitle: 'T',
      prBody: 'B',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('src/a.ts');
  });

  it('returns an empty list when the model reports nothing', async () => {
    const findings = await runFind(deps(respond('{"findings":[]}')), {
      instructions: 'find things',
      context: '# Diff',
      prTitle: 'T',
      prBody: 'B',
    });
    expect(findings).toEqual([]);
  });

  it('fails loudly on unparseable output', async () => {
    await expect(
      runFind(deps(respond('not json')), {
        instructions: 'x',
        context: 'y',
        prTitle: 'T',
        prBody: 'B',
      }),
    ).rejects.toThrow(/could not be parsed/i);
  });

  it('fails loudly when the payload does not match the schema', async () => {
    await expect(
      runFind(deps(respond('{"findings":[{"file":"a"}]}')), {
        instructions: 'x',
        context: 'y',
        prTitle: 'T',
        prBody: 'B',
      }),
    ).rejects.toThrow(/schema/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-review/find.test.ts`
Expected: FAIL — `Failed to resolve import "./find"`.

- [ ] **Step 3: Implement pass 1**

```typescript
import { z } from 'zod';
import { callStructured, type OpenAiDeps } from './openai';
import type { RawFinding } from './types';

export const FINDINGS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'file',
          'start_line',
          'end_line',
          'quote',
          'claim',
          'why_it_breaks',
          'severity',
          'confidence',
        ],
        properties: {
          file: { type: 'string', description: 'repo-relative path, exactly as shown' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          quote: {
            type: 'string',
            description: 'verbatim copy of the offending code, exactly as it appears',
          },
          claim: { type: 'string', description: 'one sentence: what is wrong' },
          why_it_breaks: {
            type: 'string',
            description: 'concrete failure path: input or state -> wrong result',
          },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

const findingSchema = z.object({
  file: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  quote: z.string(),
  claim: z.string(),
  why_it_breaks: z.string(),
  severity: z.enum(['P0', 'P1', 'P2']),
  confidence: z.enum(['high', 'medium', 'low']),
});

const payloadSchema = z.object({ findings: z.array(findingSchema) });

export async function runFind(
  deps: OpenAiDeps,
  p: { instructions: string; context: string; prTitle: string; prBody: string },
): Promise<RawFinding[]> {
  const user = [
    '# Pull request',
    `Title: ${p.prTitle}`,
    '',
    '## Body',
    p.prBody || '(no description)',
    '',
    p.context,
  ].join('\n');

  const raw = await callStructured(
    deps,
    [
      { role: 'system', content: p.instructions },
      { role: 'user', content: user },
    ],
    { name: 'review_findings', schema: FINDINGS_SCHEMA },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Pass-1 output could not be parsed as JSON: ${raw.slice(0, 300)}`);
  }

  const result = payloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Pass-1 output did not match the schema: ${result.error.message.slice(0, 300)}`);
  }
  return result.data.findings;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-review/find.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/find.ts scripts/ai-review/find.test.ts
git commit -m "feat(#175): greedy structured find pass"
```

---

## Task 7: Pass 2 — adversarial verification

**Files:**
- Create: `scripts/ai-review/verify.ts`
- Test: `scripts/ai-review/verify.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { verifyAll } from './verify';
import type { GatedFinding } from './types';

const finding: GatedFinding = {
  file: 'src/a.ts',
  start_line: 3,
  end_line: 3,
  matchedLine: 3,
  matchedEndLine: 3,
  quote: "return 'not_found';",
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  confidence: 'medium',
};

const respond = (content: string) =>
  (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as unknown as Response) as unknown as typeof fetch;

const deps = (fetchFn: typeof fetch) => ({
  endpoint: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-5.5',
  fetchFn,
  sleep: async () => {},
});

describe('verifyAll', () => {
  it('publishes a confirmed finding', async () => {
    const out = await verifyAll(deps(respond('{"verdict":"confirmed","evidence":"line 3 returns not_found"}')), {
      instructions: 'verify',
      findings: [finding],
      fileContent: () => 'file body',
    });
    expect(out.confirmed).toHaveLength(1);
    expect(out.rejected).toEqual([]);
  });

  it('withholds a refuted finding', async () => {
    const out = await verifyAll(deps(respond('{"verdict":"refuted","evidence":"the PR already returns merged"}')), {
      instructions: 'verify',
      findings: [finding],
      fileContent: () => 'file body',
    });
    expect(out.confirmed).toEqual([]);
    expect(out.rejected[0].verdict).toBe('refuted');
  });

  it('withholds a finding whose verification call fails, without throwing', async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 400, text: async () => 'nope' }) as unknown as Response) as unknown as typeof fetch;

    const out = await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      findings: [finding],
      fileContent: () => 'file body',
    });
    expect(out.confirmed).toEqual([]);
    expect(out.rejected[0].verdict).toBe('error');
  });

  it('withholds a finding whose file body vanished', async () => {
    const out = await verifyAll(deps(respond('{"verdict":"confirmed","evidence":"x"}')), {
      instructions: 'verify',
      findings: [finding],
      fileContent: () => null,
    });
    expect(out.confirmed).toEqual([]);
    expect(out.rejected[0].verdict).toBe('error');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-review/verify.test.ts`
Expected: FAIL — `Failed to resolve import "./verify"`.

- [ ] **Step 3: Implement pass 2**

```typescript
import { z } from 'zod';
import { callStructured, type OpenAiDeps } from './openai';
import type { GatedFinding, VerifiedFinding, Verdict } from './types';

export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'evidence'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'out_of_scope'] },
    evidence: {
      type: 'string',
      description: 'one sentence citing the code that settles it',
    },
  },
};

const verdictSchema = z.object({
  verdict: z.enum(['confirmed', 'refuted', 'out_of_scope']),
  evidence: z.string(),
});

export async function verifyFinding(
  deps: OpenAiDeps,
  p: { instructions: string; finding: GatedFinding; fileContent: string },
): Promise<{ verdict: Verdict; evidence: string }> {
  const user = [
    '# Finding to adjudicate',
    `File: ${p.finding.file}`,
    `Lines: ${p.finding.matchedLine}-${p.finding.matchedEndLine}`,
    `Claim: ${p.finding.claim}`,
    `Alleged failure: ${p.finding.why_it_breaks}`,
    '',
    'Quoted code:',
    '```',
    p.finding.quote,
    '```',
    '',
    `# Full current contents of ${p.finding.file}`,
    '```',
    p.fileContent,
    '```',
  ].join('\n');

  const raw = await callStructured(
    deps,
    [
      { role: 'system', content: p.instructions },
      { role: 'user', content: user },
    ],
    { name: 'review_verdict', schema: VERDICT_SCHEMA },
    2000,
  );

  const parsed = verdictSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Pass-2 output did not match the schema: ${parsed.error.message.slice(0, 200)}`);
  }
  return parsed.data;
}

/**
 * Verifies every gated finding, one call each.
 *
 * Fails closed: a finding whose verification errors is withheld from the review
 * and reported in `rejected` with verdict `error`. A flaky verifier must never
 * turn a green PR red, and must never publish an unchecked claim either.
 */
export async function verifyAll(
  deps: OpenAiDeps,
  p: {
    instructions: string;
    findings: GatedFinding[];
    fileContent: (path: string) => string | null;
  },
): Promise<{ confirmed: VerifiedFinding[]; rejected: VerifiedFinding[] }> {
  const confirmed: VerifiedFinding[] = [];
  const rejected: VerifiedFinding[] = [];

  for (const finding of p.findings) {
    const content = p.fileContent(finding.file);
    if (content === null) {
      rejected.push({ finding, verdict: 'error', evidence: 'file content unavailable' });
      continue;
    }
    try {
      const { verdict, evidence } = await verifyFinding(deps, {
        instructions: p.instructions,
        finding,
        fileContent: content,
      });
      if (verdict === 'confirmed') confirmed.push({ finding, verdict, evidence });
      else rejected.push({ finding, verdict, evidence });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rejected.push({ finding, verdict: 'error', evidence: message.slice(0, 200) });
    }
  }

  return { confirmed, rejected };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-review/verify.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/verify.ts scripts/ai-review/verify.test.ts
git commit -m "feat(#175): adversarial per-finding verification pass"
```

---

## Task 8: Render the review body

**Files:**
- Create: `scripts/ai-review/render.ts`
- Test: `scripts/ai-review/render.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { renderBody } from './render';
import type { GatedFinding, VerifiedFinding } from './types';

const gated = (over: Partial<GatedFinding> = {}): GatedFinding => ({
  file: 'src/a.ts',
  start_line: 3,
  end_line: 3,
  matchedLine: 3,
  matchedEndLine: 3,
  quote: "return 'not_found';",
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  confidence: 'medium',
  ...over,
});

const verified = (over: Partial<GatedFinding> = {}): VerifiedFinding => ({
  finding: gated(over),
  verdict: 'confirmed',
  evidence: 'line 3 returns not_found after a successful merge',
});

describe('renderBody', () => {
  it('states plainly when nothing survived, and still shows the counters', () => {
    const body = renderBody({ confirmed: [], counts: { raised: 6, gated: 3, verified: 0 } });
    expect(body).toContain('No verified findings');
    expect(body).toContain('6 raised → 3 passed the evidence gate → 0 confirmed');
  });

  it('orders findings P0 before P1 before P2', () => {
    const body = renderBody({
      confirmed: [verified({ severity: 'P2' }), verified({ severity: 'P0', file: 'src/z.ts' })],
      counts: { raised: 2, gated: 2, verified: 2 },
    });
    expect(body.indexOf('P0')).toBeLessThan(body.indexOf('P2'));
  });

  it('shows file, line and the verbatim quote for each finding', () => {
    const body = renderBody({
      confirmed: [verified()],
      counts: { raised: 1, gated: 1, verified: 1 },
    });
    expect(body).toContain('src/a.ts:3');
    expect(body).toContain("return 'not_found';");
    expect(body).toContain('merge reported as failure');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-review/render.test.ts`
Expected: FAIL — `Failed to resolve import "./render"`.

- [ ] **Step 3: Implement the renderer**

```typescript
import type { Severity, VerifiedFinding } from './types';

const ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

export function renderBody(p: {
  confirmed: VerifiedFinding[];
  counts: { raised: number; gated: number; verified: number };
}): string {
  const { raised, gated, verified } = p.counts;
  const footer =
    `\n---\n\n<sub>${raised} raised → ${gated} passed the evidence gate → ` +
    `${verified} confirmed on review.</sub>`;

  if (p.confirmed.length === 0) {
    return `**No verified findings.**${footer}`;
  }

  const sorted = [...p.confirmed].sort(
    (a, b) => ORDER[a.finding.severity] - ORDER[b.finding.severity],
  );

  const blocks = sorted.map((v, i) => {
    const f = v.finding;
    const where = `${f.file}:${f.matchedLine}`;
    return [
      `### ${i + 1}. ${f.severity} — ${f.claim}`,
      '',
      `**Where:** \`${where}\``,
      '',
      '```',
      f.quote,
      '```',
      '',
      `**Why it breaks:** ${f.why_it_breaks}`,
      '',
      `**Verified:** ${v.evidence}`,
    ].join('\n');
  });

  return `### Findings\n\n${blocks.join('\n\n')}${footer}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-review/render.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/render.ts scripts/ai-review/render.test.ts
git commit -m "feat(#175): render verified findings with suppression counters"
```

---

## Task 9: Rewrite the prompts

**Files:**
- Modify: `.github/ai-review/AGENTS.md` (full rewrite)
- Create: `.github/ai-review/VERIFY.md`

- [ ] **Step 1: Rewrite the pass-1 prompt**

Replace the whole of `.github/ai-review/AGENTS.md` with:

```markdown
# AI PR Review — finding pass

You are the *finding* stage of a two-stage reviewer for the warsaw-beer-bot project.
A separate verification stage re-checks every finding you produce against the full
file before anything is published, and a mechanical gate discards any finding whose
quote does not appear in the code. **You are not the filter. Coverage is your job.**

Report every issue you find, including ones you are uncertain about or consider
low-severity. Do not filter for importance or confidence — say what you see and let
the later stages rank and discard. It is better to surface a finding that gets
filtered out than to silently drop a real bug.

## Hard constraint: quote real code

Every finding must include `quote`: a verbatim copy of the offending code, exactly as
it appears in the material you were given. A finding you cannot quote is a finding you
cannot report. Do not paraphrase, do not reconstruct from memory, do not quote code you
believe *should* exist.

## Scope

- Report only on code shown in this message.
- For files listed under "Files where you see only the diff", make no claim about the
  parts you were not shown.
- Report on what the diff changes, not on pre-existing code it merely sits next to.
- Read the diff as the *finished* state. If the diff adds a behaviour, that behaviour
  exists — do not ask for it to be added.

## What counts

Correctness bugs, security issues, data loss or corruption, broken async/concurrency,
broken GitHub Actions behaviour, regressions in scraping, persistence, matching or bot
runtime behaviour.

Not: subjective style, formatting, naming preferences, broad refactors without a
concrete bug, or missing tests unless the diff creates a specific untested failure path
you can describe as an input and a wrong result.

## Fields

- `claim` — one sentence: what is wrong.
- `why_it_breaks` — a concrete failure path: a specific input or state, and the wrong
  result it produces. If you cannot write one, the finding is speculation; report it
  with `confidence: "low"` rather than inventing a scenario.
- `severity` — P0 production-breaking / data loss / credential exposure; P1 likely bug;
  P2 concrete and actionable improvement.
- `confidence` — your honest read. Low-confidence findings are welcome here.
```

- [ ] **Step 2: Write the pass-2 prompt**

Create `.github/ai-review/VERIFY.md`:

```markdown
# AI PR Review — verification pass

You are the *verification* stage. You are given one finding raised by an earlier pass,
and the **full current contents** of the file it refers to. Your job is to adjudicate it
against that file, not to look for new problems.

Answer with exactly one verdict:

- `confirmed` — the code shown really does have this defect, and the described failure
  path really would occur. You can point at the lines that prove it.
- `refuted` — the defect is not there. This includes: the code already handles the case;
  the finding describes a state the file has moved past; the claimed failure cannot
  occur on any input; the quoted code does not do what the claim says it does.
- `out_of_scope` — the observation may be true but is not about a defect in this file
  (style preference, a wish for extra tests with no described failure, or a statement
  about other code).

Be adversarial. The earlier pass was instructed to over-report, so most findings you see
should not survive. Assume the finding is wrong until the file proves it right. A
plausible-sounding claim with no supporting line in the file is `refuted`.

`evidence` is one sentence citing what settles it — name the construct or the line that
decides the verdict. "Looks correct" is not evidence.
```

- [ ] **Step 3: Commit**

```bash
git add .github/ai-review/AGENTS.md .github/ai-review/VERIFY.md
git commit -m "feat(#175): coverage-first find prompt + adversarial verify prompt"
```

---

## Task 10: Wire the orchestrator

**Files:**
- Modify: `scripts/ai-pr-review.ts` (replace `truncateDiff`, `buildMessages`, `callOpenAI` and `main`)
- Modify: `scripts/ai-pr-review.test.ts:64-141` (drop tests for the removed functions)

- [ ] **Step 1: Remove the superseded tests**

Delete from `scripts/ai-pr-review.test.ts` the `import { truncateDiff, buildMessages }` line and its two `describe` blocks, and the `import { callOpenAI }` line with its `describe` block and fake-fetch helpers (lines 64–141). Keep the `globToRegExp`, `filterReviewableFiles`, `readConfig`, `wrapBody` and `upsertReview` blocks — those functions stay in the orchestrator.

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: FAIL — the file still imports `truncateDiff` etc. from a module that still exports them; this step only prunes tests, so expect PASS here and a failure only after Step 2. If it passes, continue.

- [ ] **Step 2: Replace the pipeline in `scripts/ai-pr-review.ts`**

Delete `DIFF_BUDGET`, `truncateDiff`, `buildMessages`, `ChatMessage`, `NonRetryableError`, `OpenAiDeps` and `callOpenAI`. Keep `INCLUDE_PATTERNS`, `IGNORE_PATTERNS`, `globToRegExp`, `matchesAny`, `filterReviewableFiles`, `MARKER`, `wrapBody`, `GithubDeps`, `githubError`, `upsertReview`, `listChangedFiles`, `getDiff`.

Extend `Config` and `readConfig`:

```typescript
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
```

Inside `readConfig`, after `openaiEndpoint`:

```typescript
    findModel: env.AI_REVIEW_MODEL?.trim() || 'gpt-5.4-mini',
    verifyModel: env.AI_REVIEW_VERIFY_MODEL?.trim() || 'gpt-5.5',
```

Add imports at the top of the file:

```typescript
import { buildReviewContext } from './ai-review/context';
import { runFind } from './ai-review/find';
import { applyGate, changedLineRanges } from './ai-review/gate';
import { renderBody } from './ai-review/render';
import { verifyAll } from './ai-review/verify';
```

Replace `INSTRUCTIONS_PATH` and `main` with:

```typescript
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
```

- [ ] **Step 3: Run the whole suite and the typecheck**

Run: `npm test`
Expected: PASS — all suites, including the five new `scripts/ai-review/*.test.ts` files.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output. (`tsconfig.json` only includes `src/**`, so also run `npx tsc --noEmit --strict --esModuleInterop --module commonjs --target ES2022 --types node,vitest/globals scripts/ai-pr-review.ts` to typecheck the script tree.)

- [ ] **Step 4: Commit**

```bash
git add scripts/ai-pr-review.ts scripts/ai-pr-review.test.ts
git commit -m "feat(#175): two-stage orchestration in the reviewer entry point"
```

---

## Task 11: Replay tool

**Files:**
- Create: `scripts/ai-review/replay.ts`
- Modify: `package.json` (add the `ai-review-replay` script)

- [ ] **Step 1: Write the replay tool**

```typescript
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
import { filterReviewableFiles } from '../ai-pr-review';

function sh(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

async function main(): Promise<void> {
  const pr = process.argv[2];
  if (!pr) throw new Error('usage: npm run ai-review-replay -- <pr-number>');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const meta = JSON.parse(
    gh(['pr', 'view', pr, '--json', 'title,body,headRefOid,baseRefOid']),
  ) as { title: string; body: string; headRefOid: string; baseRefOid: string };

  const head = meta.headRefOid;
  const mergeBase = sh(['merge-base', meta.baseRefOid, head]).trim();

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

  const findModel = process.env.AI_REVIEW_MODEL || 'gpt-5.4-mini';
  const verifyModel = process.env.AI_REVIEW_VERIFY_MODEL || 'gpt-5.5';
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 2: Register the script**

In `package.json`, add to `scripts`:

```json
    "ai-review-replay": "tsx scripts/ai-review/replay.ts",
```

- [ ] **Step 3: Smoke-test it on a PR with a known-false finding**

```bash
set -a && . /tmp/claude-1000/-home-ysi-warsaw-beer-bot/*/scratchpad/openai.env && set +a
npm run ai-review-replay -- 352
```

Expected: runs to completion, prints the three counters. The `merged` findings from the old review must **not** appear under `PUBLISHED` — if they do, the verify prompt is not adversarial enough and Task 9's `VERIFY.md` needs another pass before continuing.

- [ ] **Step 4: Commit**

```bash
git add scripts/ai-review/replay.ts package.json
git commit -m "feat(#175): replay tool for measuring the reviewer offline"
```

---

## Task 12: Measure, then choose the default models

The spec deliberately leaves the defaults unset until this task. Do not skip it.

**Files:**
- Create: `docs/superpowers/specs/2026-07/2026-07-28-ai-review-measurement.md`
- Modify: `scripts/ai-pr-review.ts` (default model IDs, if the measurement disagrees with the placeholders)

- [ ] **Step 1: Run the precision set**

```bash
set -a && . /tmp/claude-1000/-home-ysi-warsaw-beer-bot/*/scratchpad/openai.env && set +a
for pr in 344 348 352 356 358; do npm run ai-review-replay -- $pr; done 2>&1 | tee /tmp/precision-a.txt
```

Compare every `PUBLISHED` line against the labels from Task 1. Record: published count, and how many of them Task 1 labelled `false` or `unfalsifiable`.

- [ ] **Step 2: Run the recall set**

The four escaped defects and the PRs that introduced them (verified in the spec):

```bash
for pr in 233 237 274 312; do npm run ai-review-replay -- $pr; done 2>&1 | tee /tmp/recall-a.txt
```

For each, record whether any published finding describes the defect that was later fixed:

| PR | escaped defect | fixed in | caught? |
|---|---|---|---|
| 233 | empty verdict → silent no-op | `98c05da` (#296) | |
| 237 | prompt lacks a translation guard | `7a9e262` (#354) | |
| 274 | no exact-id mode | `243b75f` (#336) | |
| 312 | release-notes scope | `7b2d10b` (#313) | |

- [ ] **Step 3: Run the second configuration**

```bash
AI_REVIEW_MODEL=gpt-5.5 AI_REVIEW_VERIFY_MODEL=gpt-5.5 \
  bash -c 'for pr in 344 348 352 356 358 233 237 274 312; do npm run ai-review-replay -- $pr; done' 2>&1 | tee /tmp/config-b.txt
```

- [ ] **Step 4: Write the measurement record**

Create `docs/superpowers/specs/2026-07/2026-07-28-ai-review-measurement.md` with: the two configurations, the precision table (published vs. Task 1 labels), the recall table above filled in, observed cost per PR, and one paragraph stating which configuration is chosen and why. State plainly if recall is 0 — a pipeline that publishes nothing is a regression dressed as a win, and that outcome must be reported, not buried.

- [ ] **Step 5: Set the defaults to whatever won**

Update the two default strings in `readConfig` if the measurement disagrees with `gpt-5.4-mini` / `gpt-5.5`.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-07/2026-07-28-ai-review-measurement.md scripts/ai-pr-review.ts
git commit -m "docs(#175): replay measurement and chosen reviewer models"
```

---

## Task 13: Update `spec.md`

CLAUDE.md requires the spec to move in the same PR as the implementation. §5.10 is already stale relative to #143/#174.

**Files:**
- Modify: `spec.md` (§5.10)

- [ ] **Step 1: Find the section**

Run: `grep -n "5.10" spec.md`

- [ ] **Step 2: Rewrite it**

The section must state: the reviewer is a two-stage pipeline (`scripts/ai-pr-review.ts` orchestrating `scripts/ai-review/*`); pass 1 emits structured findings with verbatim quotes; a pure mechanical gate drops findings whose quote is absent from the HEAD file or falls outside the PR's changed lines; pass 2 adjudicates each survivor against the full file and only `confirmed` is published; every review carries `raised → gated → verified` counters; models are configured via `AI_REVIEW_MODEL` and `AI_REVIEW_VERIFY_MODEL`; the request shape uses `max_completion_tokens` and omits `temperature`; the script owns its exit code and fails loud, while individual verification failures withhold their finding without failing the job.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(#175): spec §5.10 — two-stage AI review pipeline"
```

---

## Task 14: Open the PR and run the review loop

- [ ] **Step 1: Push and open**

```bash
git push -u origin HEAD
gh pr create --title "feat(#175): two-stage AI PR review — greedy find + strict verify" --body "$(cat <<'EOF'
Closes #175.

Replaces the single-pass reviewer with: full file bodies in context, a greedy
structured find pass, a pure mechanical evidence gate (quote must exist verbatim
in HEAD and intersect changed lines), and per-finding adversarial verification.
Only `confirmed` findings are published; every review carries
`raised → gated → verified` counters.

Design: docs/superpowers/specs/2026-07/2026-07-28-ai-review-quality-design.md
Baseline labels: docs/superpowers/specs/2026-07/2026-07-28-ai-review-baseline-labels.md
Measurement: docs/superpowers/specs/2026-07/2026-07-28-ai-review-measurement.md

OpenAI is retained deliberately — the reviewer's value is orthogonality to the
Claude review pass, so swapping it to Claude would make it an echo chamber.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01CoKXfbwgs7ygxUCTnUZTpb
EOF
)"
```

- [ ] **Step 2: Watch the reviewer review itself**

This PR touches `scripts/**/*.ts`, so the new pipeline runs on its own diff — the cheapest possible smoke test, and the same one #174 used.

```bash
gh run watch "$(gh run list --workflow=codex-review.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh api repos/:owner/:repo/pulls/<PR>/reviews --jq '.[] | select(.body | contains("ai-pr-review")) | .body'
```

Check the counters line is present and the findings quote real code.

- [ ] **Step 3: Poll and work the AI review**

Per project policy the PR is not done at green tests: wait for the review, read every comment, verify each claim against the code, fix the valid ones and push back on the wrong ones in the PR thread.

- [ ] **Step 4: Report ready to merge**

Do **not** run `gh pr merge` — the user merges. Report the counters observed on the self-review, the measurement outcome, and anything still open.

---

## Self-review notes

- **Spec coverage:** context (Task 4), pass-1 schema + prompt (Tasks 6, 9), mechanical gate (Task 3), pass-2 (Tasks 7, 9), published output + counters (Task 8), module layout (Tasks 2–8, 10), failure semantics (Tasks 7, 10), model selection via env (Tasks 10, 12), measurement precision + recall (Tasks 1, 12), testing (every task), rollout (Task 14), spec impact (Task 13). No spec section is unimplemented.
- **Type consistency:** `RawFinding` → `GatedFinding` (adds `matchedLine`, `matchedEndLine`) → `VerifiedFinding` (wraps as `.finding`) is used identically in `gate.ts`, `verify.ts`, `render.ts` and the orchestrator. `OpenAiDeps` carries `model`, so `find.ts` and `verify.ts` differ only by which config field is passed.
- **Known risk, deliberately taken:** the gate uses hunk ranges (which include context lines) rather than only `+` lines. Looser gate, fewer real findings dropped. If Task 12 shows findings sneaking through about untouched code, tighten to added lines only — but do it with the measurement in hand.
