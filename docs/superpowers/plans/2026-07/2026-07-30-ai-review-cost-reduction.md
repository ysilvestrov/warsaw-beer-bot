# AI PR review — cost reduction (incremental re-review + batched verify + self-billing) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the AI PR reviewer's bill from ~$0.63 to ~$0.30 per PR by reviewing only what each push changed, batching verification per file, and making the reviewer report its own token spend — without changing what the model sees when it judges freshly changed code.

**Architecture:** The reviewer's state (last reviewed head SHA + open findings + accumulated spend) rides inside the review body it already upserts, as a hidden HTML comment. On a later push the orchestrator diffs `stored_head..HEAD` instead of `origin/base...HEAD` and sends only the files that diff touches; previously published findings are re-anchored by quote (free), closed when their file is gone, or re-adjudicated when the quoted code was edited. Verification sends one call per *file* carrying every finding against it instead of one call per finding. Every OpenAI call now returns its `usage`, which a pure accumulator converts to dollars through a dated price table and prints into both the workflow log and the review footer.

**Tech Stack:** TypeScript (CommonJS), Node 20, Vitest (globals: true), zod, OpenAI chat-completions JSON-schema mode, GitHub REST reviews API, `git` via `execFileSync`.

**Source of truth:** `docs/superpowers/specs/2026-07/2026-07-30-ai-review-cost-reduction-design.md` (issue #364).

---

## Deviations from the design doc (decided while planning — implement these, not the doc)

1. **The design's premise "output dominates the bill, not input" is wrong.** Verified 2026-07-30 against
   <https://developers.openai.com/api/docs/models/gpt-5.5>: gpt-5.5 is **$5.00 / 1M input, $0.50 / 1M cached
   input, $30.00 / 1M output**. The measured 390k input tokens are therefore ≈ **$1.95 of the $2.52** — input
   dominates. Nothing in the design has to change (incremental re-review is precisely the input-cutting
   lever, and it is the biggest one), but the price table must carry the real numbers and a comment saying
   the first production run validates them against the dashboard. Do **not** copy the doc's premise into a
   code comment.
2. **`republish` mode PUTs the previous body verbatim** rather than re-deriving it. It is byte-identical to
   what the design asks for, cannot drift, and costs zero OpenAI calls.
3. **One ordering rule everywhere: severity, then insertion order.** The design says caps drop "oldest
   first"; implemented as "drop from the end of display order" (least severe, newest first), so a P0 is
   never dropped while a P2 survives. Same intent, strictly better outcome.
4. **`verifyAll` works on an opaque-id request shape** (`VerifyRequest`), not on `GatedFinding`. Fresh
   findings and re-checks must share one call per file (design §4) but they are different TypeScript types;
   an explicit `id` maps verdicts back to either without casts.
5. **`renderBody` builds the state block itself** from the findings that survived the body-size cap, so the
   text and the state it describes can never disagree — which is the design's stated reason for putting the
   state in the body at all.

---

## File structure

| File | Responsibility | Network |
|---|---|---|
| `scripts/ai-review/usage.ts` | **new**, pure: token accumulation, dated price table, cost/footer formatting | no |
| `scripts/ai-review/usage.test.ts` | **new** | no |
| `scripts/ai-review/state.ts` | **new**, pure: `StoredFinding`/`ReviewState`, hidden-block parse/render, quote truncation, ordering, open-count cap | no |
| `scripts/ai-review/state.test.ts` | **new** | no |
| `scripts/ai-review/incremental.ts` | **new**, pure: review-mode decision, re-anchoring / carry / close / re-check classification | no |
| `scripts/ai-review/incremental.test.ts` | **new** | no |
| `scripts/ai-review/types.ts` | changed: `StoredFinding` re-export point is `state.ts`; add `VerifyRequest`/`VerifyResult` | no |
| `scripts/ai-review/openai.ts` | changed: `callStructured` returns `{ content, usage }` | yes |
| `scripts/ai-review/find.ts` | changed: `runFind` returns `{ findings, usage }` | yes |
| `scripts/ai-review/gate.ts` | changed: export `findingKey` + `pickMatch`; `applyGate` accepts a seed set of already-known keys | no |
| `scripts/ai-review/verify.ts` | changed: per-file batched schema and call; id-keyed requests/results; returns usage | yes |
| `scripts/ai-review/render.ts` | changed: open + closed sections, counters, cost line, hidden state block, body-size cap | no |
| `scripts/ai-pr-review.ts` | changed: exported `runReview` with injected git/fetch deps; review is read once and reused by the upsert | yes |
| `scripts/ai-review/replay.ts` | changed: optional explicit base ref so an incremental run replays offline | yes |
| `.github/ai-review/VERIFY.md` | changed: array-answer instruction only | — |
| `spec.md` §5.10 | changed: review modes, state block, batched verify, cost footer, reversed re-check fail semantics | — |

`context.ts` and `.github/ai-review/AGENTS.md` are **unchanged**.

---

## Task 1: `usage.ts` — token accounting and the price table

**Files:**
- Create: `scripts/ai-review/usage.ts`
- Create: `scripts/ai-review/usage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/ai-review/usage.test.ts`:

```ts
import {
  EMPTY_USAGE,
  addUsage,
  costUsd,
  formatCostLine,
  formatTokens,
  parseUsage,
  PRICES,
  PRICES_CHECKED_ON,
} from './usage';

describe('parseUsage', () => {
  it('reads the OpenAI usage block including cached and reasoning details', () => {
    const u = parseUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 512 },
      completion_tokens_details: { reasoning_tokens: 150 },
    });
    expect(u).toEqual({
      calls: 1,
      promptTokens: 1000,
      cachedTokens: 512,
      completionTokens: 200,
      reasoningTokens: 150,
    });
  });

  it('counts the call even when the API sends no usage block at all', () => {
    expect(parseUsage(undefined)).toEqual({
      calls: 1,
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('ignores non-numeric junk instead of producing NaN totals', () => {
    const u = parseUsage({ prompt_tokens: 'lots', completion_tokens: 7 });
    expect(u.promptTokens).toBe(0);
    expect(u.completionTokens).toBe(7);
  });
});

describe('addUsage', () => {
  it('sums every field across stages', () => {
    const a = { calls: 1, promptTokens: 10, cachedTokens: 2, completionTokens: 3, reasoningTokens: 1 };
    const b = { calls: 2, promptTokens: 40, cachedTokens: 0, completionTokens: 5, reasoningTokens: 4 };
    expect(addUsage(a, b)).toEqual({
      calls: 3,
      promptTokens: 50,
      cachedTokens: 2,
      completionTokens: 8,
      reasoningTokens: 5,
    });
  });

  it('is the identity on EMPTY_USAGE', () => {
    const a = { calls: 1, promptTokens: 10, cachedTokens: 2, completionTokens: 3, reasoningTokens: 1 };
    expect(addUsage(EMPTY_USAGE, a)).toEqual(a);
  });
});

describe('costUsd', () => {
  it('bills uncached input, cached input and output at their own rates', () => {
    // gpt-5.5: $5/M input, $0.50/M cached input, $30/M output.
    const cost = costUsd('gpt-5.5', {
      calls: 1,
      promptTokens: 1_000_000,
      cachedTokens: 400_000,
      completionTokens: 100_000,
      reasoningTokens: 60_000,
    });
    // 600k uncached * $5/M = 3.00; 400k cached * $0.50/M = 0.20; 100k out * $30/M = 3.00
    expect(cost).toBeCloseTo(6.2, 6);
  });

  it('does not bill reasoning tokens twice — they are already inside completion_tokens', () => {
    const withReasoning = costUsd('gpt-5.5', {
      calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 1000, reasoningTokens: 900,
    });
    const without = costUsd('gpt-5.5', {
      calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 1000, reasoningTokens: 0,
    });
    expect(withReasoning).toBe(without);
  });

  it('returns null for a model with no verified price rather than a wrong number', () => {
    expect(costUsd('gpt-9-imaginary', EMPTY_USAGE)).toBeNull();
  });

  it('carries the date its prices were last checked', () => {
    expect(PRICES['gpt-5.5']).toEqual({ input: 5, cachedInput: 0.5, output: 30 });
    expect(PRICES_CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatTokens', () => {
  it('abbreviates thousands to one decimal and leaves small counts alone', () => {
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(0)).toBe('0');
  });
});

describe('formatCostLine', () => {
  const find = { calls: 1, promptTokens: 12_300, cachedTokens: 0, completionTokens: 3100, reasoningTokens: 1900 };
  const verify = { calls: 2, promptTokens: 8000, cachedTokens: 0, completionTokens: 900, reasoningTokens: 400 };

  it('reports both stages, this run and the PR total', () => {
    const line = formatCostLine({ find, verify, runUsd: 0.07, totalUsd: 0.21, unpriced: 0 });
    expect(line).toBe(
      'find 1 call 12.3k→3.1k (1.9k reasoning) · verify 2 calls 8.0k→900 · this run $0.07 · PR total $0.21',
    );
  });

  it('says so plainly when the find pass was skipped', () => {
    const line = formatCostLine({ find: EMPTY_USAGE, verify, runUsd: 0.02, totalUsd: 0.23, unpriced: 0 });
    expect(line).toContain('find skipped');
  });

  it('marks the total as a lower bound when some runs could not be priced', () => {
    const line = formatCostLine({ find, verify, runUsd: null, totalUsd: 0.21, unpriced: 2 });
    expect(line).toContain('this run — (unpriced model)');
    expect(line).toContain('PR total $0.21+');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/ai-review/usage.test.ts`
Expected: FAIL — `Failed to resolve import "./usage"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/ai-review/usage.ts`:

```ts
/**
 * What each API call actually cost us, in tokens and then in dollars.
 *
 * The whole point of this module is that the next time someone asks "what does
 * the reviewer cost", the answer is in the review body and the workflow log —
 * not in an hour of dashboard archaeology.
 */

export interface Usage {
  /** Number of completed API calls this usage covers. */
  calls: number;
  promptTokens: number;
  /** Subset of `promptTokens` served from OpenAI's prefix cache, billed cheaper. */
  cachedTokens: number;
  /** Includes `reasoningTokens` — the API counts hidden reasoning as completion. */
  completionTokens: number;
  reasoningTokens: number;
}

export const EMPTY_USAGE: Usage = {
  calls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * One call's usage, read defensively.
 *
 * `calls` is 1 even when the response carries no `usage` block: the call
 * happened and was billed, and reporting zero calls would understate the run in
 * exactly the direction that hides a cost regression.
 */
export function parseUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const promptDetails = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    calls: 1,
    promptTokens: num(u.prompt_tokens),
    cachedTokens: num(promptDetails.cached_tokens),
    completionTokens: num(u.completion_tokens),
    reasoningTokens: num(completionDetails.reasoning_tokens),
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export interface Price {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M cached input tokens. */
  cachedInput: number;
  /** USD per 1M output tokens (reasoning tokens included in that count). */
  output: number;
}

/**
 * Read off the vendor's own model page on the date below. Only models we have
 * actually checked are listed: an unknown model prints tokens and no dollars,
 * because a confidently wrong number is worse than an admitted gap.
 *
 * Not modelled: the >272k-input-token tier (2x input / 1.5x output). Our
 * CONTEXT_BUDGET is 240 000 *characters* (~60k tokens), so a request cannot
 * reach it; if that budget ever grows past ~1M characters, this needs a tier.
 *
 * These numbers are derived, the token counts are ground truth. Validate the
 * first production run's footer against the billing dashboard delta — if they
 * disagree, this table is what is wrong.
 */
export const PRICES: Record<string, Price> = {
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
};

export const PRICES_CHECKED_ON = '2026-07-30';

/** Dollars for `u` at `model`'s rates, or null when we have no verified price. */
export function costUsd(model: string, u: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const uncachedInput = Math.max(0, u.promptTokens - u.cachedTokens);
  return (
    (uncachedInput * price.input +
      u.cachedTokens * price.cachedInput +
      u.completionTokens * price.output) /
    1_000_000
  );
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function stagePart(name: string, u: Usage): string {
  if (u.calls === 0) return `${name} skipped`;
  const calls = `${u.calls} call${u.calls === 1 ? '' : 's'}`;
  const reasoning = u.reasoningTokens > 0 ? ` (${formatTokens(u.reasoningTokens)} reasoning)` : '';
  return `${name} ${calls} ${formatTokens(u.promptTokens)}→${formatTokens(u.completionTokens)}${reasoning}`;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * The one-line bill that goes in the review footer and the workflow log.
 *
 * `unpriced` counts runs on this PR whose model had no price entry, which is
 * why the total is printed with a trailing `+` — it is a lower bound, and
 * saying so is the difference between a number and a lie.
 */
export function formatCostLine(p: {
  find: Usage;
  verify: Usage;
  runUsd: number | null;
  totalUsd: number | null;
  unpriced: number;
}): string {
  const run = p.runUsd === null ? 'this run — (unpriced model)' : `this run ${usd(p.runUsd)}`;
  const total =
    p.totalUsd === null
      ? 'PR total — (unpriced model)'
      : `PR total ${usd(p.totalUsd)}${p.unpriced > 0 ? '+' : ''}`;
  return [stagePart('find', p.find), stagePart('verify', p.verify), run, total].join(' · ');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/ai-review/usage.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/usage.ts scripts/ai-review/usage.test.ts
git commit -m "feat(#364): token/usd accounting for the AI reviewer"
```

---

## Task 2: `callStructured` returns its usage

**Files:**
- Modify: `scripts/ai-review/openai.ts:32-94`
- Modify: `scripts/ai-review/openai.test.ts`
- Modify: `scripts/ai-review/find.ts:59-94`
- Modify: `scripts/ai-review/find.test.ts`
- Modify: `scripts/ai-review/verify.ts:45-53` (mechanical — Task 7 rewrites this file)
- Modify: `scripts/ai-review/replay.ts:136-144`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/ai-review/openai.test.ts`:

```ts
import { callStructured as callWithUsage } from './openai';

describe('callStructured usage', () => {
  const schema = { type: 'object', additionalProperties: false, required: [], properties: {} };

  it('returns the usage block alongside the content', async () => {
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{}' } }],
          usage: {
            prompt_tokens: 900,
            completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 128 },
            completion_tokens_details: { reasoning_tokens: 32 },
          },
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const out = await callWithUsage(
      { endpoint: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-5.5', fetchFn, sleep: async () => {} },
      [{ role: 'user', content: 'hi' }],
      { name: 'x', schema },
    );
    expect(out.content).toBe('{}');
    expect(out.usage).toEqual({
      calls: 1,
      promptTokens: 900,
      cachedTokens: 128,
      completionTokens: 40,
      reasoningTokens: 32,
    });
  });

  it('still returns a counted call when the response omits usage', async () => {
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{}' } }] }),
      }) as unknown as Response) as unknown as typeof fetch;

    const out = await callWithUsage(
      { endpoint: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-5.5', fetchFn, sleep: async () => {} },
      [{ role: 'user', content: 'hi' }],
      { name: 'x', schema },
    );
    expect(out.usage.calls).toBe(1);
    expect(out.usage.promptTokens).toBe(0);
  });
});
```

Append to `scripts/ai-review/find.test.ts`:

```ts
import { runFind as runFindUsage } from './find';

describe('runFind usage', () => {
  it('reports the tokens its call consumed', async () => {
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
          usage: { prompt_tokens: 1234, completion_tokens: 56 },
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const out = await runFindUsage(
      { endpoint: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-5.5', fetchFn, sleep: async () => {} },
      { instructions: 'i', context: 'c', prTitle: 't', prBody: 'b' },
    );
    expect(out.findings).toEqual([]);
    expect(out.usage.promptTokens).toBe(1234);
    expect(out.usage.calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-review/openai.test.ts scripts/ai-review/find.test.ts`
Expected: FAIL — `out.content` is undefined (`callStructured` still resolves to a bare string), and `out.findings` is undefined.

- [ ] **Step 3: Change `callStructured`**

In `scripts/ai-review/openai.ts`, add the import and change the signature and both return points:

```ts
import { parseUsage, type Usage } from './usage';
```

Change the declared return type from `Promise<string>` to:

```ts
): Promise<{ content: string; usage: Usage }> {
```

and replace the success block

```ts
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new NonRetryableError('OpenAI returned an empty completion');
      return content;
```

with

```ts
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: unknown;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new NonRetryableError('OpenAI returned an empty completion');
      // Usage is read from the same response as the content, so a call can never
      // be published without being billed for in the footer.
      return { content, usage: parseUsage(data.usage) };
```

Also update the doc comment's first line to `One structured chat completion, with the tokens it cost.`

- [ ] **Step 4: Update `runFind`**

In `scripts/ai-review/find.ts`, add:

```ts
import type { Usage } from './usage';
```

change the signature to

```ts
export async function runFind(
  deps: OpenAiDeps,
  p: { instructions: string; context: string; prTitle: string; prBody: string },
): Promise<{ findings: RawFinding[]; usage: Usage }> {
```

replace the call

```ts
  const raw = await callStructured(
```

with

```ts
  const { content: raw, usage } = await callStructured(
```

and the final return

```ts
  return result.data.findings;
```

with

```ts
  return { findings: result.data.findings, usage };
```

- [ ] **Step 5: Keep `verify.ts` and `replay.ts` compiling**

In `scripts/ai-review/verify.ts:45`, change

```ts
  const raw = await callStructured(
```

to

```ts
  const { content: raw } = await callStructured(
```

(Task 7 replaces this function entirely; this step only keeps the tree green.)

In `scripts/ai-review/replay.ts:136`, change

```ts
  const raised = await runFind(
```

to

```ts
  const { findings: raised } = await runFind(
```

- [ ] **Step 6: Run the full suite and the typechecker**

Run: `npx vitest run scripts/ && npm run typecheck`
Expected: PASS — no TypeScript errors, all existing ai-review tests green.

- [ ] **Step 7: Commit**

```bash
git add scripts/ai-review/openai.ts scripts/ai-review/openai.test.ts \
        scripts/ai-review/find.ts scripts/ai-review/find.test.ts \
        scripts/ai-review/verify.ts scripts/ai-review/replay.ts
git commit -m "feat(#364): callStructured returns the usage of every call"
```

---

## Task 3: `state.ts` — the hidden state block

**Files:**
- Create: `scripts/ai-review/state.ts`
- Create: `scripts/ai-review/state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/ai-review/state.test.ts`:

```ts
import {
  MAX_OPEN_FINDINGS,
  MAX_QUOTE_CHARS,
  capOpenFindings,
  orderBySeverity,
  parseState,
  renderState,
  toStored,
  type ReviewState,
  type StoredFinding,
} from './state';
import type { GatedFinding } from './types';

const stored = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  file: 'src/a.ts',
  quote: "return 'not_found';",
  matchedLine: 3,
  matchedEndLine: 3,
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  evidence: 'line 3 returns not_found after a successful merge',
  ...over,
});

const state = (over: Partial<ReviewState> = {}): ReviewState => ({
  v: 1,
  head: 'a'.repeat(40),
  findings: [stored()],
  spend: { usd: 0.21, runs: 3, unpriced: 0 },
  ...over,
});

describe('renderState / parseState', () => {
  it('round-trips a state through a review body', () => {
    const s = state();
    const body = `## 🤖 AI PR Review\n\nsome text\n\n${renderState(s)}\n`;
    expect(parseState(body)).toEqual(s);
  });

  it('never emits a sequence that would close the HTML comment early', () => {
    const rendered = renderState(state({ findings: [stored({ quote: 'if (a --> b) {}' })] }));
    expect(rendered.indexOf('-->')).toBe(rendered.length - '-->'.length);
    expect(parseState(rendered)!.findings[0].quote).toBe('if (a --> b) {}');
  });

  it('treats a body with no state block as no state', () => {
    expect(parseState('## 🤖 AI PR Review\n\nNo verified findings.')).toBeNull();
  });

  it('treats an empty, missing or hand-mangled body as no state', () => {
    expect(parseState('')).toBeNull();
    expect(parseState(undefined)).toBeNull();
    expect(parseState('<!-- ai-pr-review-state {oops -->')).toBeNull();
  });

  it('rejects a state block from a future format version', () => {
    const body = renderState(state()).replace('"v":1', '"v":2');
    expect(parseState(body)).toBeNull();
  });

  it('rejects a state block whose findings do not match the schema', () => {
    const body = '<!-- ai-pr-review-state {"v":1,"head":"abc","findings":[{"file":1}],"spend":{"usd":0,"runs":1,"unpriced":0}} -->';
    expect(parseState(body)).toBeNull();
  });
});

describe('toStored', () => {
  it('keeps only the fields a later run needs, truncating a huge quote', () => {
    const gated: GatedFinding = {
      file: 'src/a.ts',
      start_line: 1,
      end_line: 2,
      matchedLine: 3,
      matchedEndLine: 4,
      quote: 'x'.repeat(MAX_QUOTE_CHARS + 500),
      claim: 'c',
      why_it_breaks: 'w',
      severity: 'P0',
      confidence: 'high',
    };
    const out = toStored(gated, 'because line 3');
    expect(out.quote).toHaveLength(MAX_QUOTE_CHARS);
    expect(out.evidence).toBe('because line 3');
    expect(out).not.toHaveProperty('confidence');
    expect(out.matchedLine).toBe(3);
  });
});

describe('orderBySeverity', () => {
  it('sorts P0 before P1 before P2 and keeps insertion order within a severity', () => {
    const items = [
      { finding: stored({ severity: 'P2', claim: 'c1' }) },
      { finding: stored({ severity: 'P0', claim: 'c2' }) },
      { finding: stored({ severity: 'P2', claim: 'c3' }) },
      { finding: stored({ severity: 'P1', claim: 'c4' }) },
    ];
    expect(orderBySeverity(items, (i) => i.finding).map((i) => i.finding.claim)).toEqual([
      'c2',
      'c4',
      'c1',
      'c3',
    ]);
  });
});

describe('capOpenFindings', () => {
  it('keeps everything when under the cap', () => {
    const items = [{ finding: stored() }];
    const out = capOpenFindings(items, (i) => i.finding);
    expect(out.kept).toHaveLength(1);
    expect(out.dropped).toBe(0);
  });

  it('drops the least severe, newest findings past the cap', () => {
    const items = [
      ...Array.from({ length: MAX_OPEN_FINDINGS }, (_, i) => ({
        finding: stored({ severity: 'P2', claim: `p2-${i}` }),
      })),
      { finding: stored({ severity: 'P0', claim: 'critical' }) },
    ];
    const out = capOpenFindings(items, (i) => i.finding);
    expect(out.kept).toHaveLength(MAX_OPEN_FINDINGS);
    expect(out.dropped).toBe(1);
    expect(out.kept.map((i) => i.finding.claim)).toContain('critical');
    expect(out.kept.map((i) => i.finding.claim)).not.toContain(`p2-${MAX_OPEN_FINDINGS - 1}`);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/ai-review/state.test.ts`
Expected: FAIL — `Failed to resolve import "./state"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/ai-review/state.ts`:

```ts
import { z } from 'zod';
import type { GatedFinding, Severity } from './types';

/**
 * What a published finding has to remember about itself so a later run can
 * carry it, close it, or re-adjudicate it without re-deriving it.
 *
 * Deliberately narrower than GatedFinding: `start_line`/`end_line` were the
 * model's untrusted guesses (the gate already replaced them with matchedLine),
 * and `confidence` is a pass-1 artefact nothing downstream reads.
 */
export interface StoredFinding {
  file: string;
  quote: string;
  matchedLine: number;
  matchedEndLine: number;
  claim: string;
  why_it_breaks: string;
  severity: Severity;
  evidence: string;
}

export interface Spend {
  usd: number;
  runs: number;
  /** Runs whose model had no verified price, so `usd` is a lower bound. */
  unpriced: number;
}

export interface ReviewState {
  v: 1;
  /** The commit the last review was computed against. */
  head: string;
  /** Open findings, in the order they were first published. */
  findings: StoredFinding[];
  spend: Spend;
}

/** A quote longer than this is stored truncated; it only has to re-anchor. */
export const MAX_QUOTE_CHARS = 400;

/** Open findings carried across pushes. Beyond this the review is noise. */
export const MAX_OPEN_FINDINGS = 20;

const STATE_OPEN = '<!-- ai-pr-review-state ';
const STATE_CLOSE = ' -->';

const storedSchema = z.object({
  file: z.string(),
  quote: z.string(),
  matchedLine: z.number().int(),
  matchedEndLine: z.number().int(),
  claim: z.string(),
  why_it_breaks: z.string(),
  severity: z.enum(['P0', 'P1', 'P2']),
  evidence: z.string(),
});

const stateSchema = z.object({
  v: z.literal(1),
  head: z.string(),
  findings: z.array(storedSchema),
  spend: z.object({
    usd: z.number(),
    runs: z.number().int(),
    unpriced: z.number().int(),
  }),
});

export function toStored(f: GatedFinding, evidence: string): StoredFinding {
  return {
    file: f.file,
    quote: f.quote.slice(0, MAX_QUOTE_CHARS),
    matchedLine: f.matchedLine,
    matchedEndLine: f.matchedEndLine,
    claim: f.claim,
    why_it_breaks: f.why_it_breaks,
    severity: f.severity,
    evidence,
  };
}

/**
 * The state as a hidden HTML comment.
 *
 * `<` and `>` are escaped to their JSON unicode forms — still valid JSON that
 * parses back byte-identical, but incapable of containing `-->`. A quoted line
 * of code with an arrow in it would otherwise close the comment early and spill
 * the rest of the state into the visible review.
 */
export function renderState(state: ReviewState): string {
  const json = JSON.stringify(state).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${STATE_OPEN}${json}${STATE_CLOSE}`;
}

/**
 * The state carried by a review body, or null if there is none we can trust.
 *
 * Every failure mode — no block, truncated JSON, a version we do not know, a
 * hand-edited body — returns null, which the caller reads as "review this PR in
 * full". Degrading to today's cost is always safe; acting on a half-understood
 * state is not.
 */
export function parseState(body: string | null | undefined): ReviewState | null {
  if (!body) return null;
  const start = body.indexOf(STATE_OPEN);
  if (start === -1) return null;
  const from = start + STATE_OPEN.length;
  const end = body.indexOf(STATE_CLOSE, from);
  if (end === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(from, end));
  } catch {
    return null;
  }
  const result = stateSchema.safeParse(parsed);
  return result.success ? (result.data as ReviewState) : null;
}

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

/**
 * The single display order used by the renderer, the caps and the state block:
 * severity first, then the order findings were published.
 *
 * One order everywhere is what makes "drop from the end" a safe rule — a P0 is
 * never dropped while a P2 survives.
 */
export function orderBySeverity<T>(items: T[], pick: (item: T) => StoredFinding): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[pick(a.item).severity] - SEVERITY_RANK[pick(b.item).severity] ||
        a.index - b.index,
    )
    .map((x) => x.item);
}

/** Display order, cut to MAX_OPEN_FINDINGS from the end. */
export function capOpenFindings<T>(
  items: T[],
  pick: (item: T) => StoredFinding,
): { kept: T[]; dropped: number } {
  const ordered = orderBySeverity(items, pick);
  return {
    kept: ordered.slice(0, MAX_OPEN_FINDINGS),
    dropped: Math.max(0, ordered.length - MAX_OPEN_FINDINGS),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/ai-review/state.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/state.ts scripts/ai-review/state.test.ts
git commit -m "feat(#364): review state block carried inside the review body"
```

---

## Task 4: gate — export the identity key and seed it with known findings

**Files:**
- Modify: `scripts/ai-review/gate.ts:157-218`
- Modify: `scripts/ai-review/gate.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `scripts/ai-review/gate.test.ts`:

```ts
import { applyGate as applyGateSeeded, findingKey } from './gate';
import type { RawFinding } from './types';

describe('findingKey', () => {
  it('is stable across whitespace, claim casing and a truncated quote', () => {
    const long = 'const x = 1;\n'.repeat(60); // > 400 chars
    const a = findingKey('src/a.ts', long, 'Merge reported as failure');
    const b = findingKey('src/a.ts', long.slice(0, 400), 'merge  reported as   failure');
    expect(a).toBe(b);
  });

  it('still agrees when the 400-char cut lands inside a run of whitespace', () => {
    // Normalising before slicing would collapse the run away in the stored copy
    // only, shortening it past the compared prefix and splitting the key.
    const full = `if (a) {\n${' '.repeat(500)}\n  doSomething();\n}`;
    expect(findingKey('src/a.ts', full, 'c')).toBe(
      findingKey('src/a.ts', full.slice(0, 400), 'c'),
    );
  });

  it('separates two different claims about the same line', () => {
    expect(findingKey('src/a.ts', 'x', 'claim one')).not.toBe(
      findingKey('src/a.ts', 'x', 'claim two'),
    );
  });
});

describe('applyGate seeded with already-known findings', () => {
  const raw = (over: Partial<RawFinding> = {}): RawFinding => ({
    file: 'src/a.ts',
    start_line: 1,
    end_line: 1,
    quote: 'const a = 1;',
    claim: 'a is wrong',
    why_it_breaks: 'boom',
    severity: 'P1',
    confidence: 'high',
    ...over,
  });

  it('drops a re-derived finding that a previous run already published', () => {
    const out = applyGateSeeded({
      findings: [raw()],
      reviewable: ['src/a.ts'],
      changed: new Map([['src/a.ts', [[1, 1]] as Array<[number, number]>]]),
      fileContent: () => 'const a = 1;',
      knownKeys: [findingKey('src/a.ts', 'const a = 1;', 'a is wrong')],
    });
    expect(out.kept).toEqual([]);
    expect(out.dropped[0].reason).toBe('duplicate');
  });

  it('keeps a genuinely new finding in the same file', () => {
    const out = applyGateSeeded({
      findings: [raw({ claim: 'something else entirely' })],
      reviewable: ['src/a.ts'],
      changed: new Map([['src/a.ts', [[1, 1]] as Array<[number, number]>]]),
      fileContent: () => 'const a = 1;',
      knownKeys: [findingKey('src/a.ts', 'const a = 1;', 'a is wrong')],
    });
    expect(out.kept).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/ai-review/gate.test.ts`
Expected: FAIL — `findingKey` is not exported; `knownKeys` is not a valid parameter.

- [ ] **Step 3: Implement**

In `scripts/ai-review/gate.ts`, add after `normalizeWs`:

```ts
/**
 * A finding's identity: file + quoted code + what is claimed about it.
 *
 * The claim is load-bearing — two different bugs can live on the same line, and
 * keying on the quote alone would publish only one of them.
 *
 * The quote is cut **before** it is normalised, at exactly the length
 * `toStored` cuts at. That order is the whole trick: a carried finding holds a
 * raw 400-character prefix, a freshly raised one holds the full quote, and both
 * therefore pass through the identical `normalizeWs(slice(0, 400))` here. Doing
 * it the other way round — normalise, then slice — desynchronises the two
 * whenever the cut lands inside a run of whitespace, because collapsing a run
 * the truncated copy no longer contains shortens it below the compared prefix.
 * The consequence would be mild but real: a still-open finding re-derived by
 * the incremental pass would miss its own carried twin and be republished as
 * new.
 */
export function findingKey(file: string, quote: string, claim: string): string {
  return [
    file,
    normalizeWs(quote.slice(0, MAX_QUOTE_CHARS)),
    normalizeWs(claim).toLowerCase(),
  ].join('::');
}
```

Add the import at the top of `gate.ts` (no cycle: `gate` → `state` → `types`):

```ts
import { MAX_QUOTE_CHARS } from './state';
```

Change `applyGate`'s parameter type and its `seen` initialiser:

```ts
export function applyGate(params: {
  findings: RawFinding[];
  reviewable: string[];
  changed: Map<string, Array<[number, number]>>;
  fileContent: (path: string) => string | null;
  /**
   * Identities already published by an earlier run. An incremental pass
   * re-reads files it reviewed before, so without this seed a still-open
   * finding would be raised again and printed twice.
   */
  knownKeys?: Iterable<string>;
}): GateResult {
  const { findings, reviewable, changed, fileContent } = params;
  const inScope = new Set(reviewable);
  const seen = new Set<string>(params.knownKeys ?? []);
```

and replace the inline key construction

```ts
    // The claim is part of the identity: two different bugs can live on the
    // same line, and keying on the quote alone would publish only one of them.
    const key = [
      finding.file,
      normalizeWs(finding.quote),
      normalizeWs(finding.claim).toLowerCase(),
    ].join('::');
```

with

```ts
    const key = findingKey(finding.file, finding.quote, finding.claim);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/ai-review/gate.test.ts`
Expected: PASS — all pre-existing gate tests plus the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/gate.ts scripts/ai-review/gate.test.ts
git commit -m "feat(#364): gate dedupes against findings a previous run published"
```

---

## Task 5: `incremental.ts` — the review-mode decision

**Files:**
- Create: `scripts/ai-review/incremental.ts`
- Create: `scripts/ai-review/incremental.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/ai-review/incremental.test.ts`:

```ts
import { decideMode } from './incremental';
import type { ReviewState } from './state';

const HEAD = 'b'.repeat(40);
const OLD = 'a'.repeat(40);

const state = (over: Partial<ReviewState> = {}): ReviewState => ({
  v: 1,
  head: OLD,
  findings: [],
  spend: { usd: 0, runs: 1, unpriced: 0 },
  ...over,
});

const deps = (over: Partial<{ hasCommit: (s: string) => boolean; isAncestor: (a: string, b: string) => boolean }> = {}) => ({
  hasCommit: () => true,
  isAncestor: () => true,
  ...over,
});

describe('decideMode', () => {
  it('reviews in full when there is no previous state', () => {
    const d = decideMode({ state: null, headSha: HEAD, baseRef: 'main', ...deps() });
    expect(d.mode).toBe('full');
    expect(d.diffSpec).toBe('origin/main...HEAD');
    expect(d.reason).toMatch(/no previous review/i);
  });

  it('reviews in full when the stored head is not in this clone', () => {
    const d = decideMode({
      state: state(),
      headSha: HEAD,
      baseRef: 'main',
      ...deps({ hasCommit: () => false }),
    });
    expect(d.mode).toBe('full');
    expect(d.diffSpec).toBe('origin/main...HEAD');
    expect(d.reason).toContain(OLD);
  });

  it('republishes without any API call when HEAD has not moved', () => {
    const d = decideMode({ state: state({ head: HEAD }), headSha: HEAD, baseRef: 'main', ...deps() });
    expect(d.mode).toBe('republish');
  });

  it('checks equality before ancestry, so a re-run never becomes an empty incremental', () => {
    const d = decideMode({
      state: state({ head: HEAD }),
      headSha: HEAD,
      baseRef: 'main',
      ...deps({ isAncestor: () => true }),
    });
    expect(d.mode).toBe('republish');
  });

  it('reviews in full after a rebase or force-push', () => {
    const d = decideMode({
      state: state(),
      headSha: HEAD,
      baseRef: 'main',
      ...deps({ isAncestor: () => false }),
    });
    expect(d.mode).toBe('full');
    expect(d.reason).toMatch(/rebase|force-push/i);
  });

  it('reviews incrementally from the stored head on an ordinary push', () => {
    const d = decideMode({ state: state(), headSha: HEAD, baseRef: 'main', ...deps() });
    expect(d.mode).toBe('incremental');
    expect(d.diffSpec).toBe(`${OLD}..HEAD`);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/ai-review/incremental.test.ts`
Expected: FAIL — `Failed to resolve import "./incremental"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/ai-review/incremental.ts`:

```ts
import { locateQuoteAll, pickMatch } from './gate';
import type { ReviewState, StoredFinding } from './state';

export type ReviewMode = 'full' | 'incremental' | 'republish';

export interface ModeDecision {
  mode: ReviewMode;
  /** What to pass to `git diff` / `git diff --name-only`. */
  diffSpec: string;
  /** One sentence for the ::notice line explaining why this mode. */
  reason: string;
}

/**
 * Which kind of review this run is.
 *
 * Every uncertain answer resolves to `full`: a full review is exactly today's
 * behaviour at today's price, so the worst case of a wrong guess here is that
 * we save nothing — never that we publish a review computed against a base that
 * is not really behind us.
 *
 * The predicates are injected rather than shelled out so the whole matrix is
 * testable without a git fixture.
 */
export function decideMode(p: {
  state: ReviewState | null;
  headSha: string;
  baseRef: string;
  hasCommit: (sha: string) => boolean;
  isAncestor: (ancestor: string, descendant: string) => boolean;
}): ModeDecision {
  const full = `origin/${p.baseRef}...HEAD`;

  if (!p.state) {
    return { mode: 'full', diffSpec: full, reason: 'no previous review state on this PR' };
  }
  const stored = p.state.head;

  if (!p.hasCommit(stored)) {
    return {
      mode: 'full',
      diffSpec: full,
      reason: `stored head ${stored} is not in this clone`,
    };
  }

  // Equality first: a commit is its own ancestor, so the ancestry branch would
  // otherwise classify a plain workflow re-run as an incremental review of an
  // empty diff — a full-price no-op.
  if (stored === p.headSha) {
    return { mode: 'republish', diffSpec: full, reason: 'HEAD unchanged since the last review' };
  }

  if (!p.isAncestor(stored, p.headSha)) {
    return {
      mode: 'full',
      diffSpec: full,
      reason: `stored head ${stored} is not an ancestor of HEAD (rebase or force-push)`,
    };
  }

  return {
    mode: 'incremental',
    diffSpec: `${stored}..HEAD`,
    reason: `incremental review of ${stored}..${p.headSha}`,
  };
}
```

(The `locateQuoteAll`/`pickMatch`/`StoredFinding` imports are used by Task 6 in the same file; add them there if your linter objects now — otherwise leave them and Task 6 fills in the usage.)

- [ ] **Step 4: Export `pickMatch` from the gate**

In `scripts/ai-review/gate.ts:140`, change

```ts
function pickMatch(matches: QuoteMatch[], reportedLine: number): QuoteMatch {
```

to

```ts
export function pickMatch(matches: QuoteMatch[], reportedLine: number): QuoteMatch {
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run scripts/ai-review/incremental.test.ts && npm run typecheck`
Expected: PASS, 6 tests, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/ai-review/incremental.ts scripts/ai-review/incremental.test.ts scripts/ai-review/gate.ts
git commit -m "feat(#364): review-mode decision (full / incremental / republish)"
```

---

## Task 6: `incremental.ts` — reconcile the findings a previous run published

**Files:**
- Modify: `scripts/ai-review/incremental.ts`
- Modify: `scripts/ai-review/incremental.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `scripts/ai-review/incremental.test.ts`:

```ts
import { reconcileFindings } from './incremental';
import type { StoredFinding } from './state';

const stored = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  file: 'src/a.ts',
  quote: "return 'not_found';",
  matchedLine: 3,
  matchedEndLine: 3,
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  evidence: 'line 3 returns not_found',
  ...over,
});

describe('reconcileFindings', () => {
  it('carries a finding whose quote is still there, refreshing its line numbers', () => {
    const content = ['// a new line on top', 'function f() {', "  return 'not_found';", '}'].join('\n');
    const out = reconcileFindings({ stored: [stored()], fileContent: () => content });
    expect(out.carried).toHaveLength(1);
    expect(out.carried[0].matchedLine).toBe(3);
    expect(out.carried[0].matchedEndLine).toBe(3);
    expect(out.recheck).toEqual([]);
    expect(out.closed).toEqual([]);
  });

  it('closes a finding whose file was deleted or became unreadable', () => {
    const out = reconcileFindings({ stored: [stored()], fileContent: () => null });
    expect(out.closed).toEqual([{ finding: stored(), reason: 'obsolete' }]);
    expect(out.carried).toEqual([]);
    expect(out.recheck).toEqual([]);
  });

  it('queues a re-check when the quoted code was edited away', () => {
    const out = reconcileFindings({
      stored: [stored()],
      fileContent: () => "function f() {\n  return 'merged';\n}",
    });
    expect(out.recheck).toHaveLength(1);
    expect(out.carried).toEqual([]);
  });

  it('re-anchors to the occurrence nearest the stored line when the quote repeats', () => {
    const content = [
      "  return 'not_found';", // line 1
      'const filler = 0;',
      "  return 'not_found';", // line 3
    ].join('\n');
    const out = reconcileFindings({ stored: [stored({ matchedLine: 3 })], fileContent: () => content });
    expect(out.carried[0].matchedLine).toBe(3);
  });

  it('handles a mixed batch across several files', () => {
    const a = stored({ file: 'src/a.ts', quote: 'const a = 1;' });
    const b = stored({ file: 'src/b.ts', quote: 'const b = 2;' });
    const c = stored({ file: 'src/c.ts', quote: 'const c = 3;' });
    const out = reconcileFindings({
      stored: [a, b, c],
      fileContent: (path) => {
        if (path === 'src/a.ts') return 'const a = 1;';
        if (path === 'src/b.ts') return 'const b = 99;';
        return null;
      },
    });
    expect(out.carried.map((f) => f.file)).toEqual(['src/a.ts']);
    expect(out.recheck.map((f) => f.file)).toEqual(['src/b.ts']);
    expect(out.closed.map((c) => c.finding.file)).toEqual(['src/c.ts']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/ai-review/incremental.test.ts`
Expected: FAIL — `reconcileFindings is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `scripts/ai-review/incremental.ts`:

```ts
export interface ClosedFinding {
  finding: StoredFinding;
  /** `obsolete` — the code it lived in is gone. `fixed` — a re-check retired it. */
  reason: 'obsolete' | 'fixed';
}

export interface Reconciliation {
  /** Still anchored in the file, line numbers refreshed. Costs nothing. */
  carried: StoredFinding[];
  /** The quoted code changed: worth one adjudication against the new body. */
  recheck: StoredFinding[];
  /** The file is gone; nothing left to adjudicate. */
  closed: ClosedFinding[];
}

/**
 * Sorts the previous run's published findings into carry / re-check / close by
 * re-anchoring each quote against the file as it is now.
 *
 * This is where the design pays for itself: a finding the push did not touch is
 * republished for zero API calls, and only a finding whose code actually moved
 * buys a call. Re-anchoring uses the gate's own matcher, so a re-indented or
 * re-wrapped quote still counts as unchanged.
 */
export function reconcileFindings(p: {
  stored: StoredFinding[];
  fileContent: (path: string) => string | null;
}): Reconciliation {
  const carried: StoredFinding[] = [];
  const recheck: StoredFinding[] = [];
  const closed: ClosedFinding[] = [];

  for (const finding of p.stored) {
    const content = p.fileContent(finding.file);
    if (content === null) {
      closed.push({ finding, reason: 'obsolete' });
      continue;
    }

    const matches = locateQuoteAll(content, finding.quote);
    if (matches.length === 0) {
      recheck.push(finding);
      continue;
    }

    // The same quote can occur several times; the finding is about the one it
    // was published against, so the stored line breaks the tie.
    const match = pickMatch(matches, finding.matchedLine);
    carried.push({ ...finding, matchedLine: match.start, matchedEndLine: match.end });
  }

  return { carried, recheck, closed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/ai-review/incremental.test.ts`
Expected: PASS, 11 tests total in the file.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/incremental.ts scripts/ai-review/incremental.test.ts
git commit -m "feat(#364): carry, close or re-adjudicate previously published findings"
```

---

## Task 7: verify — one call per file, not one per finding

**Files:**
- Modify: `scripts/ai-review/types.ts`
- Modify: `scripts/ai-review/verify.ts` (full rewrite of the call layer)
- Modify: `scripts/ai-review/verify.test.ts`
- Modify: `scripts/ai-review/replay.ts:153-165`
- Modify: `.github/ai-review/VERIFY.md`

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `scripts/ai-review/verify.test.ts` with:

```ts
import { verifyAll, type VerifyRequest } from './verify';

const req = (over: Partial<VerifyRequest> = {}): VerifyRequest => ({
  id: 'f0',
  file: 'src/a.ts',
  matchedLine: 3,
  matchedEndLine: 3,
  quote: "return 'not_found';",
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  ...over,
});

const respond = (content: string) =>
  (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    }) as unknown as Response) as unknown as typeof fetch;

const deps = (fetchFn: typeof fetch) => ({
  endpoint: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-5.5',
  fetchFn,
  sleep: async () => {},
});

describe('verifyAll', () => {
  it('returns the verdict for a single finding', async () => {
    const out = await verifyAll(deps(respond('{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"line 3"}]}')), {
      instructions: 'verify',
      requests: [req()],
      fileContent: () => 'file body',
    });
    expect(out.results).toEqual([{ id: 'f0', verdict: 'confirmed', evidence: 'line 3' }]);
    expect(out.usage.calls).toBe(1);
  });

  it('sends ONE call for several findings in the same file and maps verdicts back by index', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdicts: [
                  { index: 2, verdict: 'refuted', evidence: 'second is wrong' },
                  { index: 1, verdict: 'confirmed', evidence: 'first holds' },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    })) as unknown as typeof fetch;

    const out = await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      requests: [req({ id: 'f0' }), req({ id: 'f1', claim: 'other bug' })],
      fileContent: () => 'file body',
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(out.results).toEqual([
      { id: 'f0', verdict: 'confirmed', evidence: 'first holds' },
      { id: 'f1', verdict: 'refuted', evidence: 'second is wrong' },
    ]);
    expect(out.usage.calls).toBe(1);
  });

  it('sends one call per file when findings span several files', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"e"}]}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    })) as unknown as typeof fetch;

    const out = await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      requests: [req({ id: 'f0', file: 'src/a.ts' }), req({ id: 'f1', file: 'src/b.ts' })],
      fileContent: () => 'file body',
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(out.results.map((r) => r.id).sort()).toEqual(['f0', 'f1']);
    expect(out.usage.calls).toBe(2);
  });

  it('errors only the finding whose index the model failed to answer', async () => {
    const out = await verifyAll(
      deps(respond('{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"first holds"}]}')),
      {
        instructions: 'verify',
        requests: [req({ id: 'f0' }), req({ id: 'f1', claim: 'other bug' })],
        fileContent: () => 'file body',
      },
    );
    expect(out.results[0]).toEqual({ id: 'f0', verdict: 'confirmed', evidence: 'first holds' });
    expect(out.results[1].verdict).toBe('error');
    expect(out.results[1].evidence).toMatch(/no verdict/i);
  });

  it('ignores an out-of-range index instead of crashing', async () => {
    const out = await verifyAll(
      deps(respond('{"verdicts":[{"index":7,"verdict":"confirmed","evidence":"nonsense"}]}')),
      { instructions: 'verify', requests: [req()], fileContent: () => 'file body' },
    );
    expect(out.results[0].verdict).toBe('error');
  });

  it('errors every finding in a file whose call fails, without throwing', async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 400, text: async () => 'nope' }) as unknown as Response) as unknown as typeof fetch;

    const out = await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      requests: [req({ id: 'f0' }), req({ id: 'f1', claim: 'other' })],
      fileContent: () => 'file body',
    });
    expect(out.results.map((r) => r.verdict)).toEqual(['error', 'error']);
  });

  it('errors every finding in a file whose body vanished, and spends nothing on it', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const out = await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      requests: [req()],
      fileContent: () => null,
    });
    expect(out.results[0].verdict).toBe('error');
    expect(out.usage.calls).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sends the file body exactly once no matter how many findings it carries', async () => {
    let sent = '';
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      sent = init!.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"e"},{"index":2,"verdict":"confirmed","evidence":"e"}]}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      requests: [req({ id: 'f0' }), req({ id: 'f1', claim: 'other' })],
      fileContent: () => 'UNIQUE_BODY_MARKER',
    });
    expect(sent.split('UNIQUE_BODY_MARKER')).toHaveLength(2); // present exactly once
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/ai-review/verify.test.ts`
Expected: FAIL — `VerifyRequest` is not exported and `verifyAll` does not take `requests`.

- [ ] **Step 3: Add the shared request/result types**

Append to `scripts/ai-review/types.ts`:

```ts
/**
 * One adjudication question, flattened.
 *
 * The verify layer deliberately does not know whether this came from a fresh
 * gated finding or from re-checking one a previous run published: the question
 * ("does this claim hold against this file?") is identical, only what the caller
 * does with the answer differs. `id` is the caller's own handle, echoed back on
 * the result so it can map to whichever object it came from.
 */
export interface VerifyRequest {
  id: string;
  file: string;
  matchedLine: number;
  matchedEndLine: number;
  quote: string;
  claim: string;
  why_it_breaks: string;
}

export interface VerifyResult {
  id: string;
  verdict: Verdict;
  evidence: string;
}
```

- [ ] **Step 4: Rewrite `verify.ts`**

Replace the whole contents of `scripts/ai-review/verify.ts` with:

```ts
import { z } from 'zod';
import { callStructured, type OpenAiDeps } from './openai';
import { EMPTY_USAGE, addUsage, type Usage } from './usage';
import type { VerifyRequest, VerifyResult } from './types';

export type { VerifyRequest, VerifyResult } from './types';

/** Verdict budget scales with how many findings share the call. */
const TOKENS_PER_VERDICT = 1200;
const MIN_VERIFY_TOKENS = 2000;

export const VERDICTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'verdict', 'evidence'],
        properties: {
          index: {
            type: 'integer',
            description: 'the 1-based number of the finding this verdict answers',
          },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'out_of_scope'] },
          evidence: {
            type: 'string',
            description: 'one sentence citing the code that settles it',
          },
        },
      },
    },
  },
};

const verdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int(),
      verdict: z.enum(['confirmed', 'refuted', 'out_of_scope']),
      evidence: z.string(),
    }),
  ),
});

function renderFinding(r: VerifyRequest, index: number): string {
  return [
    `## Finding ${index}`,
    `Lines: ${r.matchedLine}-${r.matchedEndLine}`,
    `Claim: ${r.claim}`,
    `Alleged failure: ${r.why_it_breaks}`,
    '',
    'Quoted code:',
    '```',
    r.quote,
    '```',
  ].join('\n');
}

/**
 * Adjudicate every finding raised against one file, in one call.
 *
 * The file body is the expensive part of this prompt and it is identical for
 * every finding in the file, so sending it once instead of once per finding is
 * where most of the verify bill goes away. The model sees exactly the same
 * evidence and the same instructions it saw before; only the packaging changed.
 */
export async function verifyFile(
  deps: OpenAiDeps,
  p: { instructions: string; file: string; fileContent: string; requests: VerifyRequest[] },
): Promise<{ verdicts: Map<number, { verdict: 'confirmed' | 'refuted' | 'out_of_scope'; evidence: string }>; usage: Usage }> {
  const user = [
    `# ${p.requests.length} finding(s) to adjudicate in ${p.file}`,
    '',
    'Answer with one entry per finding, each carrying the finding number as `index`.',
    '',
    ...p.requests.map((r, i) => renderFinding(r, i + 1)),
    '',
    `# Full current contents of ${p.file}`,
    '```',
    p.fileContent,
    '```',
  ].join('\n');

  const { content, usage } = await callStructured(
    deps,
    [
      { role: 'system', content: p.instructions },
      { role: 'user', content: user },
    ],
    { name: 'review_verdicts', schema: VERDICTS_SCHEMA },
    Math.max(MIN_VERIFY_TOKENS, p.requests.length * TOKENS_PER_VERDICT),
  );

  const parsed = verdictsSchema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    throw new Error(`Pass-2 output did not match the schema: ${parsed.error.message.slice(0, 200)}`);
  }

  const verdicts = new Map<number, { verdict: 'confirmed' | 'refuted' | 'out_of_scope'; evidence: string }>();
  for (const v of parsed.data.verdicts) {
    // An index nobody asked about is dropped rather than trusted: silently
    // shifting verdicts onto the wrong finding is worse than one `error`.
    if (v.index >= 1 && v.index <= p.requests.length) {
      verdicts.set(v.index, { verdict: v.verdict, evidence: v.evidence });
    }
  }
  return { verdicts, usage };
}

/**
 * Adjudicate every request, grouped into one call per file.
 *
 * Never throws: a failed call errors only the findings in that one file. The
 * caller decides what an `error` means — for a fresh finding it withholds it
 * (never publish an unchecked claim), for a re-check of an already-published
 * finding it keeps it open (never silently drop a claim the maintainer is
 * acting on). Results come back in request order.
 */
export async function verifyAll(
  deps: OpenAiDeps,
  p: {
    instructions: string;
    requests: VerifyRequest[];
    fileContent: (path: string) => string | null;
  },
): Promise<{ results: VerifyResult[]; usage: Usage }> {
  const byFile = new Map<string, VerifyRequest[]>();
  for (const r of p.requests) {
    const list = byFile.get(r.file);
    if (list) list.push(r);
    else byFile.set(r.file, [r]);
  }

  const byId = new Map<string, VerifyResult>();
  let usage = EMPTY_USAGE;

  for (const [file, requests] of byFile) {
    const content = p.fileContent(file);
    if (content === null) {
      for (const r of requests) {
        byId.set(r.id, { id: r.id, verdict: 'error', evidence: 'file content unavailable' });
      }
      continue;
    }

    try {
      const out = await verifyFile(deps, {
        instructions: p.instructions,
        file,
        fileContent: content,
        requests,
      });
      usage = addUsage(usage, out.usage);
      requests.forEach((r, i) => {
        const v = out.verdicts.get(i + 1);
        byId.set(
          r.id,
          v
            ? { id: r.id, verdict: v.verdict, evidence: v.evidence }
            : { id: r.id, verdict: 'error', evidence: 'the verifier returned no verdict for this finding' },
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const r of requests) {
        byId.set(r.id, { id: r.id, verdict: 'error', evidence: message.slice(0, 200) });
      }
    }
  }

  return { results: p.requests.map((r) => byId.get(r.id)!), usage };
}
```

- [ ] **Step 5: Add the array instruction to `VERIFY.md`**

Append to `.github/ai-review/VERIFY.md`:

```markdown

You may be given **several numbered findings** about the same file in one message. Answer every one
of them: return one entry per finding, and set `index` to that finding's number exactly as it is
labelled above. Judge each finding on its own — a neighbouring finding being wrong says nothing
about this one. Do not merge two findings into one entry and do not answer a number you were not
given.
```

- [ ] **Step 6: Update `replay.ts` to the new shape**

In `scripts/ai-review/replay.ts`, replace the verify block

```ts
  const { confirmed, rejected } = await verifyAll(
    { endpoint, apiKey, model: verifyModel },
    {
      instructions: readFileSync('.github/ai-review/VERIFY.md', 'utf8'),
      findings: kept,
      fileContent: readFile,
    },
  );
```

with

```ts
  const { results } = await verifyAll(
    { endpoint, apiKey, model: verifyModel },
    {
      instructions: readFileSync('.github/ai-review/VERIFY.md', 'utf8'),
      requests: kept.map((f, i) => ({
        id: `f${i}`,
        file: f.file,
        matchedLine: f.matchedLine,
        matchedEndLine: f.matchedEndLine,
        quote: f.quote,
        claim: f.claim,
        why_it_breaks: f.why_it_breaks,
      })),
      fileContent: readFile,
    },
  );
  const byId = new Map(kept.map((f, i) => [`f${i}`, f]));
  const confirmed = results
    .filter((r) => r.verdict === 'confirmed')
    .map((r) => ({ finding: byId.get(r.id)!, evidence: r.evidence }));
  const rejected = results
    .filter((r) => r.verdict !== 'confirmed')
    .map((r) => ({ finding: byId.get(r.id)!, verdict: r.verdict, evidence: r.evidence }));
```

- [ ] **Step 7: Run the tests and the typechecker**

Run: `npx vitest run scripts/ && npm run typecheck`
Expected: PASS — 8 verify tests green, no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add scripts/ai-review/verify.ts scripts/ai-review/verify.test.ts scripts/ai-review/types.ts \
        scripts/ai-review/replay.ts .github/ai-review/VERIFY.md
git commit -m "feat(#364): verify adjudicates one call per file instead of one per finding"
```

---

## Task 8: `render.ts` — cumulative body, cost line, state block

**Files:**
- Modify: `scripts/ai-review/render.ts` (full rewrite)
- Modify: `scripts/ai-review/render.test.ts` (full rewrite)

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `scripts/ai-review/render.test.ts` with:

```ts
import { MAX_BODY_CHARS, renderBody } from './render';
import { MAX_OPEN_FINDINGS, parseState, type StoredFinding } from './state';

const stored = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  file: 'src/a.ts',
  quote: "return 'not_found';",
  matchedLine: 3,
  matchedEndLine: 3,
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  evidence: 'line 3 returns not_found after a successful merge',
  ...over,
});

const base = {
  counts: { raised: 0, gated: 0, verified: 0, carried: 0, closed: 0 },
  costLine: 'find skipped · verify skipped · this run $0.00 · PR total $0.00',
  head: 'a'.repeat(40),
  spend: { usd: 0, runs: 1, unpriced: 0 },
};

describe('renderBody', () => {
  it('states plainly when nothing is open, and still shows the counters', () => {
    const body = renderBody({
      ...base,
      open: [],
      closed: [],
      counts: { raised: 6, gated: 3, verified: 0, carried: 0, closed: 0 },
    });
    expect(body).toContain('No verified findings');
    expect(body).toContain('6 raised → 3 gated → 0 confirmed');
  });

  it('shows file, line, verbatim quote and evidence for an open finding', () => {
    const body = renderBody({ ...base, open: [{ finding: stored() }], closed: [] });
    expect(body).toContain('src/a.ts:3');
    expect(body).toContain("return 'not_found';");
    expect(body).toContain('merge reported as failure');
    expect(body).toContain('line 3 returns not_found after a successful merge');
  });

  it('orders open findings P0 before P1 before P2', () => {
    const body = renderBody({
      ...base,
      open: [{ finding: stored({ severity: 'P2' }) }, { finding: stored({ severity: 'P0' }) }],
      closed: [],
    });
    expect(body.indexOf('P0')).toBeLessThan(body.indexOf('P2'));
  });

  it('annotates a carried finding and one whose fix did not close it', () => {
    const body = renderBody({
      ...base,
      open: [
        { finding: stored({ claim: 'still open' }), note: 'carried from an earlier push' },
        { finding: stored({ claim: 'not closed' }), note: 'the fix did not close this' },
      ],
      closed: [],
    });
    expect(body).toContain('carried from an earlier push');
    expect(body).toContain('the fix did not close this');
  });

  it('lists what this push closed, with the reason', () => {
    const body = renderBody({
      ...base,
      open: [],
      closed: [
        { finding: stored({ claim: 'was fixed' }), reason: 'fixed' },
        { finding: stored({ claim: 'file deleted', file: 'src/gone.ts' }), reason: 'obsolete' },
      ],
      counts: { raised: 0, gated: 0, verified: 0, carried: 0, closed: 2 },
    });
    expect(body).toContain('Closed by this push');
    expect(body).toContain('was fixed');
    expect(body).toContain('src/gone.ts');
  });

  it('prints the cost line and the counters in the footer', () => {
    const body = renderBody({
      ...base,
      open: [{ finding: stored() }],
      closed: [{ finding: stored({ claim: 'gone' }), reason: 'fixed' }],
      counts: { raised: 4, gated: 2, verified: 1, carried: 1, closed: 1 },
      costLine: 'find 1 call 12.3k→3.1k · verify 1 call 8.0k→900 · this run $0.07 · PR total $0.21',
    });
    expect(body).toContain('4 raised → 2 gated → 1 confirmed · 1 carried · 1 closed');
    expect(body).toContain('PR total $0.21');
  });

  it('embeds a state block that parses back to the findings it displayed', () => {
    const body = renderBody({
      ...base,
      open: [{ finding: stored({ severity: 'P2', claim: 'second' }) }, { finding: stored({ severity: 'P0', claim: 'first' }) }],
      closed: [],
      head: 'c'.repeat(40),
      spend: { usd: 0.21, runs: 3, unpriced: 0 },
    });
    const state = parseState(body)!;
    expect(state.head).toBe('c'.repeat(40));
    expect(state.spend).toEqual({ usd: 0.21, runs: 3, unpriced: 0 });
    expect(state.findings.map((f) => f.claim)).toEqual(['first', 'second']);
  });

  it('caps the number of open findings and says it did', () => {
    const open = Array.from({ length: MAX_OPEN_FINDINGS + 3 }, (_, i) => ({
      finding: stored({ severity: 'P2', claim: `claim ${i}` }),
    }));
    const body = renderBody({ ...base, open, closed: [] });
    expect(parseState(body)!.findings).toHaveLength(MAX_OPEN_FINDINGS);
    expect(body).toMatch(/3 (further |more )?finding/i);
  });

  it('keeps the body under the size limit by dropping closed entries first', () => {
    const fat = 'x'.repeat(4000);
    const body = renderBody({
      ...base,
      open: [{ finding: stored() }],
      closed: Array.from({ length: 40 }, (_, i) => ({
        finding: stored({ claim: `closed ${i}`, why_it_breaks: fat }),
        reason: 'fixed' as const,
      })),
    });
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body).toContain("return 'not_found';"); // the open finding survived
    expect(body).toMatch(/omitted to fit/i);
  });

  it('drops open findings too, and keeps the state in step with what it shows', () => {
    const fat = 'y'.repeat(20_000);
    const open = Array.from({ length: 6 }, (_, i) => ({
      finding: stored({ severity: 'P2', claim: `claim ${i}`, why_it_breaks: fat }),
    }));
    const body = renderBody({ ...base, open, closed: [] });
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    const state = parseState(body)!;
    for (const f of state.findings) expect(body).toContain(f.claim);
    expect(state.findings.length).toBeLessThan(6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/ai-review/render.test.ts`
Expected: FAIL — `MAX_BODY_CHARS` is not exported and `renderBody` does not accept `open`.

- [ ] **Step 3: Write the implementation**

Replace the whole contents of `scripts/ai-review/render.ts` with:

```ts
import {
  capOpenFindings,
  orderBySeverity,
  renderState,
  type Spend,
  type StoredFinding,
} from './state';
import type { ClosedFinding } from './incremental';

/**
 * GitHub rejects a review body over 65 536 characters. We stop well short: the
 * marker and heading `wrapBody` adds are charged on top, and a review that
 * fails to post is worth less than one that admits it left something out.
 */
export const MAX_BODY_CHARS = 60_000;

export interface OpenFinding {
  finding: StoredFinding;
  /** Why it is shown this way: carried, re-raised after a failed fix, unverified. */
  note?: string;
}

export interface RenderParams {
  open: OpenFinding[];
  closed: ClosedFinding[];
  counts: {
    raised: number;
    gated: number;
    verified: number;
    carried: number;
    closed: number;
  };
  costLine: string | null;
  /** The commit this review was computed against; goes into the state block. */
  head: string;
  spend: Spend;
}

function openBlock(item: OpenFinding, n: number): string {
  const f = item.finding;
  const lines = [
    `### ${n}. ${f.severity} — ${f.claim}`,
    '',
    `**Where:** \`${f.file}:${f.matchedLine}\``,
    '',
    '```',
    f.quote,
    '```',
    '',
    `**Why it breaks:** ${f.why_it_breaks}`,
    '',
    `**Verified:** ${f.evidence}`,
  ];
  if (item.note) lines.push('', `<sub>${item.note}</sub>`);
  return lines.join('\n');
}

function closedLine(c: ClosedFinding): string {
  const why = c.reason === 'fixed' ? 'fixed by this push' : 'the code it referred to is gone';
  return `- ~~${c.finding.claim}~~ (\`${c.finding.file}\`) — ${why}`;
}

function assemble(p: {
  open: OpenFinding[];
  closed: ClosedFinding[];
  counts: RenderParams['counts'];
  costLine: string | null;
  omitted: number;
  head: string;
  spend: Spend;
}): string {
  const sections: string[] = [];

  if (p.open.length === 0) {
    sections.push('**No verified findings.**');
  } else {
    sections.push('### Open findings', '');
    sections.push(p.open.map((item, i) => openBlock(item, i + 1)).join('\n\n'));
  }

  if (p.closed.length > 0) {
    sections.push('', '### Closed by this push', '', p.closed.map(closedLine).join('\n'));
  }

  if (p.omitted > 0) {
    sections.push(
      '',
      `<sub>${p.omitted} further finding(s) omitted to fit this review's size limit.</sub>`,
    );
  }

  const { raised, gated, verified, carried, closed } = p.counts;
  sections.push(
    '',
    '---',
    '',
    `<sub>${raised} raised → ${gated} gated → ${verified} confirmed · ` +
      `${carried} carried · ${closed} closed.</sub>`,
  );
  if (p.costLine) sections.push('', `<sub>${p.costLine}</sub>`);

  // The state block is written by the same call that writes the text it
  // describes, so the two cannot drift apart — that is the whole reason the
  // state lives in the review body rather than anywhere else.
  sections.push(
    '',
    renderState({
      v: 1,
      head: p.head,
      findings: p.open.map((item) => item.finding),
      spend: p.spend,
    }),
  );

  return sections.join('\n');
}

/**
 * The full review body: what is still open, what this push closed, the
 * counters, the bill, and the hidden state the next run reads.
 *
 * Cumulative on purpose. An incremental run only re-derives findings about the
 * code this push touched, so rendering just those would silently erase every
 * still-open finding from the previous review.
 */
export function renderBody(p: RenderParams): string {
  const { kept, dropped } = capOpenFindings(p.open, (item) => item.finding);
  let open = kept;
  let closed = orderBySeverity(p.closed, (c) => c.finding);
  let omitted = dropped;

  let body = assemble({ ...p, open, closed, omitted });

  // Shrink until it fits: closed entries first — they are a courtesy, while an
  // open finding is the product — then the least severe open findings.
  while (body.length > MAX_BODY_CHARS && closed.length > 0) {
    closed = closed.slice(0, -1);
    omitted += 1;
    body = assemble({ ...p, open, closed, omitted });
  }
  while (body.length > MAX_BODY_CHARS && open.length > 1) {
    open = open.slice(0, -1);
    omitted += 1;
    body = assemble({ ...p, open, closed, omitted });
  }

  return body;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/ai-review/render.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/render.ts scripts/ai-review/render.test.ts
git commit -m "feat(#364): cumulative review body with closed section, cost line and state block"
```

---

## Task 9: orchestration — `runReview` with injected git and fetch

**Files:**
- Modify: `scripts/ai-pr-review.ts:125-275`
- Modify: `scripts/ai-pr-review.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `scripts/ai-pr-review.test.ts`:

```ts
import { findExistingReview, runReview, type ReviewDeps } from './ai-pr-review';
import { renderState } from './ai-review/state';

const CFG = {
  openaiApiKey: 'sk-test',
  openaiEndpoint: 'https://api.openai.com/v1',
  findModel: 'gpt-5.5',
  verifyModel: 'gpt-5.5',
  githubToken: 't',
  repo: 'o/r',
  prNumber: 7,
  baseRef: 'main',
  headRef: 'feature',
  prTitle: 'Title',
  prBody: 'Body',
};

const FILE_BODY = "function f() {\n  return 'not_found';\n}\n";
const DIFF = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' function f() {',
  "+  return 'not_found';",
  ' }',
].join('\n');

const FINDING = {
  file: 'src/a.ts',
  start_line: 2,
  end_line: 2,
  quote: "return 'not_found';",
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  confidence: 'high',
};

function openaiFetch(responses: string[]): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    const content = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      }),
      text: async () => content,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function deps(over: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    headSha: 'b'.repeat(40),
    hasCommit: () => true,
    isAncestor: () => true,
    listChangedFiles: () => ['src/a.ts'],
    getDiff: () => DIFF,
    readFile: () => FILE_BODY,
    readInstructions: () => 'instructions',
    log: () => {},
    openaiFetch: (undefined as unknown) as typeof fetch,
    githubFetch: (undefined as unknown) as typeof fetch,
    ...over,
  };
}

function githubFetch(existingBody: string | null): { fetchFn: typeof fetch; put: { body?: string } } {
  const put: { body?: string } = {};
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    if (!init || init.method === undefined) {
      return jsonResponse(
        existingBody === null ? [] : [{ id: 42, body: existingBody, user: { type: 'Bot' } }],
      );
    }
    put.body = JSON.parse(init.body as string).body;
    return jsonResponse({ id: 42 });
  }) as unknown as typeof fetch;
  return { fetchFn, put };
}

describe('runReview — full mode', () => {
  it('reviews the whole PR when there is no previous review and publishes the finding', async () => {
    const ai = openaiFetch([
      JSON.stringify({ findings: [FINDING] }),
      JSON.stringify({ verdicts: [{ index: 1, verdict: 'confirmed', evidence: 'line 2 returns not_found' }] }),
    ]);
    const gh = githubFetch(null);

    await runReview(CFG, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    expect(ai.calls).toHaveLength(2); // one find, one verify
    expect(gh.put.body).toContain('merge reported as failure');
    expect(gh.put.body).toContain('ai-pr-review-state');
  });
});

describe('runReview — republish mode', () => {
  it('re-posts the previous body byte-for-byte and calls OpenAI zero times', async () => {
    const previous = `${MARKER}\n\nold body\n\n${renderState({
      v: 1,
      head: 'b'.repeat(40),
      findings: [],
      spend: { usd: 0.1, runs: 1, unpriced: 0 },
    })}`;
    const ai = openaiFetch(['{}']);
    const gh = githubFetch(previous);

    await runReview(CFG, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    expect(ai.calls).toEqual([]);
    expect(gh.put.body).toBe(previous);
  });
});

describe('runReview — incremental mode', () => {
  const previousState = (findings: unknown[]) =>
    `${MARKER}\n\nold\n\n${renderState({
      v: 1,
      head: 'a'.repeat(40),
      findings: findings as never,
      spend: { usd: 0.1, runs: 1, unpriced: 0 },
    })}`;

  const carried = {
    file: 'src/a.ts',
    quote: "return 'not_found';",
    matchedLine: 2,
    matchedEndLine: 2,
    claim: 'merge reported as failure',
    why_it_breaks: 'cron stats count a success as a miss',
    severity: 'P1',
    evidence: 'line 2 returns not_found',
  };

  it('diffs from the stored head, not from the base branch', async () => {
    const seen: string[] = [];
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(previousState([]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: (spec) => {
          seen.push(spec);
          return ['src/a.ts'];
        },
        getDiff: (spec) => {
          seen.push(spec);
          return DIFF;
        },
      }),
    );
    expect(seen.every((s) => s === `${'a'.repeat(40)}..HEAD`)).toBe(true);
  });

  it('carries a still-anchored finding for free and does not re-publish it twice', async () => {
    // The find pass re-raises the very same finding; the gate must swallow it.
    const ai = openaiFetch([JSON.stringify({ findings: [FINDING] })]);
    const gh = githubFetch(previousState([carried]));

    await runReview(CFG, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    expect(ai.calls).toHaveLength(1); // find only — nothing to verify
    expect(gh.put.body!.split('merge reported as failure')).toHaveLength(2);
    expect(gh.put.body).toContain('carried');
  });

  it('closes a finding whose quoted code was edited away and re-adjudicated as fixed', async () => {
    const ai = openaiFetch([
      JSON.stringify({ findings: [] }),
      JSON.stringify({ verdicts: [{ index: 1, verdict: 'refuted', evidence: 'the function now returns merged' }] }),
    ]);
    const gh = githubFetch(previousState([carried]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        readFile: () => "function f() {\n  return 'merged';\n}\n",
      }),
    );

    expect(gh.put.body).toContain('Closed by this push');
    expect(gh.put.body).toContain('No verified findings');
  });

  it('keeps a re-checked finding open when the verifier confirms the fix did not close it', async () => {
    const ai = openaiFetch([
      JSON.stringify({ findings: [] }),
      JSON.stringify({ verdicts: [{ index: 1, verdict: 'confirmed', evidence: 'still returns not_found via the helper' }] }),
    ]);
    const gh = githubFetch(previousState([carried]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        readFile: () => 'function f() {\n  return helper();\n}\n',
      }),
    );
    expect(gh.put.body).toContain('the fix did not close this');
  });

  it('keeps a re-checked finding open when its verification errors, unlike a fresh one', async () => {
    const ai = {
      calls: [] as string[],
      fetchFn: (async (url: string, init?: RequestInit) => {
        ai.calls.push(url);
        if (ai.calls.length === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
              usage: { prompt_tokens: 10, completion_tokens: 1 },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 400, text: async () => 'boom' } as unknown as Response;
      }) as unknown as typeof fetch,
    };
    const gh = githubFetch(previousState([carried]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        readFile: () => 'function f() {\n  return helper();\n}\n',
      }),
    );
    expect(gh.put.body).toContain('merge reported as failure');
    expect(gh.put.body).toMatch(/unverified this run/i);
  });

  it('skips the find call entirely when the push touched no reviewable file', async () => {
    const ai = openaiFetch(['{}']);
    const gh = githubFetch(previousState([carried]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: () => ['docs/guide.md'],
      }),
    );
    expect(ai.calls).toEqual([]);
    expect(gh.put.body).toContain('merge reported as failure'); // still published
  });

  it('accumulates the PR spend across runs in the state block', async () => {
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(previousState([]));

    await runReview(CFG, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    const state = parseStateFromBody(gh.put.body!);
    expect(state.spend.runs).toBe(2);
    expect(state.spend.usd).toBeGreaterThan(0.1);
  });
});

import { parseState } from './ai-review/state';
function parseStateFromBody(body: string) {
  const s = parseState(body);
  if (!s) throw new Error('no state in body');
  return s;
}

describe('findExistingReview', () => {
  it('returns the bot marker review so the body is read once and reused by the upsert', async () => {
    const gh = githubFetch(`${MARKER}\nbody here`);
    const found = await findExistingReview({ repo: 'o/r', prNumber: 7, token: 't', fetchFn: gh.fetchFn });
    expect(found).toEqual({ id: 42, body: `${MARKER}\nbody here` });
  });

  it('returns null when the bot has never reviewed this PR', async () => {
    const gh = githubFetch(null);
    const found = await findExistingReview({ repo: 'o/r', prNumber: 7, token: 't', fetchFn: gh.fetchFn });
    expect(found).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: FAIL — `runReview` and `findExistingReview` are not exported.

- [ ] **Step 3: Split the GitHub read from the write**

In `scripts/ai-pr-review.ts`, replace `upsertReview` (lines 125-163) with:

```ts
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
```

- [ ] **Step 4: Write `runReview`**

In `scripts/ai-pr-review.ts`, replace the imports at the top with:

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';

import { buildReviewContext } from './ai-review/context';
import { runFind } from './ai-review/find';
import { applyGate, changedLineRanges, findingKey } from './ai-review/gate';
import { decideMode, reconcileFindings, type ClosedFinding } from './ai-review/incremental';
import { renderBody, type OpenFinding } from './ai-review/render';
import { parseState, toStored, type ReviewState, type StoredFinding } from './ai-review/state';
import { EMPTY_USAGE, addUsage, costUsd, formatCostLine } from './ai-review/usage';
import { verifyAll } from './ai-review/verify';
import type { GatedFinding, VerifyRequest } from './ai-review/types';
```

Then replace `main()` (lines 209-267) with:

```ts
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

export async function runReview(cfg: Config, deps: ReviewDeps): Promise<void> {
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
```

Delete the now-unused `listChangedFiles` and `getDiff` module-level helpers (old lines 165-180).

- [ ] **Step 5: Run the tests and the typechecker**

Run: `npx vitest run scripts/ && npm run typecheck`
Expected: PASS — every ai-review test plus the 12 new orchestration tests, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/ai-pr-review.ts scripts/ai-pr-review.test.ts
git commit -m "feat(#364): incremental review orchestration with per-PR state and self-billing"
```

---

## Task 10: replay an incremental run offline

**Files:**
- Modify: `scripts/ai-review/replay.ts:78-135`
- Modify: `scripts/ai-review/replay.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `scripts/ai-review/replay.test.ts`:

```ts
import { resolveReplayBase } from './replay';

describe('resolveReplayBase', () => {
  it('uses the merge-base with the PR base branch by default', () => {
    const base = resolveReplayBase({
      explicit: undefined,
      baseRefName: 'main',
      head: 'head-sha',
      mergeBase: (a, b) => `merge-base(${a},${b})`,
    });
    expect(base).toBe('merge-base(origin/main,head-sha)');
  });

  it('uses an explicit base verbatim so an incremental push can be replayed', () => {
    const base = resolveReplayBase({
      explicit: 'abc123',
      baseRefName: 'main',
      head: 'head-sha',
      mergeBase: () => 'should-not-be-called',
    });
    expect(base).toBe('abc123');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/ai-review/replay.test.ts`
Expected: FAIL — `resolveReplayBase is not a function`.

- [ ] **Step 3: Implement**

In `scripts/ai-review/replay.ts`, add above `main()`:

```ts
/**
 * Which commit the replay diffs against.
 *
 * Without an explicit base a replay always measures a *first* review, which is
 * no longer what CI usually runs. Passing the previously reviewed head lets a
 * real incremental run be measured offline — including its much smaller find
 * prompt — before betting money on a config change.
 */
export function resolveReplayBase(p: {
  explicit: string | undefined;
  baseRefName: string;
  head: string;
  mergeBase: (a: string, b: string) => string;
}): string {
  return p.explicit ?? p.mergeBase(`origin/${p.baseRefName}`, p.head);
}
```

In `main()`, replace

```ts
  const pr = process.argv[2];
  if (!pr) throw new Error('usage: npm run ai-review-replay -- <pr-number>');
```

with

```ts
  const pr = process.argv[2];
  if (!pr) throw new Error('usage: npm run ai-review-replay -- <pr-number> [base-sha]');
  const explicitBase = process.argv[3];
```

and replace

```ts
  const mergeBase = sh(['merge-base', `origin/${meta.baseRefName}`, head]).trim();

  const changed = sh(['diff', '--name-only', `${mergeBase}..${head}`])
```

with

```ts
  const mergeBase = resolveReplayBase({
    explicit: explicitBase,
    baseRefName: meta.baseRefName,
    head,
    mergeBase: (a, b) => sh(['merge-base', a, b]).trim(),
  });
  console.error(`replaying ${mergeBase}..${head}`);

  const changed = sh(['diff', '--name-only', `${mergeBase}..${head}`])
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/ai-review/replay.test.ts && npm run typecheck`
Expected: PASS, no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/replay.ts scripts/ai-review/replay.test.ts
git commit -m "feat(#364): replay accepts an explicit base to measure an incremental run"
```

---

## Task 11: update `spec.md` §5.10

**Files:**
- Modify: `spec.md` §5.10 (around lines 1260–1330)

- [ ] **Step 1: Insert the new bullets**

In `spec.md`, immediately after the `- **Двоетапний пайплайн.** …` bullet, insert:

```markdown
- **Режими рев'ю (з 2026-07-30, #364).** Кожен PR має рівно одне маркер-рев'ю бота,
  і в його тілі живе **прихований блок стану** `<!-- ai-pr-review-state {…} -->`:
  версія, SHA голови, на якій рахувалося минуле рев'ю, відкриті зауваження
  (`file`/`quote`≤400 симв./рядки/`claim`/`why_it_breaks`/`severity`/`evidence`) і
  накопичені витрати PR. Стан і текст пише один і той самий PUT, тож розійтися вони
  не можуть. Перед рев'ю скрипт читає це тіло (той самий list-виклик, який потім
  використає upsert) і вибирає режим:
  - немає рев'ю / блок не парситься / формат іншої версії → **full** (як раніше);
  - збереженої голови немає в клоні → **full** + `::notice` з причиною;
  - збережена голова **дорівнює** HEAD (перезапуск workflow) → **republish**:
    попереднє тіло публікується байт-у-байт, **нуль** викликів OpenAI;
  - збережена голова **не є предком** HEAD (rebase/force-push) → **full** + `::notice`;
  - інакше → **incremental**: діф і повні тіла файлів беруться з `<stored>..HEAD`,
    тобто модель судить лише те, що змінив цей push. `changedLineRanges` для gate
    рахується з того самого інкрементального діфу. Якщо push не зачепив жодного
    файлу в скоупі, find-прохід **пропускається** повністю.
  Будь-яка невпевненість розв'язується на користь **full** — це поведінка й ціна,
  які були до #364, тож найгірший наслідок хибного вибору — не зекономити.
- **Долі раніше опублікованих зауважень (`incremental.ts`).** Кожне зауваження зі
  стану переанкорюється в **поточному** вмісті файлу тим самим матчером, що й gate
  (`locateQuoteAll`, whitespace-normalised): цитата знайшлася → **carried** (рядки
  оновлюються, **0** викликів); файл зник/нечитний → **closed (obsolete)**; цитати
  немає, бо код правили → **re-adjudicate** (1 виклик на *файл*). Вердикт
  `refuted`/`out_of_scope` на переперевірці = **закрито, виправлено**; `confirmed` =
  лишається відкритим із поміткою «the fix did not close this». **Fail-семантика на
  переперевірці навмисно обернена**: помилка виклику **лишає** зауваження відкритим
  («unverified this run»), бо воно вже було опубліковане на доказах, — тоді як
  свіже зауваження з помилкою верифікації, навпаки, не публікується. Свіжі
  зауваження дедуплікуються проти carried за (файл + нормалізована цитата +
  нормалізований claim), тож інкрементальний прохід не друкує те саме двічі.
- **Verify батчиться по файлу.** Один виклик на **файл**, а не на зауваження: тіло
  файлу їде в промпті один раз, разом із усіма пронумерованими зауваженнями до
  нього, відповідь — масив `{index, verdict, evidence}`. Свіжі зауваження і
  переперевірки того самого файлу йдуть **одним** викликом (питання ідентичне,
  різна лише fail-семантика відповіді). Індекс поза діапазоном або відсутній
  вердикт = `error` **лише** для того зауваження; збій виклику = `error` для
  зауважень **того** файлу, ніколи не валить job.
- **Рев'ювер друкує власний рахунок.** `callStructured` повертає `usage` разом із
  контентом; `usage.ts` (чистий) накопичує `prompt`/`cached`/`completion`/
  `reasoning` токени по стадіях і переводить у долари через таблицю цін із **датою
  останньої перевірки** (`gpt-5.5` = $5 / $0.50 cached / $30 за 1M, перевірено
  2026-07-30). Модель без перевіреної ціни друкує токени **без** доларів, а сума PR
  позначається `+` (нижня межа) — вигадана цифра гірша за визнану прогалину.
  Виведення йде і в `::notice` лога, і в футер рев'ю; сума по PR накопичується в
  блоці стану. Токени — істина, долари — похідне: якщо футер розійдеться з
  дашбордом, помилкова **таблиця**, не пайплайн.
- **Кумулятивне тіло рев'ю.** Секції «Open findings» (carried + свіжо підтверджені,
  сортування P0→P1→P2, далі порядок публікації) і «Closed by this push» (по рядку:
  claim + чому закрито). Футер: `N raised → M gated → K confirmed · C carried ·
  F closed` + рядок вартості + прихований блок стану. Обмеження: ≤20 відкритих
  зауважень і ≤60 000 символів тіла; ріжеться **з кінця порядку показу** (спершу
  closed, потім найменш серйозні відкриті), і тіло **прямо каже**, скільки
  зауважень приховано. Без кумулятивності інкрементальний прогін стирав би ще
  відкриті зауваження минулого.
```

- [ ] **Step 2: Update the offline-replay bullet**

Replace, in the `- **Offline replay:**` bullet, the first sentence

```
  `npm run ai-review-replay -- <pr>` ганяє весь пайплайн
```

with

```
  `npm run ai-review-replay -- <pr> [base-sha]` ганяє весь пайплайн
  (з `base-sha` — саме той інкрементальний зріз, який побачив би CI на
  відповідному push, інакше — перше рев'ю від merge-base)
```

- [ ] **Step 3: Correct the measured-state paragraph**

In the `**Виміряний стан (чесно, не для оптимізму).**` paragraph, append at the end:

```markdown
Вартість (виміряно на прогонах #359–#363, 2026-07-30): **~$0.23 за запуск
workflow, ~$0.63 за PR**; кожен PR рев'ювався 2–3 рази повністю, verify відхиляв
8 із 29 (28%) — усі `out_of_scope`, **жодного** `refuted`, тобто це фільтр
design-шуму, а не фабрикацій. #364 (інкрементальний ре-рев'ю + батчений verify +
самозвітність) цілить у ~$0.30 за PR. **Важливо:** початкова гіпотеза «платимо
переважно за output» **не підтвердилась** — при $5/1M input виміряні ~390k
вхідних токенів дають ~$1.95 із $2.52, тобто домінує **input**, і найбільший
важіль — саме скорочення контексту через інкрементальність. Це ще одна причина,
чому інструментація йде **перед** ставками на якість.
```

- [ ] **Step 4: Verify the spec renders and commit**

Run: `git diff --stat spec.md`
Expected: `spec.md` shows roughly +60 lines, −2.

```bash
git add spec.md
git commit -m "docs(#364): spec.md §5.10 — review modes, batched verify, cost footer"
```

---

## Task 12: whole-suite verification and PR

**Files:** none created; verification only.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — every suite green, zero failures. If anything outside `scripts/ai-review/` broke, that is a real regression; fix it before continuing.

- [ ] **Step 2: Run the typechecker and the build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0 with no output.

- [ ] **Step 3: Confirm no leftover references to the old APIs**

Run: `grep -rn "verifyFinding\|confirmed, rejected\|counts: { raised" scripts/ || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 4: Confirm the reviewer's own workflow needs no change**

Run: `grep -n "fetch-depth" .github/workflows/codex-review.yml`
Expected: `fetch-depth: 0` — the incremental path reads ancestors of the PR head, which a full-depth checkout already has. **No workflow edit is part of this change.**

- [ ] **Step 5: Push the branch and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "perf(#364): incremental AI review, batched verify, self-reported spend" --body "$(cat <<'EOF'
Closes #364.

Design: `docs/superpowers/specs/2026-07/2026-07-30-ai-review-cost-reduction-design.md`
Plan: `docs/superpowers/plans/2026-07/2026-07-30-ai-review-cost-reduction.md`

## What changes

- **Incremental re-review.** The reviewer's state (last reviewed head, open findings, PR spend)
  rides in a hidden block inside the review body it already upserts. A later push diffs
  `stored_head..HEAD` and sends only the files that touches. Rebase, force-push, a missing object
  or an unparseable state all fall back to a full review; a re-run on the same SHA republishes the
  previous body with zero OpenAI calls.
- **Old findings are carried, closed or re-adjudicated.** A finding whose quote still anchors is
  republished for free; one whose file is gone is closed; one whose code was edited buys a single
  re-check. On a re-check the fail semantics reverse deliberately — an errored verification keeps
  the finding open, because it was already published on evidence.
- **Verify batches per file** — one call carrying the body once plus every numbered finding against
  it, answered as an array. Same model, same evidence, same adjudication rules.
- **The reviewer prints its own bill.** Every call's `usage` is accumulated per stage and converted
  through a dated price table (gpt-5.5 = $5 / $0.50 cached / $30 per 1M, checked 2026-07-30); an
  unpriced model prints tokens and no dollars. Output goes to `::notice` lines and a footer line,
  with the PR total carried in the state block.
- **Cumulative review body** — open findings + "closed by this push" + counters + cost.

## Correction to the design doc

The design's premise that *output* dominates the bill is **wrong**: at $5/1M input the measured
~390k input tokens account for ~$1.95 of the $2.52. Input dominates — which makes incremental
re-review the biggest available lever, and makes the instrumentation the thing that settles the
next question instead of guesswork.

## Verification

Every new module is pure and unit-tested: mode-decision matrix, re-anchoring/carry/close/re-check,
state round-trip and escaping, batched verify mapping and per-file call counts, usage arithmetic
and unpriced-model handling, cumulative rendering and both size caps. Orchestration is tested
end-to-end with injected git predicates and a fake fetch, including the republish path (asserted
zero API calls) and the reversed re-check fail semantics.

Post-merge, per the design's rollout: first PR → full review with a cost footer; its second push →
incremental; then compare summed footers against the dashboard delta (a mismatch means the price
table, not the pipeline), and watch the verify confirm rate against the 21-of-29 baseline.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01HWGnJ9SqLuToR2rFb1ccQe
EOF
)"
```

- [ ] **Step 6: Wait for the AI review and CI, then read it critically**

Poll the PR's checks **by head SHA** (not "latest completed run"), read every review comment, verify each claim against the code, push back on the wrong ones and fix the right ones. Not done at green tests. Report "ready to merge" — **do not merge**; the user merges.

---

## Self-review

**Spec coverage:**

| Design section | Task |
|---|---|
| §1 state inside the review | 3 (state.ts), 8 (render writes it), 9 (orchestrator reads it) |
| §2 review mode table | 5 |
| §3 carry / close / re-adjudicate + reversed fail semantics + dedupe | 4 (dedupe seed), 6 (classification), 9 (verdict → disposition) |
| §4 verify batches per file | 7 |
| §5 self-reported spend | 1 (usage.ts), 2 (usage plumbed through), 9 (accumulation + footer) |
| §6 cumulative body | 8 |
| Modules table | 1–10 (every listed file has a task; `find.ts`/`gate.ts`/`context.ts` unchanged except the two exports §3 requires) |
| Testing section | every task's Steps 1–4 |
| `spec.md` §5.10 update | 11 |
| Rollout & verification | 12, Step 6 |

**Type consistency check:** `StoredFinding`, `ReviewState`, `Spend`, `ClosedFinding`, `OpenFinding`,
`VerifyRequest`, `VerifyResult`, `Usage`, `ModeDecision`, `Reconciliation`, `ReviewDeps`,
`ExistingReview` are each defined exactly once and used with the same field names in every later
task. `toStored(f, evidence)` (Task 3) is called with that arity in Task 9. `capOpenFindings` and
`orderBySeverity` take `(items, pick)` in both Task 3 and Task 8. `verifyAll` takes `requests` and
returns `{ results, usage }` in Tasks 7, 9 and 10. `costUsd(model, usage)` returns `number | null`
in Tasks 1 and 9.

**Known non-obvious interaction:** Task 5 creates `incremental.ts` importing `locateQuoteAll` and
`pickMatch` before Task 6 uses them. That is intentional (Task 5 also exports `pickMatch` from the
gate, which Task 6 depends on); if the linter flags unused imports between the two tasks, run them
back-to-back.
