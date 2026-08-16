# #432 Triage Run Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a triage run able to explain its own outcome — `guardHits` printed on every run, a warning that fires only on anomalous guard activity, and the three quiet dispositions counted separately instead of as one overlapping sum.

**Architecture:** Three edits to two files. `planTriageActions` (a pure function) learns which verdicts had their cause stripped and returns two new disjoint counters; the job publishes `guardHits` in the outcome it already logs every run, narrows the warning to the two guards that mean a human is needed, and renders the new counters in the digest line. No DB schema change, no GitHub behaviour change, no change to what any row is classified as.

**Tech Stack:** TypeScript, Vitest, pino. Run tests with `npx vitest run <path>`; typecheck with `npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-16-432-triage-run-report-design.md`

## Global Constraints

- **This is a reporting change only.** No row may get a different `review_class`, a different `issue_number`, or a different GitHub destination than it does today. If a test asserting routing behaviour changes, the change is wrong.
- **No new thresholds.** The routine/anomalous split is by meaning, never by count.
- **`Verdict` must not gain a field.** It is `z.infer<typeof VerdictSchema>`, the model's own parsed output; a strip marker living there would be one schema edit away from being model-settable.
- **Control flow must never read `review_note` prose.** The `unverified: ` prefix stays for humans reading the column; nothing may branch on it.
- **Repo commit convention:** subject `feat(#432): …` or `test(#432): …`, and every commit message ends with the two trailer lines shown in Task 1 Step 5.
- **Worktree guard — run before your first commit:** `git rev-parse --show-toplevel` must print exactly `/home/ysi/warsaw-beer-bot/.claude/worktrees/worktree-432-triage-run-report` (NOT `/home/ysi/warsaw-beer-bot`) and `git branch --show-current` must print `worktree-432-triage-run-report`. If either is wrong, STOP and report — do not commit.

---

### Task 1: `planTriageActions` counts the two quiet dispositions

**Files:**
- Modify: `src/domain/triage-plan.ts` (the `TriagePlan` interface ~line 37; the signature ~line 93; the `!hasIssue && !hasKey` branch ~line 173; the `return` ~line 228)
- Test: `src/domain/triage-plan.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `planTriageActions(analysis, openIssues, batchRows, probes, strippedBeerIds)` — a fifth parameter of type `ReadonlySet<number>`. `TriagePlan` gains `quietCauseStripped: number` and `quietNoTarget: number`.

- [ ] **Step 1: Write the failing test**

Add to `src/domain/triage-plan.test.ts`. Note both verdicts are actionable with no target; the only thing separating them is set membership, and the notes are written so a prefix-sniffing implementation would still fail.

```ts
test('splits quiet actionable verdicts into cause-stripped and no-target', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, review_note: 'unverified: cause the gate stripped' }),
      v({ beer_id: 2, review_note: 'unverified: looks stripped but is not' }),
    ],
    new_issues: [],
  };
  const plan = planTriageActions(a, [], rows(1, 2), noProbes, new Set([1]));
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([1, 2]);
  expect(plan.quietCauseStripped).toBe(1);
  expect(plan.quietNoTarget).toBe(1);
});

test('a downgraded absence counts in neither quiet split', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, review_class: 'not_on_untappd' })],
    new_issues: [],
  };
  const plan = planTriageActions(a, [], rows(1), noProbes, new Set());
  expect(plan.guardHits.unprobed_absence).toBe(1);
  expect(plan.quietCauseStripped).toBe(0);
  expect(plan.quietNoTarget).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/triage-plan.test.ts -t 'quiet'`
Expected: FAIL — `Expected 5 arguments, but got 4` at typecheck, or `plan.quietCauseStripped` is `undefined`.

- [ ] **Step 3: Implement**

In `src/domain/triage-plan.ts`, add to the `TriagePlan` interface (after `skipped`):

```ts
  // #432: the three ways an actionable class ends up with no issue are counted where
  // each is decided, never as a sum. The third is guardHits.unprobed_absence. Deriving
  // any of them by subtraction can go negative — a stripped verdict may still be dropped
  // as a foreign row — and a report that can print a negative number is not a report.
  quietCauseStripped: number;     // #358 gate stripped the cause, row went quiet
  quietNoTarget: number;          // the model named neither an issue nor a key
```

Change the signature (keep the existing `#408` comment above it):

```ts
export function planTriageActions(
  analysis: Analysis,
  openIssues: ScopedIssue[],
  batchRows: UntriagedFailure[],
  probes: Map<number, TriageProbe>,
  // #432: beer ids whose cause the verification gate stripped before planning. Passed in
  // rather than marked on the Verdict: Verdict is the model's own parsed output, and a
  // marker there is one schema edit away from being model-settable, which would let a
  // model launder a stripped cause into a voluntary declination.
  strippedBeerIds: ReadonlySet<number>,
): TriagePlan {
```

Declare the counters next to `let skipped = 0;`:

```ts
  let quietCauseStripped = 0;
  let quietNoTarget = 0;
```

Replace the `!hasIssue && !hasKey` line (keep its existing comment):

```ts
    if (!hasIssue && !hasKey) {
      if (strippedBeerIds.has(verdict.beer_id)) quietCauseStripped += 1;
      else quietNoTarget += 1;
      quiet.push(verdict);
      continue;
    }
```

Add both to the returned object:

```ts
  return { newIssues, comments, quiet, skipped, guardHits, quietCauseStripped, quietNoTarget };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/triage-plan.test.ts`
Expected: PASS. Every pre-existing test in this file will fail to compile until their `planTriageActions(...)` calls get a fifth argument — add `new Set()` to each. That is a mechanical edit; do not change any assertion.

- [ ] **Step 5: Mutation-prove that the split reads the set, not the note**

Temporarily change the branch to `if (verdict.review_note.startsWith('unverified: ')) quietCauseStripped += 1;` and re-run `npx vitest run src/domain/triage-plan.test.ts`.
Expected: `splits quiet actionable verdicts into cause-stripped and no-target` goes RED — beer 2's note also starts with that prefix, so a prose-sniffing implementation reports 2 and 0. Revert and confirm green.

This is the point of writing beer 2's note as `'unverified: looks stripped but is not'`: without it, the wrong implementation would pass.

- [ ] **Step 6: Commit**

```bash
git rev-parse --show-toplevel   # /home/ysi/warsaw-beer-bot/.claude/worktrees/worktree-432-triage-run-report
git branch --show-current       # must be worktree-432-triage-run-report
git add src/domain/triage-plan.ts src/domain/triage-plan.test.ts
git commit -m "$(cat <<'EOF'
feat(#432): count the two quiet dispositions where they are decided

A stripped cause and a declined verdict both reach `quiet` as an actionable
class with no target. Only the call site knows which is which, so it passes
the stripped ids in; nothing branches on the `unverified: ` note prefix.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

---

### Task 2: `guardHits` reaches the outcome on every run

**Files:**
- Modify: `src/jobs/orphan-triage.ts` (the `TriageOutcome` interface ~line 59; the outcome initialiser ~line 166; the `verdict shortfall` block ~lines 298-306; the `planTriageActions` call ~line 266)
- Test: `src/jobs/orphan-triage.test.ts`

**Interfaces:**
- Consumes: `TriagePlan.quietCauseStripped`, `TriagePlan.quietNoTarget` and the fifth `strippedBeerIds` parameter from Task 1.
- Produces: `TriageOutcome` gains `guardHits: Record<GuardReason, number>`, `causeStripped: number`, `noTarget: number`; loses `recordedNoIssue`.

- [ ] **Step 1: Write the failing test**

Add to `src/jobs/orphan-triage.test.ts`. The regression is a *silence*, so this asserts presence in the all-zero case — exactly the 2026-08-16 shape, where today's code prints nothing.

`publish()` stores only `{ date, line }` in `TRIAGE_LAST_RESULT_KEY`, so the outcome is observable through `finish()`'s `log.info({ outcome, dateKey }, 'orphan-triage finished')`. The file's `log` is a real silent pino, so spy on it.

```ts
test('guardHits reaches the run outcome even when no guard fired', async () => {
  const d = db();
  seedOrphan(d, 1);
  const spy = vi.spyOn(log, 'info');
  const theLlm = llm({
    verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'x',
      issue_number: null, new_issue_key: null }],
    new_issues: [],
  });
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: expect.objectContaining({
        guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 0, unprobed_absence: 0 },
      }),
    }),
    'orphan-triage finished',
  );
  spy.mockRestore();
});

test('guardHits reaches the outcome when a guard fired and every row got a verdict', async () => {
  const d = db();
  seedOrphan(d, 1);
  const spy = vi.spyOn(log, 'info');
  // not_on_untappd with no probe evidence: guard 3 fires, covered === batch, so the old
  // `verdict shortfall` condition is false — this is the 2026-08-16 shape exactly.
  const theLlm = llm({
    verdicts: [{ beer_id: 1, review_class: 'not_on_untappd', review_note: 'absent',
      issue_number: null, new_issue_key: null }],
    new_issues: [],
  });
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: expect.objectContaining({
        guardHits: expect.objectContaining({ unprobed_absence: 1 }),
      }),
    }),
    'orphan-triage finished',
  );
  spy.mockRestore();
});

test('verdict shortfall still warns and no longer carries guardHits', async () => {
  const d = db();
  seedOrphan(d, 1);
  seedOrphan(d, 2);
  const spy = vi.spyOn(log, 'warn');
  const theLlm = llm({
    verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'x',
      issue_number: null, new_issue_key: null }],
    new_issues: [],
  });
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });
  // Exact object, not objectContaining: equality is what proves guardHits is gone.
  expect(spy).toHaveBeenCalledWith({ covered: 1, batch: 2 }, 'orphan-triage: verdict shortfall');
  spy.mockRestore();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/jobs/orphan-triage.test.ts -t 'guardHits reaches'`
Expected: FAIL — `guardHits` is `undefined` on the outcome.

- [ ] **Step 3: Implement**

In `src/jobs/orphan-triage.ts`, import the type:

```ts
import { planTriageActions, type ScopedIssue, type GuardReason } from '../domain/triage-plan';
```

Replace the `recordedNoIssue` field in `TriageOutcome` (delete it and its comment) with:

```ts
  // #432: the three disjoint ways an actionable class ends with no issue. Their sum used
  // to be published as `recordedNoIssue` alongside `unverified`, which is one of its own
  // parts — the digest read as 20 rows on a day that had 15.
  causeStripped: number;   // the #358 gate stripped the cause
  noTarget: number;        // the model named neither an issue nor a key
  // Guard tallies, logged every run. Previously reachable only through the `verdict
  // shortfall` warn, whose condition is counted BEFORE the guards run — so a refused row
  // still counts as covered and the guards could fire any number of times in silence.
  guardHits: Record<GuardReason, number>;
```

In the outcome initialiser (~line 166) replace `recordedNoIssue: 0,` with:

```ts
      causeStripped: 0, noTarget: 0,
      guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 0, unprobed_absence: 0 },
```

Pass the stripped ids into the planner. Immediately before the `verifyCauses` block (~line 226) declare the set, fill it inside the existing `.map` where `unverified += 1` happens, and pass it at the call:

```ts
      const strippedBeerIds = new Set<number>();
```

inside the map, next to `unverified += 1;`:

```ts
            strippedBeerIds.add(v.beer_id);
```

and at the call (~line 266):

```ts
      plan = planTriageActions(analysis, scopedIssues, orphans, probes, strippedBeerIds);
```

`strippedBeerIds` must be declared OUTSIDE the `if (deps.search)` block so the call site always has it; when there is no search it stays empty.

Replace the `verdict shortfall` block (~lines 298-306) with:

```ts
    if (covered < orphans.length) {
      // Its own meaning, unrelated to the guards: the model returned no verdict for a
      // row, so that row recirculates tomorrow with nothing recorded about why.
      log.warn({ covered, batch: orphans.length }, 'orphan-triage: verdict shortfall');
    }
    outcome.guardHits = plan.guardHits;
    outcome.causeStripped = plan.quietCauseStripped;
    outcome.noTarget = plan.quietNoTarget;
    outcome.skipped = plan.skipped;
    outcome.unverified = unverified;
```

Then delete the `else outcome.recordedNoIssue++;` line in the `plan.quiet` loop (~line 378) and its now-dead branch, leaving:

```ts
    for (const v of plan.quiet) {
      review(v, null);
      if (v.review_class === 'not_on_untappd') outcome.notOnUntappd++;
      else if (v.review_class === 'unidentifiable') outcome.unidentifiable++;
      else if (v.review_class === 'not_a_beer') outcome.notABeer++;
      // actionable classes are counted by planTriageActions as causeStripped / noTarget
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/jobs/orphan-triage.test.ts && npx tsc --noEmit`
Expected: PASS and clean typecheck. Existing `buildTriageLine` tests will fail to compile because their literals still carry `recordedNoIssue` — Task 3 rewrites them; for this commit, replace `recordedNoIssue: 0,` with `causeStripped: 0, noTarget: 0, guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 0, unprobed_absence: 0 },` in each literal and leave the expected strings untouched.

- [ ] **Step 5: Commit**

```bash
git rev-parse --show-toplevel   # /home/ysi/warsaw-beer-bot/.claude/worktrees/worktree-432-triage-run-report
git branch --show-current       # must be worktree-432-triage-run-report
git add src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts
git commit -m "$(cat <<'EOF'
feat(#432): publish guardHits on every run, not behind an unrelated condition

`covered` is counted before the guards run, so a refused row still counts as
covered and the only line carrying guardHits never printed. Measured on the
2026-08-16 run: guard 3 fired 9 times in silence.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

---

### Task 3: the narrow warn and the digest line

**Files:**
- Modify: `src/jobs/orphan-triage.ts` (`buildTriageLine` ~line 79; the block added in Task 2 Step 3)
- Test: `src/jobs/orphan-triage.test.ts`

**Interfaces:**
- Consumes: `TriageOutcome.guardHits`, `.causeStripped`, `.noTarget` from Task 2.
- Produces: final shape of the digest line. Nothing later depends on it.

- [ ] **Step 1: Write the failing tests**

```ts
test('narrow warn fires for scope_violation with no shortfall', () => {
  const warn = vi.fn();
  reportGuardAnomalies({ warn } as never, {
    illegal_scope: 0, scope_violation: 2, saturated: 0, unprobed_absence: 0,
  });
  expect(warn).toHaveBeenCalledTimes(1);
});

test('narrow warn fires for illegal_scope with no shortfall', () => {
  const warn = vi.fn();
  reportGuardAnomalies({ warn } as never, {
    illegal_scope: 1, scope_violation: 0, saturated: 0, unprobed_absence: 0,
  });
  expect(warn).toHaveBeenCalledTimes(1);
});

test('narrow warn stays silent for routine guard work', () => {
  const warn = vi.fn();
  reportGuardAnomalies({ warn } as never, {
    illegal_scope: 0, scope_violation: 0, saturated: 5, unprobed_absence: 9,
  });
  expect(warn).not.toHaveBeenCalled();
});

test('buildTriageLine names each quiet mechanism and hides routine guards', () => {
  expect(buildTriageLine({
    total: 15, commented: [], created: [], notOnUntappd: 0, unidentifiable: 0, notABeer: 0,
    causeStripped: 5, noTarget: 1, skipped: 0, unverified: 5,
    guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 4, unprobed_absence: 9 },
    error: null, attempt: null, disabledReason: null,
  })).toBe('Тріаж: 15 нових → 9 без доказу відсутності, 5 неперевірених, 1 без цілі');

  expect(buildTriageLine({
    total: 3, commented: [], created: [], notOnUntappd: 0, unidentifiable: 0, notABeer: 0,
    causeStripped: 0, noTarget: 0, skipped: 2, unverified: 0,
    guardHits: { illegal_scope: 1, scope_violation: 2, saturated: 0, unprobed_absence: 0 },
    error: null, attempt: null, disabledReason: null,
  })).toBe('Тріаж: 3 нових → 1 нелегальний scope, 2 поза scope, 2 пропущено');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/jobs/orphan-triage.test.ts -t 'warn\|buildTriageLine'`
Expected: FAIL — `reportGuardAnomalies` is not exported, and the digest strings do not match.

- [ ] **Step 3: Implement**

Add above `buildTriageLine` in `src/jobs/orphan-triage.ts`:

```ts
// #432: routine guard work and anomalous guard work must not share a path, in either
// direction. `unprobed_absence` fires by construction for any beer whose name is an
// ordinary word (#357) and `saturated` is really a STATE of an issue rather than an event
// (#431) — both are routine and stay in the outcome payload. These two mean two components
// disagree: the model broke a prompt rule, or a row contradicts the scope of the issue it
// was routed to. Someone has to look. Deliberately a predicate on meaning, not a threshold
// on count — the #419 checkpoint is already trying to retire one guessed constant.
export function reportGuardAnomalies(log: pino.Logger, g: Record<GuardReason, number>): void {
  if (g.illegal_scope === 0 && g.scope_violation === 0) return;
  log.warn({ illegalScope: g.illegal_scope, scopeViolation: g.scope_violation },
    'orphan-triage: guard anomaly');
}
```

In `buildTriageLine`, replace the `recordedNoIssue` and `unverified` parts with the three disjoint counters plus the two anomalous guards, keeping every other line as it is:

```ts
  if (o.guardHits.unprobed_absence > 0) parts.push(`${o.guardHits.unprobed_absence} без доказу відсутності`);
  if (o.causeStripped > 0) parts.push(`${o.causeStripped} неперевірених`);
  if (o.noTarget > 0) parts.push(`${o.noTarget} без цілі`);
  if (o.guardHits.illegal_scope > 0) parts.push(`${o.guardHits.illegal_scope} нелегальний scope`);
  if (o.guardHits.scope_violation > 0) parts.push(`${o.guardHits.scope_violation} поза scope`);
```

Order matters for the expected strings above: the three quiet counters first (they describe rows), then the two anomalous guards, then the existing `skipped` part. `saturated` is never rendered.

Call the new function in the block from Task 2, right after `outcome.guardHits = plan.guardHits;`:

```ts
    reportGuardAnomalies(log, plan.guardHits);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/jobs/orphan-triage.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Mutation-prove the routine/anomalous line**

Temporarily widen the predicate to `if (g.illegal_scope === 0 && g.scope_violation === 0 && g.saturated === 0 && g.unprobed_absence === 0) return;` and re-run.
Expected: `narrow warn stays silent for routine guard work` goes RED and nothing else does. Revert the widening and confirm green again. If any other test also goes red, the tests are coupled — report it rather than adjusting them.

- [ ] **Step 6: Commit**

```bash
git rev-parse --show-toplevel   # /home/ysi/warsaw-beer-bot/.claude/worktrees/worktree-432-triage-run-report
git branch --show-current       # must be worktree-432-triage-run-report
git add src/jobs/orphan-triage.ts src/jobs/orphan-triage.test.ts
git commit -m "$(cat <<'EOF'
feat(#432): warn only on guard anomalies, name each quiet mechanism in the digest

Routine guard work (unprobed_absence, saturated) stays in the run payload;
illegal_scope and scope_violation raise a warning on their own trigger. The
digest stops printing a sum next to one of its own parts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

---

### Task 4: full suite, spec check, PR

**Files:**
- Modify: `spec.md` (only if the triage reporting contract is described there)

**Interfaces:**
- Consumes: everything above.
- Produces: an open PR.

- [ ] **Step 1: Run the whole suite and the typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass (the suite was 1993 tests as of PR #424; the count only grows). Any failure outside the three files touched here means a routing behaviour changed — that violates the first Global Constraint. Report it; do not "fix" the failing assertion.

- [ ] **Step 2: Check whether `spec.md` needs updating**

Run: `grep -n "recordedNoIssue\|guardHits\|verdict shortfall\|без issue" spec.md`
If any hit describes the triage report, update it to the new counters in this same PR (project rule). If there are no hits, no edit is needed — say so explicitly in the PR body rather than leaving it unstated.

- [ ] **Step 3: Commit any spec change and open the PR**

```bash
git add -A && git commit -m "$(cat <<'EOF'
docs(#432): sync spec.md with the new triage report counters

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"   # skip entirely if Step 2 found nothing

git push -u origin worktree-432-triage-run-report
gh pr create --title "feat(#432): a triage run that can explain its own outcome" --body "$(cat <<'EOF'
Closes #432.

`guardHits` was logged only under `covered < orphans.length`, but `covered` is
counted before the guards run — so a refused row still counts as covered and the
guards could fire any number of times without the line printing. Measured on the
2026-08-16 run: guard 3 fired 9 times in silence, `skipped: 2` was unattributable,
and `recordedNoIssue: 15` was printed next to `unverified: 5`, one of its own parts.

- `guardHits` now rides the `orphan-triage finished` line, which prints every run.
- `verdict shortfall` keeps its own meaning and loses `guardHits` as a passenger.
- A new warn fires only for `illegal_scope` / `scope_violation` — the two that mean
  a human is needed. `unprobed_absence` (routine by construction, #357) and
  `saturated` (really a state, #431) never raise it.
- The three quiet dispositions are counted where each is decided and rendered
  separately; `recordedNoIssue` is gone.

Reporting only: no row changes class, issue, or destination.

Spec: `docs/superpowers/specs/2026-08/2026-08-16-432-triage-run-report-design.md`
Plan: `docs/superpowers/plans/2026-08/2026-08-16-432-triage-run-report.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

- [ ] **Step 4: Report the PR URL and stop**

Do NOT merge. The user merges PRs in this project.
