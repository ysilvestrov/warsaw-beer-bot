# #665 core selection follow-up implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Work sequentially in the existing issue-665 worktree; no subagents. Steps use checkbox syntax.

**Goal:** Resolve the independently verified P2: a grade-less sibling must not win the fuzzy path opened by a contextual Czech grade veto.

**Architecture:** Track a relevant veto within one matchPrepared call. Keep the existing context predicate and original search pools. Once a relevant veto occurs, filter the complete eligible fuzzy result list for unambiguous matching grade evidence before top-score selection. No new index, parser or ranking tier.

**Tech Stack:** Existing TypeScript, Vitest, fast-fuzzy.

**Spec:** docs/superpowers/specs/2026-09/2026-09-28-665-core-review-amendment.md, approved user choice1; supplements the original approved #665 design.

## Global constraints

- Existing no-context identity, name parser, scores, aliases, full-search memoization and original brewery bucket/budget remain intact.
- The evidence filter controls fuzzy selection only after a relevant Czech veto, not exact identity or other fuzzy calls.
- A relevant veto is a row otherwise passing the normalized/anchored name gate or an above-threshold search result. An unrelated below-threshold row cannot trigger it.
- No production writes, new dependency, schema migration, release or PR in this task.
- Do not start peripheral planning until core review resolution is recorded.

## Task S1: guard the newly opened fuzzy path

**Files:** src/domain/matcher.ts and src/domain/matcher.test.ts.
**Consumes:** readNameDigits, czechGradesContradict and the current prepared catalog interfaces.
**Produces:** unchanged matchPrepared signature, with the approved post-veto eligibility requirement.

- [x] Add real-searcher regressions to the existing #665 describe. Use the existing ten45 and twelve37334 fixtures, plus:

```ts
const demon = c({ id: 99, brewery: 'KONRAD Brewery', name: 'Konrad Démon',
  style: 'Lager - Strong', abv: 7.2 });
const input = { brewery: 'KONRAD Brewery', name: 'KONRAD 10°' };
expect(matchBeer(input, [twelve, demon, ten]))
  .toEqual({ id: 45, confidence: 1, source: 'fuzzy' });
expect(matchBeer(input, [twelve, demon])).toBeNull();
```

Add both catalog orders, multiple conflicting11°/12° rows, and a control that the same fuzzy call without a veto keeps its old result99. No weak or derived expectations.

- [x] Run npm test -- src/domain/matcher.test.ts, capture /tmp/issue-665-selection-red.log and verify failure is id99 instead of45/null.
- [x] Implement in matchPrepared:

```ts
let gradeVetoed = false;
const keepGrade = (candidate: PreparedBeer): boolean => {
  const allowed = gradeAllows(candidate);
  if (!allowed) gradeVetoed = true;
  return allowed;
};
const confirmsGrade = (candidate: PreparedBeer): boolean => {
  const digits = readNameDigits(candidate.name);
  const values = new Set([...digits.grades, ...digits.soft].map(Number));
  return values.size === 1 && values.has(Number(inputDigits.grades[0]));
};
```

Place both closures after existing gradeAllows. Move the normalized exact grade filter AFTER its existing name/style/ABV filter and use keepGrade. Move anchored keepGrade after its existing aliases/remainder gate. Preserve sorting, remaining exact logic and the original breweryMatches variable.

Replace the fuzzy results declaration with:

```ts
const eligible = searcher.search(`${seedBrewery} ${nn}`)
  .filter((result) => keepGrade(result.item));
const results = gradeVetoed
  ? eligible.filter((result) => confirmsGrade(result.item))
  : eligible;
```

The first filter must finish before testing gradeVetoed, so a conflicting row appearing later in score order still applies the evidence requirement to earlier rows. Numeric equivalence permits10°/10.0°/10,0°. Multiple distinct grades or soft signals are ambiguous and cannot establish the requested grade. Hard numbers, versions, years and ABV are not positive evidence.

- [x] Add isolated selection tests with an injected sorted full-search list: grade-less higher result, conflicting12° result, positive10°/soft10 lower result; expect lower supported id and unchanged score. Table unsupported candidates10%,2026,#10,10.0(no degree),10°11° and10.5°; each must leave supported row winning. Test equal decimal-grade evidence and an unrelated below-threshold Czech12° row that must not trigger the guard. Cover an exact veto and anchor veto even when the conflicting row is absent from injected fuzzy results.
- [x] Run focused matcher, digit-identity and cache tests; capture /tmp/issue-665-selection-green.log. Mutation: disable the new evidence filter and assert the named real-searcher regression fails. Restore, then npm test && npm run typecheck, capture /tmp/issue-665-selection-gate.log.
- [x] Review the scoped diff, verify the original independent finding's exact three fixture scenarios, record resolution against the original peer receipt. Be explicit that this is local verification of the fix, not a fresh external review of the amended head. Commit named files and update plan/receipt. The user's one-time Anthropic authorization is not renewed by this plan.
- [x] Resume the core checkpoint: include this inline task in the review package. Only after resolving the retained finding, prepare the separate peripheral plan covering all catalog loaders and persistent identity callers, alias, spec.md, snapshot replay and recovery.

## Coverage

This task implements the approved positive-evidence clarification. Original U1/U2 tests remain regression coverage. It does not claim the whole #665 fix is ready to ship; the later full-branch review still applies.

## Execution receipt — 2026-09-28

Four real-searcher regressions failed on id99 before implementation. Focused tests:367passed. All three omission mutations (evidence filter, exact-veto signal, anchor-veto signal) fail assertions and were restored. Full gate:3700passed,1skipped; typecheck passed. Actual old/current probe now chooses45 with Démon in the pool and null without45. No new external transfer or production mutation occurred.

Local resolution review: per-call state cannot leak; tracking occurs only after name eligibility or within complete above-threshold results; numeric evidence excludes ABV/year/version/hard numbers and ambiguous values. The complete veto pass precedes evidence filtering. Public signatures, exact identity, original brewery bucket, memoized index and budget are unchanged. The original independent P2 is resolved; a fresh external review of this amended head has not run.

Peripheral plan prepared after core finding resolution: [P1–P4](2026-09-28-665-czech-grade-peripheral.md). No peripheral production edits made during planning.
