# #509 — prompt and guard judge by one scope; a refuted route keeps its class

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the triage job from discarding a row's classification when the routing guard refutes only its target, and make the model read the same scope the guard enforces.

**Architecture:** `parseScopeBlock` moves above the LLM call so one parsed scope feeds both consumers. The prompt renders that scope explicitly (instead of hoping the block survives a 2000-char body slice) and is shown only targets that can accept a row. When the guard still refuses a routing, the verdict keeps its class with `issue_number = null` and records why, exactly as the neighbouring `unprobed_absence` branch already does. A standing `triage-inbox` issue reports the resulting ownerless rows, grouped by refused target.

**Tech Stack:** TypeScript, Node 24, Vitest, better-sqlite3, GitHub REST via plain `fetch`.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-26-triage-scope-divergence-design.md`

## Global Constraints

- Functional style, modular files; secrets only from `.env` (CLAUDE.md).
- **Every test must be mutation-proved**: delete the implementing line, run the test, watch it fail, restore. A test that stays green when the code is gone is a plan failure, not a test. State the mutation result in the commit body.
- `review_note` is capped at 500 characters by `VerdictSchema`; machine-readable note prefixes are **English** (`off-scope …`), matching the existing `no absence evidence: …`.
- The inbox issue must **never** carry the `orphan-triage` label — that label is the model's routing-target list.
- `enrich_failures.issue_number` is the key of the #421 lock. Nothing in this plan may set it to a value that is not a real issue owning a real fix.
- Do not re-route a refused verdict to a different issue.
- Run `npm test` and `npm run typecheck` before every commit.
- **Worktree guard (per-task, mandatory):** before the first `git` write, run `git rev-parse --show-toplevel && git branch --show-current` and confirm you are in the worktree for this feature, not `/home/ysi/warsaw-beer-bot` on `main`. Verify after committing that the commit landed on the feature branch.

---

### Task 1: Scope predicates — routability and a rejection reason

**Files:**
- Modify: `src/domain/triage-scope.ts`
- Test: `src/domain/triage-scope.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; `Scope`, `ScopeTerm`, `termMatches`, `describeTerm` already exist in this file).
- Produces:
  - `isRoutableTarget<T extends { scope: Scope | null }>(i: T): i is T & { scope: Scope }`
  - `explainScopeRejection(row: UntriagedFailure, verdictClass: (typeof REVIEW_CLASSES)[number], scope: Scope): string`
  - `describeTerm` becomes exported (it is currently module-private).

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/triage-scope.test.ts`:

```ts
import { isRoutableTarget, explainScopeRejection } from './triage-scope';

test('a cohort-only scope can never accept a new row, so it is not a routable target', () => {
  expect(isRoutableTarget({ scope: { beer_ids: [1, 2], where: [] } })).toBe(false);
});

test('a missing scope block is not a routable target', () => {
  expect(isRoutableTarget({ scope: null })).toBe(false);
});

test('a where-scope is routable, cohort or not', () => {
  const where = [{ col: 'candidates_count', op: '=', value: 0 } as const];
  expect(isRoutableTarget({ scope: { beer_ids: [], where } })).toBe(true);
  expect(isRoutableTarget({ scope: { beer_ids: [7], where } })).toBe(true);
});

test('the rejection reason names the first term the row contradicts', () => {
  const scope: Scope = {
    beer_ids: [],
    where: [
      { col: 'source_url', op: 'contains', value: 'flasker' },
      { col: 'candidates_count', op: '=', value: 0 },
    ],
  };
  // the row matches term 1 (its source_url is a flasker URL) and fails term 2
  expect(explainScopeRejection(row({ candidates_count: 3 }), 'matcher_bug', scope))
    .toBe('candidates_count = 0');
});

test('the rejection reason for a cohort-only scope says the row is outside the cohort', () => {
  expect(explainScopeRejection(row({ beer_id: 99 }), 'matcher_bug', { beer_ids: [1], where: [] }))
    .toBe('outside the cohort');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/triage-scope.test.ts`
Expected: FAIL — `isRoutableTarget is not a function`.

- [ ] **Step 3: Implement**

In `src/domain/triage-scope.ts`, export `describeTerm` (change `function describeTerm` to `export function describeTerm`) and add below `rowSatisfiesScope`:

```ts
// #509: a target the guard will refuse by construction must not be offered to the model as
// one. `where.length === 0` is the whole test: rowSatisfiesScope returns false for every row
// outside an enumerated cohort when there is no `where` to fall back on, so a cohort-only
// scope — and a missing block — can accept nothing that is not already listed. A type
// predicate rather than a boolean so the prompt input cannot be built from unfiltered issues.
//
// Deliberately NOT also checking isLegalScope: legality is a rule about issue CREATION (a
// `where` of review_class alone is a dumping ground), while this is a rule about whether an
// existing target can accept anything at all. Conflating them would silently hide legacy
// issues from the model instead of letting the guard judge them.
export function isRoutableTarget<T extends { scope: Scope | null }>(
  i: T,
): i is T & { scope: Scope } {
  return i.scope !== null && i.scope.where.length > 0;
}

// #509: the same decision rowSatisfiesScope makes, with the reason attached, so a refused
// routing can leave a trace a human can act on. Returns the FIRST failing term rather than
// all of them: the note is capped at 500 chars and shares that budget with the model's own
// sentence, and one contradicted term is already enough to explain the refusal.
export function explainScopeRejection(
  row: UntriagedFailure,
  verdictClass: (typeof REVIEW_CLASSES)[number],
  scope: Scope,
): string {
  if (scope.where.length === 0) return 'outside the cohort';
  const failing = scope.where.find((t) => !termMatches(row, verdictClass, t));
  return failing ? describeTerm(failing) : 'outside the cohort';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/triage-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-prove both**

Change `i.scope.where.length > 0` to `true`, run the tests — the first two must fail. Restore.
Change `explainScopeRejection`'s `find` to `scope.where[0]`, run — the first-failing-term test must fail (it would report `source_url contains flasker`, a term the row satisfies). Restore.

- [ ] **Step 6: Commit**

```bash
git add src/domain/triage-scope.ts src/domain/triage-scope.test.ts
git commit -m "feat(#509): scope routability predicate and rejection reason"
```

---

### Task 2: One parsed scope for both the prompt and the guard

**Files:**
- Modify: `src/domain/triage-analysis.ts` (`TriageInput`, `buildTriagePrompt` around lines 62-68 and 188-192)
- Modify: `src/jobs/orphan-triage.ts` (the `llm.analyze` call at ~293 and `scopedIssues` at ~352)
- Test: `src/domain/triage-analysis.test.ts`, `src/jobs/orphan-triage.test.ts`

**Interfaces:**
- Consumes: `isRoutableTarget` (Task 1); existing `parseScopeBlock`, `renderScopeBlock`, `stripScopeBlocks`.
- Produces: `TriageInput.openIssues: ScopedOpenIssue[]` where
  `export type ScopedOpenIssue = OpenIssue & { scope: Scope };` — exported from `triage-analysis.ts`.
  Note the **non-nullable** `scope`: the type is what forces the filter to happen before the call.

This task changes a type and its only call site together on purpose — split across two commits the repo would not compile.

- [ ] **Step 1: Write the failing tests**

In `src/domain/triage-analysis.test.ts`:

```ts
import { buildTriagePrompt, type ScopedOpenIssue } from './triage-analysis';
import { parseScopeBlock } from './triage-scope';

const scopedIssue = (over: Partial<ScopedOpenIssue> = {}): ScopedOpenIssue => ({
  number: 405, title: 'Shop brewery field is not a brewery', body: 'body',
  labels: ['orphan-triage'], createdAt: '2026-01-01T00:00:00.000Z',
  scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '=', value: 0 }] },
  ...over,
});

test('the scope the model is shown parses back into the scope the guard enforces', () => {
  const issue = scopedIssue();
  const prompt = buildTriagePrompt({ orphans: [], openIssues: [issue] });
  expect(parseScopeBlock(prompt)).toEqual(issue.scope);
});

// The regression this whole change exists to stop: renderScopeBlock appends the block at
// the END of the body, so a long body used to push it past ISSUE_BODY_CAP and the model
// saw no constraint at all. Binds the BEHAVIOUR, not the constant — raising the cap must
// not be a way to make this pass.
test('an issue with a body far longer than the prompt cap still shows its scope', () => {
  const long = 'x'.repeat(5000);
  const issue = scopedIssue({ body: long });
  const prompt = buildTriagePrompt({ orphans: [], openIssues: [issue] });
  expect(parseScopeBlock(prompt)).toEqual(issue.scope);
});

test('a scope fence inside the model-authored body is stripped, so exactly one scope is shown', () => {
  const issue = scopedIssue({
    body: 'prose\n\n```triage-scope\n{"beer_ids":[999],"where":[]}\n```\nmore prose',
  });
  const prompt = buildTriagePrompt({ orphans: [], openIssues: [issue] });
  expect(prompt).not.toContain('999');
  expect(parseScopeBlock(prompt)).toEqual(issue.scope);
});
```

In `src/jobs/orphan-triage.test.ts`:

```ts
test('a target the guard would always refuse is not offered to the model, but the guard still sees it', async () => {
  const d = db();
  [1, 2].forEach((n) => seedOrphan(d, n));
  const COHORT_ONLY = 'b\n\n```triage-scope\n{"beer_ids":[1,2],"where":[]}\n```';
  const WHERE_SCOPED = 'b\n\n```triage-scope\n{"beer_ids":[],"where":[{"col":"candidates_count","op":"=","value":0}]}\n```';
  const github = gh({
    listOpenIssues: vi.fn().mockResolvedValue([
      { number: 300, title: 'cohort only', body: COHORT_ONLY, labels: [], createdAt: '2026-01-01T00:00:00.000Z' },
      { number: 301, title: 'unscoped', body: 'no block here', labels: [], createdAt: '2026-01-01T00:00:00.000Z' },
      { number: 302, title: 'where scoped', body: WHERE_SCOPED, labels: [], createdAt: '2026-01-01T00:00:00.000Z' },
    ]),
  });
  // The model routes beer 2 to the cohort-only issue anyway — it can only do that if the
  // guard is still judging against the full set, which is what the second assertion checks.
  const analysis: Analysis = {
    verdicts: [
      { beer_id: 1, review_class: 'matcher_bug', review_note: 'n', issue_number: 302, new_issue_key: null },
      { beer_id: 2, review_class: 'matcher_bug', review_note: 'n', issue_number: 300, new_issue_key: null },
    ],
    new_issues: [],
  };
  const model = llm(analysis);
  await orphanTriage({ db: d, log, llm: model, github, now: inWindow });

  expect(model.analyze.mock.calls[0][0].openIssues.map((i: { number: number }) => i.number)).toEqual([302]);
  const outcome = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line;
  expect(outcome).toContain('поза scope');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/triage-analysis.test.ts src/jobs/orphan-triage.test.ts`
Expected: FAIL — the prompt tests fail because `parseScopeBlock(prompt)` returns `null` for the 5000-char body; the job test fails because all three issues are passed to `analyze`.

- [ ] **Step 3: Implement the type and the prompt**

In `src/domain/triage-analysis.ts`, add the type and change `TriageInput`:

```ts
import { ScopeSchema, SCOPE_COLS, SCOPE_OPS, renderScopeBlock, stripScopeBlocks, type Scope } from './triage-scope';

// #509: an open issue as the PROMPT needs it — with its scope already parsed. The field is
// non-nullable on purpose: the only way to build one is to filter with isRoutableTarget, so
// an issue the guard would always refuse cannot reach the model by accident.
export type ScopedOpenIssue = OpenIssue & { scope: Scope };

export interface TriageInput {
  orphans: UntriagedFailure[];
  openIssues: ScopedOpenIssue[];
  probes?: Map<number, TriageProbe>;
}
```

Replace the `issues` construction (currently line ~189):

```ts
  // #509: the scope is rendered from the PARSED structure and placed before the body, not
  // left to survive the body slice. renderScopeBlock is the same function that wrote the
  // block into the issue, so what the model reads round-trips through parseScopeBlock into
  // exactly what the guard will enforce. Any fence in the model-authored body is stripped
  // first, so there is one scope on screen rather than two competing ones.
  const issues = input.openIssues.slice(0, MAX_OPEN_ISSUES).map((i) =>
    `#${i.number} [${i.labels.join(', ')}] ${i.title}\n`
    + `Scope (enforced — a row contradicting this can never be attached):\n`
    + `${renderScopeBlock(i.scope)}\n`
    + `${stripScopeBlocks(i.body).slice(0, ISSUE_BODY_CAP)}`,
  ).join('\n---\n') || '(none)';
```

- [ ] **Step 4: Implement the call site**

In `src/jobs/orphan-triage.ts`, import `isRoutableTarget` from `../domain/triage-scope`, and replace the analyze call and the later `scopedIssues` build:

```ts
      // #509: parse ONCE, above the call. This is the whole structural fix — scope used to
      // be parsed at line ~352, after the model had already answered, which is why the two
      // could never agree. `routable` is what the model may choose from; `scopedIssues`
      // below keeps the FULL set, because the guard must stay able to refuse an invented
      // number and reconcileSaturatedLabels must still clear a label off an issue the
      // prompt no longer shows.
      const parsed = openIssues.map((i) => ({ ...i, scope: parseScopeBlock(i.body) }));
      const routable = parsed.filter(isRoutableTarget);
      const ex1 = await llm.analyze({ orphans, openIssues: routable, probes });
```

and, at the former parse site:

```ts
      scopedIssues = parsed.map((i) => ({
        number: i.number,
        scope: i.scope,
        postCreationRows: countRowsForIssue(db, i.number, i.createdAt),
      }));
```

Note: the retry call at ~302 (`const ex2 = await llm.analyze(...)`) takes `routable` too. `parsed` must be declared before the first `analyze`, inside the same `try`.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS. Existing job tests keep passing: their default `SCOPED_BODY` stub is cohort-only and is therefore no longer offered to the model, but the guard still accepts routings to it because `scopedIssues` is unfiltered.

- [ ] **Step 6: Mutation-prove**

Change `openIssues: routable` back to `openIssues: parsed as ScopedOpenIssue[]` — the job test must fail. Restore.
Change `scopedIssues = parsed.map(...)` to `scopedIssues = routable.map(...)` — the job test's `поза scope` assertion must fail (the guard would report a missing target, not a scope violation). Restore.
Delete the `renderScopeBlock(i.scope)` line from the prompt — all three prompt tests must fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/domain/triage-analysis.ts src/domain/triage-analysis.test.ts src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts
git commit -m "feat(#509): parse scope once, above the LLM call, and show it to the model"
```

---

### Task 3: A refused route keeps its class

**Files:**
- Modify: `src/domain/triage-plan.ts` (both `scope_violation` sites, ~247 and ~261; `TriagePlan`)
- Modify: `src/jobs/orphan-triage.ts` (`TriageOutcome`, `buildTriageLine`, the `plan.quiet` loop)
- Test: `src/domain/triage-plan.test.ts`, `src/jobs/orphan-triage.test.ts`

**Interfaces:**
- Consumes: `explainScopeRejection` (Task 1).
- Produces: `TriagePlan.quietOffScope: number`; `TriageOutcome.offScope: number`.

- [ ] **Step 1: Write the failing tests**

In `src/domain/triage-plan.test.ts`:

```ts
test('a verdict refused by scope keeps its class, loses its target, and records the reason', () => {
  const scope = { beer_ids: [], where: [{ col: 'candidates_count', op: '=', value: 0 } as const] };
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, issue_number: 300, review_note: 'shop brand in brewery field' })],
    new_issues: [],
  };
  const plan = planTriageActions(
    a, [open(300, { scope })], [row(1, { candidates_count: 3 })], noProbes, new Set(),
  );
  expect(plan.comments).toEqual([]);
  expect(plan.skipped).toBe(0);
  expect(plan.guardHits.scope_violation).toBe(1);
  expect(plan.quietOffScope).toBe(1);
  expect(plan.quiet).toHaveLength(1);
  expect(plan.quiet[0].review_class).toBe('matcher_bug');
  expect(plan.quiet[0].issue_number).toBeNull();
  expect(plan.quiet[0].review_note).toBe('off-scope #300: candidates_count = 0');
});

test('a founding verdict refused by its own proposed scope names the key, not a number', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, new_issue_key: 'cider-brand-line' })],
    new_issues: [{
      key: 'cider-brand-line', title: 't', body: 'b', labels: [],
      scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '=', value: 0 }] },
    }],
  };
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 3 })], noProbes, new Set());
  expect(plan.newIssues).toEqual([]);
  expect(plan.quiet[0].review_note).toBe('off-scope cider-brand-line: candidates_count = 0');
  expect(plan.quiet[0].new_issue_key).toBeNull();
});

// Red if the note is built by concatenation without a cap: VerdictSchema caps review_note
// at 500 and setEnrichFailureReview writes whatever it is handed.
test('the off-scope note is capped at 500 characters', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, issue_number: 300, review_note: 'z'.repeat(600) })],
    new_issues: [],
  };
  const scope = { beer_ids: [], where: [{ col: 'candidates_count', op: '=', value: 0 } as const] };
  const plan = planTriageActions(a, [open(300, { scope })], [row(1, { candidates_count: 3 })], noProbes, new Set());
  expect(plan.quiet[0].review_note.length).toBeLessThanOrEqual(500);
});
```

In `src/jobs/orphan-triage.test.ts`:

```ts
test('a scope-refused row leaves the run with a class and no issue, so it is not locked', async () => {
  const d = db();
  seedOrphan(d, 1);
  const WHERE_SCOPED = 'b\n\n```triage-scope\n{"beer_ids":[],"where":[{"col":"candidates_count","op":">","value":0}]}\n```';
  const github = gh({
    listOpenIssues: vi.fn().mockResolvedValue([
      { number: 300, title: 't', body: WHERE_SCOPED, labels: [], createdAt: '2026-01-01T00:00:00.000Z' },
    ]),
  });
  // seedOrphan writes candidates_count 0, so the row contradicts `candidates_count > 0`.
  const analysis: Analysis = {
    verdicts: [{ beer_id: 1, review_class: 'matcher_bug', review_note: 'n', issue_number: 300, new_issue_key: null }],
    new_issues: [],
  };
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });

  const r = d.prepare('SELECT review_class, issue_number, review_note FROM enrich_failures WHERE beer_id = 1').get() as
    { review_class: string; issue_number: number | null; review_note: string };
  expect(r.review_class).toBe('matcher_bug');
  expect(r.issue_number).toBeNull();
  expect(r.review_note).toContain('off-scope #300:');
  expect(github.commentOnIssue).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/triage-plan.test.ts src/jobs/orphan-triage.test.ts`
Expected: FAIL — `plan.quietOffScope` is undefined; the job test finds `review_class` null.

- [ ] **Step 3: Implement the plan change**

In `src/domain/triage-plan.ts`, import `explainScopeRejection`, add `quietOffScope: number` to `TriagePlan` (with a comment: *"#509: refused routing, class kept — a fourth way an actionable class ends with no issue, counted where it is decided like the other three"*), initialise `let quietOffScope = 0;` beside `quietNoTarget`, and return it.

Add a local helper above the loop:

```ts
  // #509: a scope violation refutes the TARGET, not the class. The verdict goes quiet with
  // its class intact and a trace of what refused it, exactly as the unprobed_absence branch
  // above does. It is deliberately NOT re-routed to another issue: choosing a different
  // target by title similarity is what built #347, and the guard exists to stop it.
  const refuseRoute = (verdict: Verdict, row: UntriagedFailure, target: string, scope: Scope): void => {
    guardHits.scope_violation += 1;
    quietOffScope += 1;
    quiet.push({
      ...verdict,
      issue_number: null,
      new_issue_key: null,
      review_note: `off-scope ${target}: ${explainScopeRejection(row, verdict.review_class, scope)}`
        .slice(0, 500),
    });
  };
```

Replace the existing-issue site:

```ts
      if (target.scope === null || !rowSatisfiesScope(row, verdict.review_class, target.scope)) {
        refuseRoute(verdict, row, `#${verdict.issue_number}`, target.scope ?? { beer_ids: [], where: [] });
        continue;
      }
```

and the proposed-issue site:

```ts
      if (!rowSatisfiesScope(row, verdict.review_class, proposed.scope)) {
        refuseRoute(verdict, row, verdict.new_issue_key!, proposed.scope);
        continue;
      }
```

Note both sites no longer touch `skipped`.

- [ ] **Step 4: Implement the outcome and digest**

In `src/jobs/orphan-triage.ts`: add `offScope: number;` to `TriageOutcome` (initialised `0` in `empty`), set `outcome.offScope = plan.quietOffScope;` beside `outcome.causeStripped`, and in `buildTriageLine` add, after the `causeStripped` part:

```ts
  if (o.offScope > 0) parts.push(`${o.offScope} без власника (поза scope)`);
```

Leave the existing `${o.guardHits.scope_violation} поза scope` part as it is — it counts the guard firing; this new one counts what was recorded because of it.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS. Existing tests that asserted a scope violation raised `skipped` must be updated to assert `quietOffScope` instead — this is a deliberate behaviour change, not a broken test; note each edit in the commit body.

- [ ] **Step 6: Mutation-prove**

Delete the `quiet.push({...})` from `refuseRoute` — the plan test and the job test must both fail. Restore.
Change `issue_number: null` to `issue_number: verdict.issue_number` — the job test's `issue_number` assertion must fail. Restore. (This one matters most: it is the difference between a recorded row and a row locked out of both pools.)

- [ ] **Step 7: Commit**

```bash
git add src/domain/triage-plan.ts src/domain/triage-plan.test.ts src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts
git commit -m "feat(#509): a scope-refused verdict keeps its class and records why"
```

---

### Task 4: `setIssueBody` on the GitHub client

**Files:**
- Modify: `src/infra/github-issues.ts`
- Test: `src/infra/github-issues.test.ts`

**Interfaces:**
- Produces: `GithubIssuesClient.setIssueBody(issueNumber: number, body: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Follow the existing fetch-stub style in `src/infra/github-issues.test.ts`:

```ts
test('setIssueBody PATCHes only the body', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
  const c = createGithubIssuesClient({ token: 't', repo: 'o/r', fetchImpl: fetchImpl as unknown as typeof fetch });
  await c.setIssueBody(42, 'new body');
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://api.github.com/repos/o/r/issues/42');
  expect(init.method).toBe('PATCH');
  expect(JSON.parse(init.body)).toEqual({ body: 'new body' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/infra/github-issues.test.ts`
Expected: FAIL — `c.setIssueBody is not a function`.

- [ ] **Step 3: Implement**

Add to the `GithubIssuesClient` interface:

```ts
  // #509: PATCH with ONLY `body`. The issues endpoint replaces every field it is given, so
  // sending title or labels here would overwrite whatever a human has since set — the same
  // hazard the addLabel/removeLabel comment above describes for PUT .../labels.
  setIssueBody(issueNumber: number, body: string): Promise<void>;
```

and implement it in `createGithubIssuesClient` beside `commentOnIssue`, reusing the module's
existing `call` helper (which is what carries the auth headers and the error handling):

```ts
    async setIssueBody(issueNumber, body) {
      await call(`${base}/issues/${issueNumber}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/infra/github-issues.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-prove**

Add `title: 'x'` to the PATCH payload — the test must fail on the `toEqual`. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/infra/github-issues.ts src/infra/github-issues.test.ts
git commit -m "feat(#509): setIssueBody on the GitHub issues client"
```

---

### Task 5: The ownerless query and the inbox body

**Files:**
- Create: `src/domain/triage-inbox.ts`
- Create: `src/domain/triage-inbox.test.ts`
- Modify: `src/storage/enrich_failures.ts`
- Test: `src/storage/enrich_failures.test.ts`

**Interfaces:**
- Produces:
  - `listOwnerlessRows(db: DB): OwnerlessRow[]` and `countOwnerlessRows(db: DB): number` in `src/storage/enrich_failures.ts`
  - `export interface OwnerlessRow { beer_id: number; brewery: string; name: string; review_class: string; review_note: string | null; }`
  - `groupOwnerless(rows: OwnerlessRow[]): InboxGroup[]` and `buildInboxBody(groups: InboxGroup[], totalOwnerless: number, dateKey: string): string` in `src/domain/triage-inbox.ts`
  - `export interface InboxGroup { key: string; reason: string; rows: OwnerlessRow[]; }`
  - `export const MAX_INBOX_GROUPS = 10; export const MAX_INBOX_ROWS_PER_GROUP = 15;`

- [ ] **Step 1: Write the failing storage test**

In `src/storage/enrich_failures.test.ts`:

```ts
test('listOwnerlessRows returns only actionable classes with no issue and a machine-readable reason', () => {
  const d = db();
  const seed = (id: number, note: string | null, cls: string, issue: number | null) => {
    recordEnrichFailure(d, {
      beer_id: id, brewery: `B${id}`, name: `N${id}`, search_url: 'u', source_url: '',
      outcome: 'not_found', candidates_count: 0, candidates_summary: '', at: '2026-08-26T00:00:00Z',
    });
    d.prepare('UPDATE enrich_failures SET review_class=?, review_note=?, issue_number=? WHERE beer_id=?')
      .run(cls, note, issue, id);
  };
  seed(1, 'off-scope #300: candidates_count = 0', 'matcher_bug', null);   // in
  seed(2, 'no absence evidence: probably absent', 'matcher_bug', null);   // in
  seed(3, 'free prose from the model', 'matcher_bug', null);              // out — #508
  seed(4, 'off-scope #300: candidates_count = 0', 'matcher_bug', 300);    // out — has an owner
  seed(5, 'off-scope #300: candidates_count = 0', 'not_on_untappd', null);// out — not actionable

  expect(listOwnerlessRows(d).map((r) => r.beer_id)).toEqual([1, 2]);
  expect(countOwnerlessRows(d)).toBe(3);  // every actionable ownerless row, prose included
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/storage/enrich_failures.test.ts`
Expected: FAIL — `listOwnerlessRows is not exported`.

- [ ] **Step 3: Implement the queries**

In `src/storage/enrich_failures.ts`:

```ts
export interface OwnerlessRow {
  beer_id: number; brewery: string; name: string;
  review_class: string; review_note: string | null;
}

// #509: rows the triage inbox can group — an actionable class, no owning issue, and a note
// whose prefix a query can key on. The prose-note rows are deliberately excluded: 218 of
// them exist and none can be grouped, so listing them would rebuild the #347 dump in report
// form. They are #508's population, and countOwnerlessRows below still reports their total.
export function listOwnerlessRows(db: DB): OwnerlessRow[] {
  return db.prepare(
    `SELECT beer_id, brewery, name, review_class, review_note
       FROM enrich_failures
      WHERE review_class IN ('matcher_bug', 'parser_bug')
        AND issue_number IS NULL
        AND retired_at IS NULL
        AND (review_note LIKE 'off-scope %' OR review_note LIKE 'no absence evidence:%')
      ORDER BY beer_id`,
  ).all() as OwnerlessRow[];
}

// Every actionable ownerless row, groupable or not — the header number that says how big
// the pile really is.
export function countOwnerlessRows(db: DB): number {
  const r = db.prepare(
    `SELECT COUNT(*) AS n FROM enrich_failures
      WHERE review_class IN ('matcher_bug', 'parser_bug')
        AND issue_number IS NULL AND retired_at IS NULL`,
  ).get() as { n: number };
  return r.n;
}
```

- [ ] **Step 4: Write the failing domain test**

Create `src/domain/triage-inbox.test.ts`:

```ts
import { groupOwnerless, buildInboxBody, MAX_INBOX_ROWS_PER_GROUP } from './triage-inbox';
import type { OwnerlessRow } from '../storage/enrich_failures';

const r = (id: number, note: string): OwnerlessRow =>
  ({ beer_id: id, brewery: `B${id}`, name: `N${id}`, review_class: 'matcher_bug', review_note: note });

test('groups by the refused target, because that is the mechanism the model named', () => {
  const groups = groupOwnerless([
    r(1, 'off-scope #485: outside the cohort'),
    r(2, 'off-scope #485: outside the cohort'),
    r(3, 'off-scope cider-brand-line: candidates_count = 0'),
    r(4, 'no absence evidence: looks absent'),
  ]);
  expect(groups.map((g) => [g.key, g.rows.length])).toEqual([
    ['#485', 2], ['cider-brand-line', 1], ['absence not probed', 1],
  ]);
  expect(groups[0].reason).toBe('outside the cohort');
});

test('a group lists at most MAX_INBOX_ROWS_PER_GROUP rows and reports the remainder', () => {
  const many = Array.from({ length: MAX_INBOX_ROWS_PER_GROUP + 4 },
    (_, i) => r(i + 1, 'off-scope #485: outside the cohort'));
  const body = buildInboxBody(groupOwnerless(many), 250, '2026-08-27');
  expect(body).toContain(`ще 4`);
  expect(body.match(/^ {2}\d+ /gm)!.length).toBe(MAX_INBOX_ROWS_PER_GROUP);
});

test('the header reports the whole ownerless pile, not just the groupable part', () => {
  const body = buildInboxBody(groupOwnerless([r(1, 'off-scope #485: outside the cohort')]), 250, '2026-08-27');
  expect(body).toContain('250');
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run src/domain/triage-inbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the grouping and body**

Create `src/domain/triage-inbox.ts`:

```ts
import type { OwnerlessRow } from '../storage/enrich_failures';

export const MAX_INBOX_GROUPS = 10;
export const MAX_INBOX_ROWS_PER_GROUP = 15;

export interface InboxGroup { key: string; reason: string; rows: OwnerlessRow[]; }

const OFF_SCOPE = /^off-scope (\S+): (.*)$/;
const ABSENCE_KEY = 'absence not probed';

// #509: the refused target IS the mechanism label. The model already said "these are
// ciders, they belong to #485"; the scope refused the routing, but the meaning survived,
// so grouping on it costs nothing and produces clusters a human can act on directly.
export function groupOwnerless(rows: OwnerlessRow[]): InboxGroup[] {
  const by = new Map<string, InboxGroup>();
  for (const r of rows) {
    const m = OFF_SCOPE.exec(r.review_note ?? '');
    const key = m ? m[1] : ABSENCE_KEY;
    const reason = m ? m[2] : 'absence was never probed';
    const g = by.get(key) ?? { key, reason, rows: [] };
    g.rows.push(r);
    by.set(key, g);
  }
  // Sorted by size: the biggest cluster is the most likely to be one real mechanism, and
  // the cap below has to drop something, so it should drop the smallest.
  return [...by.values()].sort((a, b) => b.rows.length - a.rows.length).slice(0, MAX_INBOX_GROUPS);
}

export function buildInboxBody(
  groups: InboxGroup[], totalOwnerless: number, dateKey: string,
): string {
  const groupable = groups.reduce((n, g) => n + g.rows.length, 0);
  const head = [
    `Оновлено автоматично: ${dateKey}. Не редагуй тіло — воно перезаписується щодня.`,
    '',
    `Рядків з класом і без issue: **${totalOwnerless}** (з них ${groupable} з машинною причиною; `
    + `решта — вільні нотатки моделі, вони належать #508).`,
    '',
  ];
  const body = groups.flatMap((g) => {
    // Exactly two leading spaces before the beer id: the inbox is read by a human in a
    // browser, and the indent is what keeps a 15-row group scannable.
    const listed = g.rows.slice(0, MAX_INBOX_ROWS_PER_GROUP)
      .map((r) => `  ${r.beer_id} ${r.brewery} / ${r.name}`);
    const rest = g.rows.length - listed.length;
    return [
      `## ${g.key} — ${g.rows.length} рядків`,
      `причина відмови: ${g.reason}`,
      ...listed,
      ...(rest > 0 ? [`  ще ${rest}`] : []),
      '',
    ];
  });
  return [
    ...head, ...body,
    'Закрий це issue, коли розгребеш — наступний ран заведе свіже з того, що лишилось.',
  ].join('\n');
}
```

Note the `ще ${rest}` line also starts with two spaces, so the second test's
`/^ {2}\d+ /gm` regex — which requires a digit immediately after the indent — does not
count it. That is deliberate: the test counts listed rows, not lines.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/domain/triage-inbox.test.ts src/storage/enrich_failures.test.ts`
Expected: PASS.

- [ ] **Step 8: Mutation-prove**

Drop the `review_note LIKE` clause from `listOwnerlessRows` — the storage test must fail (beer 3 appears). Restore.
Change the group cap to `rows` (uncapped) — the remainder test must fail. Restore.

- [ ] **Step 9: Commit**

```bash
git add src/domain/triage-inbox.ts src/domain/triage-inbox.test.ts src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts
git commit -m "feat(#509): ownerless-row query and triage inbox body"
```

---

### Task 6: Wire the inbox into the run

**Files:**
- Modify: `src/jobs/orphan-triage.ts`
- Test: `src/jobs/orphan-triage.test.ts`

**Interfaces:**
- Consumes: `setIssueBody` (Task 4), `listOwnerlessRows` / `countOwnerlessRows` / `groupOwnerless` / `buildInboxBody` (Task 5).
- Produces: `export const INBOX_LABEL = 'triage-inbox';`

- [ ] **Step 1: Write the failing tests**

```ts
test('the inbox issue is created without the routing label, so it can never become a target', async () => {
  const d = db();
  seedOrphan(d, 1);
  setEnrichFailureReview(d, 1, 'matcher_bug', 'off-scope #300: candidates_count = 0', '2026-08-26T00:00:00Z', null);
  const github = gh({
    listOpenIssues: vi.fn().mockResolvedValue([]),
    createIssue: vi.fn().mockResolvedValue(600),
  });
  await orphanTriage({
    db: d, log, github, now: inWindow,
    llm: llm({ verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'n', issue_number: null, new_issue_key: null }], new_issues: [] }),
  });
  const created = github.createIssue.mock.calls.at(-1)![0];
  expect(created.labels).toEqual([INBOX_LABEL]);
  expect(created.labels).not.toContain(TRIAGE_LABEL);
  expect(created.body).toContain('#300');
});

test('an existing open inbox is rewritten, not duplicated', async () => {
  const d = db();
  seedOrphan(d, 1);
  setEnrichFailureReview(d, 1, 'matcher_bug', 'off-scope #300: candidates_count = 0', '2026-08-26T00:00:00Z', null);
  const github = gh({
    listOpenIssues: vi.fn(async (label: string) => (label === INBOX_LABEL
      ? [{ number: 600, title: 'inbox', body: 'old', labels: [INBOX_LABEL], createdAt: '2026-08-01T00:00:00.000Z' }]
      : [])),
    setIssueBody: vi.fn().mockResolvedValue(undefined),
  });
  await orphanTriage({
    db: d, log, github, now: inWindow,
    llm: llm({ verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'n', issue_number: null, new_issue_key: null }], new_issues: [] }),
  });
  expect(github.createIssue).not.toHaveBeenCalled();
  expect(github.setIssueBody).toHaveBeenCalledWith(600, expect.stringContaining('#300'));
});

test('an inbox failure does not cost the run its verdicts', async () => {
  const d = db();
  seedOrphan(d, 1);
  const github = gh({
    listOpenIssues: vi.fn(async (label: string) => {
      if (label === INBOX_LABEL) throw new Error('github down');
      return [];
    }),
  });
  await orphanTriage({
    db: d, log, github, now: inWindow,
    llm: llm({ verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'n', issue_number: null, new_issue_key: null }], new_issues: [] }),
  });
  const r = d.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = 1').get() as { review_class: string };
  expect(r.review_class).toBe('unidentifiable');
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
});
```

Update the shared `gh()` stub to include `setIssueBody: vi.fn().mockResolvedValue(undefined)` and to make `listOpenIssues` label-aware (returning `[]` for `INBOX_LABEL`) so existing tests keep passing.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/jobs/orphan-triage.test.ts`
Expected: FAIL — `INBOX_LABEL` is not exported, no inbox call is made.

- [ ] **Step 3: Implement**

Add `export const INBOX_LABEL = 'triage-inbox';` beside `TRIAGE_LABEL`, and a function:

```ts
// #509: the inbox is a REPORT, not an owner. `enrich_failures.issue_number` is the key of
// the #421 lock, so linking these rows to a standing issue would seal them out of both
// pools forever (June 2026 sealed 157 rows exactly that way). The link is one-directional,
// DB → issue body, and the rows keep issue_number NULL.
//
// Best-effort by design, and called AFTER every DB write and every GitHub write the run
// owes: a failure here must never cost a verdict that was already earned. Same contract as
// reconcileSaturatedLabels directly above.
async function publishTriageInbox(
  db: DB, log: pino.Logger, github: GithubIssuesClient, dateKey: string,
): Promise<void> {
  try {
    const groups = groupOwnerless(listOwnerlessRows(db));
    const body = buildInboxBody(groups, countOwnerlessRows(db), dateKey);
    const open = await github.listOpenIssues(INBOX_LABEL);
    if (open.length > 1) {
      log.warn({ numbers: open.map((i) => i.number) }, 'orphan-triage: more than one open triage inbox');
    }
    // Newest wins: a duplicate means a human opened one, and the newest is the one they are
    // most likely looking at.
    const target = open.length > 0 ? open.reduce((a, b) => (a.number > b.number ? a : b)) : null;
    if (target) await github.setIssueBody(target.number, body);
    // The routing label is deliberately absent: an inbox wearing `orphan-triage` would join
    // listOpenIssues(TRIAGE_LABEL) and become a target the model can route rows into.
    else await github.createIssue({ title: 'Тріаж-інбокс: рядки без власника', body, labels: [INBOX_LABEL] });
  } catch (err) {
    log.warn({ err }, 'orphan-triage: inbox publish failed');
  }
}
```

Call it immediately after `await reconcileSaturatedLabels(...)`, before `finish(outcome)`:

```ts
    await publishTriageInbox(db, log, github, dateKey);
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Mutation-prove**

Change the created labels to `[INBOX_LABEL, TRIAGE_LABEL]` — the first test must fail. Restore. (This is the invariant that keeps the inbox from becoming a magnet.)
Remove the `try/catch` — the third test must fail. Restore.

- [ ] **Step 6: Update `spec.md`**

`spec.md` is the OpenSpec source of truth (CLAUDE.md). Add the inbox issue and the off-scope recording to the orphan-triage section; describe them as behaviour, not implementation. No `docs/extension-install-uk.md` change is needed — nothing here touches `extension/**`.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts spec.md
git commit -m "feat(#509): publish the triage inbox as a report, never as an owner"
```

---

## After the tasks

- [ ] Open the PR against `main`, referencing #509 and the spec path.
- [ ] Wait for the AI review, verify each comment, push back on wrong ones (`feedback_pr_review_loop`). Green tests are not done.
- [ ] Do **not** merge. Report "ready to merge" and let the user merge.
- [ ] After the user merges: sync `main` in the MAIN checkout, deploy with `bash deploy/deploy.sh`, and file the dated checkpoint issue in the style of #480/#488 to check the four predictions in the spec one week later.
