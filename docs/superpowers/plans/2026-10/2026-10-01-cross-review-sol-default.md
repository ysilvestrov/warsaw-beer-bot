# Cross-review Sol Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run cross-review -- --reviewer codex` runs on `gpt-6.1-sol` unless `--model` says otherwise.

**Architecture:** One per-reviewer default map in `scripts/cross-review/core.ts`, applied inside `buildReviewerCommand` as `model ?? DEFAULT_MODEL[reviewer]`. `parseArgs` and `Options` are unchanged, so `--model` stays an optional override.

**Tech Stack:** TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-01-cross-review-sol-default-design.md`

## Global Constraints

- Codex default model ID: `gpt-6.1-sol`, written exactly once in production code and pinned by exactly one test.
- `claude` has no default: its command carries `--model` only when it is passed explicitly.
- No fallback to the CLI default when the pinned model fails.
- Gate: `npm test && npm run typecheck`, the full suite every task.

Both tasks qualify as inline (full code given, ≤2 files plus tests, no new decision). The reviewer seat is the pre-PR `cross-review` run, which sees both tasks.

---

### Task 1: Default model in `buildReviewerCommand`

**Files:**
- Modify: `scripts/cross-review/core.ts` (the `buildReviewerCommand` block, around line 134)
- Test: `scripts/cross-review/core.test.ts` (`describe('buildReviewerCommand')`)

**Interfaces:**
- Produces: `export const DEFAULT_MODEL: Partial<Record<Reviewer, string>>`. The signature of `buildReviewerCommand` is unchanged.

- [ ] **Step 1: Change the codex no-model test to expect the default**

In `core.test.ts`, replace the test `'codex: read-only sandbox, report via -o'` with:

```ts
  test('codex: read-only sandbox, report via -o, Sol model by default', () => {
    expect(buildReviewerCommand({ ...base, reviewer: 'codex' })).toEqual({
      cmd: 'codex',
      args: ['exec', '-s', 'read-only', '--ephemeral', '-o', '/t/r.md', '-m', 'gpt-6.1-sol', 'P'],
      reportFromStdout: false,
    });
  });
```

Rename `'codex: model passes through as -m'` to `'codex: an explicit model overrides the default'`, and keep its body (`gpt-5.5`, exactly one `-m`). Keep the claude tests unchanged: `'claude: restricted, …'` is now the guard that claude has no default.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run scripts/cross-review/core.test.ts`
Expected: FAIL in `codex: read-only sandbox, report via -o, Sol model by default` (args lack `-m gpt-6.1-sol`).

- [ ] **Step 3: Implement**

In `core.ts`, above `export interface ReviewerCommand`:

```ts
// Codex is pinned to the Sol class: its CLI default moves with updates, and Astra costs far more
// tokens for no better review (spec 2026-10-01). Claude keeps its CLI default.
export const DEFAULT_MODEL: Partial<Record<Reviewer, string>> = { codex: 'gpt-6.1-sol' };
```

At the top of `buildReviewerCommand`'s body:

```ts
  const model = p.model ?? DEFAULT_MODEL[p.reviewer];
```

Then replace both `p.model` uses in the args with `model`.

- [ ] **Step 4: Full gate**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Mutation check**

Change `DEFAULT_MODEL` to `{ codex: 'gpt-6.1-sol', claude: 'x' }`, run the file, and confirm that `claude: restricted, …` fails. Then revert. Change `p.model ?? DEFAULT_MODEL[...]` to `DEFAULT_MODEL[p.reviewer] ?? p.model`, and confirm that `codex: an explicit model overrides the default` fails. Then revert.

- [ ] **Step 6: Commit**

```bash
git add scripts/cross-review/core.ts scripts/cross-review/core.test.ts
git commit -m "feat(cross-review): codex reviewer defaults to gpt-6.1-sol"
```

### Task 2: Rules and design amendment

**Files:**
- Modify: `CLAUDE.md` (the cross-review bullet)
- Modify: `AGENTS.md` (the cross-review bullet, line ~438)
- Modify: `docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md` (the `--model` line in "Interface")

- [ ] **Step 1: CLAUDE.md.** After the sentence that ends `…лишається в tmp/.`, add: `Модель codex скрипт задає сам — Sol (`DEFAULT_MODEL` у `scripts/cross-review/core.ts`, зараз `gpt-6.1-sol`): дефолт CLI рухається з апдейтами, а Astra рев'юїть не краще й палить у рази більше токенів; `--model` лише для свідомого винятку, новий Sol — бамп константи.`
- [ ] **Step 2: AGENTS.md.** In the cross-review bullet, after the design link, add: `When editing the script, keep the codex direction pinned to a Sol-class model (`DEFAULT_MODEL` in `scripts/cross-review/core.ts`): the Codex CLI default moves with updates, and Astra costs far more tokens for no better review.`
- [ ] **Step 3: 09-29 design.** Replace the line "If it is omitted, the CLI's own default is used, and the code carries no curated model list." with: "If it is omitted, the CLI's own default is used — except for codex, which is pinned to a Sol model since 2026-10-01 (`2026-10-01-cross-review-sol-default-design.md`)."
- [ ] **Step 4: Full gate.** Run `npm test && npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md
git commit -m "docs: cross-review codex direction is pinned to Sol"
```
