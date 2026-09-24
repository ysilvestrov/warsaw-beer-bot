# #697 Orphan Closeout Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. AGENTS.md routes subagent tasks to sequential work in the main thread, so execute inline.

**Goal:** Make an applied positive per-row replay the only way a closed parser/matcher issue can re-arm an orphan.

**Architecture:** Add v36 positive-proof columns to `enrich_failures`, capture the matched bid and ABV in the existing two-phase adjudication, and validate the persisted snapshot whenever the close-trigger job considers an unlock. The existing negative marker remains audit-only and cannot unlock a row. This is the core stage; the operator close command, status and runbook are planned after whole-branch review.

**Tech Stack:** TypeScript, better-sqlite3, Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-24-697-orphan-closeout-gate-design.md` and `spec.md` §3.13.

## Global Constraints

- Work in the existing isolated worktree `design/issue-697-closeout-gate`; leave #677 and production data untouched.
- Every positive proof belongs to one `beer_id`, issue, input snapshot, lookup state and bid. No migration backfill and no proof inferred from `retired_at`, `unrescued_at` or GitHub closure.
- `--force` only waives file age, never live-row validation. A pre-existing `unrescued_at` requires an explicit rearm and a fresh replay before it can be rescued.
- `unlock-fixed-orphans` must re-check proof at the moment of rearm, and an absent/stale/foreign proof must leave `unlocked_at` and backoff untouched.
- Red test before production code for each behavioral slice; full `npm test && npm run typecheck` after each task; path-limited commit on green.
- Core alone is not a complete operator workflow: do not deploy it or close any issue until the separately planned close command, status, spec and runbook land.

## File map

| File | Responsibility |
| --- | --- |
| `src/storage/schema.ts`, `.test.ts` | v36 columns, empty-by-default migration and version-head test |
| `src/storage/enrich_failures.ts`, `.test.ts` | write and read validated positive proof for a row; no interpretation of GitHub state |
| `src/jobs/adjudicate-issue-rows.ts`, `.test.ts` | emit matched bid and ABV only for `rescued` verdicts |
| `src/jobs/adjudicate-apply.ts`, `.test.ts` | parse/validate new positive verdict and persist it under current-row checks |
| `src/jobs/unlock-fixed-orphans.ts`, `.test.ts` | fail-closed use of current positive proof; old unrescued unlock path removed |

---

### Task 1: v36 and current positive-proof storage

**Files:** Modify `src/storage/schema.ts`, `src/storage/schema.test.ts`, `src/storage/enrich_failures.ts`, `src/storage/enrich_failures.test.ts`.

**Interfaces:** Produce `markRescued(db, proof: RescuedProof): boolean` and `hasCurrentRescueProof(db, beerId: number, issueNumber: number): boolean`. `RescuedProof` contains `beerId`, `issueNumber`, `bid`, `brewery`, `name`, `abv`, `lookupCount`, `lookupAt`, `rearmCount`, `probedAt`, `appliedAt`.

- [ ] **Step 1: Write failing storage/migration tests.** In `schema.test.ts`, assert head versions `1..36`, all `rescued_*` columns start NULL on an existing failure row after migration, and `PRAGMA foreign_key_check` is empty. In `enrich_failures.test.ts`, seed a parser/matcher orphan and assert `hasCurrentRescueProof` starts false; after `markRescued`, it is true only for its issue; changing issue, brewery, name, ABV, lookup count/time, or `rearm_count` makes it false. `unrescued_at` must prevent a positive mark. The production mutation that makes these tests red is precisely the absence of the v36 schema and proof reader.

```ts
expect(hasCurrentRescueProof(db, beerId, 697)).toBe(false);
expect(markRescued(db, {
  beerId, issueNumber: 697, bid: 3615616, brewery: 'Mad Brew', name: 'Row 1',
  abv: 6, lookupCount: 0, lookupAt: null, rearmCount: 0,
  probedAt: '2026-09-24T10:00:00Z', appliedAt: '2026-09-24T10:01:00Z',
})).toBe(true);
expect(hasCurrentRescueProof(db, beerId, 697)).toBe(true);
db.prepare('UPDATE beers SET rearm_count = rearm_count + 1 WHERE id = ?').run(beerId);
expect(hasCurrentRescueProof(db, beerId, 697)).toBe(false);
```

- [ ] **Step 2: Run red tests.** `npx vitest run src/storage/schema.test.ts src/storage/enrich_failures.test.ts`; expect missing v36/proof API failure, not fixture failure.
- [ ] **Step 3: Implement the schema and storage boundary.** Append v36 with nullable `rescued_issue`, `rescued_at`, `rescued_bid`, `rescued_brewery`, `rescued_name`, `rescued_abv`, `rescued_lookup_count`, `rescued_lookup_at`, `rescued_rearm_count`, `rescued_probed_at`. `markRescued` parameterizes an update of those ten columns restricted by `beer_id = ? AND unrescued_at IS NULL AND issue_number = ?`; caller must already have checked live row. Return `true` for a new mark, `false` for an identical retry, and throw for a conflicting existing proof, missing row or active `unrescued_at`. `hasCurrentRescueProof` joins `beers`, requires `untappd_id IS NULL`, `retired_at IS NULL`, `unlocked_at IS NULL`, class parser/matcher, matching issue, positive bid, all required proof fields present, and null-safe equality for brewery/name/ABV/lookup count/time/rearm count. No `OR rescued_issue IS NULL` fallback. For NULL ABV and lookup time use `IS` in SQLite.

```sql
SELECT 1 FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
 WHERE ef.beer_id = ? AND ef.issue_number = ? AND ef.rescued_issue = ef.issue_number
   AND ef.rescued_bid > 0 AND ef.rescued_at IS NOT NULL
   AND ef.rescued_probed_at IS NOT NULL AND ef.unrescued_at IS NULL
   AND ef.review_class IN ('parser_bug','matcher_bug')
   AND ef.retired_at IS NULL AND ef.unlocked_at IS NULL AND b.untappd_id IS NULL
   AND b.brewery IS ef.rescued_brewery AND b.name IS ef.rescued_name
   AND b.abv IS ef.rescued_abv AND b.untappd_lookup_count = ef.rescued_lookup_count
   AND b.untappd_lookup_at IS ef.rescued_lookup_at
   AND b.rearm_count = ef.rescued_rearm_count;
```

- [ ] **Step 4: Verify.** `npx vitest run src/storage/schema.test.ts src/storage/enrich_failures.test.ts`, then `npm test && npm run typecheck`; both exit 0.
- [ ] **Step 5: Commit.** `git add src/storage/schema.ts src/storage/schema.test.ts src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts && git commit -m "feat: persist per-row positive orphan replay proof (#697)" -- src/storage/schema.ts src/storage/schema.test.ts src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts`.

### Task 2: Canary-backed positive replay apply

**Files:** Modify `src/jobs/adjudicate-issue-rows.ts`, `.test.ts`, `src/jobs/adjudicate-apply.ts`, `.test.ts`, `scripts/adjudicate-runner.ts` (report only, if needed).

**Interfaces:** Consume Task 1 `markRescued`. `Verdict` becomes a discriminated union: common fields `beer_id`, `brewery`, `name`, `lookup_count`, `lookup_at`, `rearm_count`; `rescued` adds `bid: number` and `abv: number | null`; other verdicts keep their current shape. `ApplyReport` adds `rescuedMarked` and `rescuedAlreadyMarked` while retaining negative counts.

- [ ] **Step 1: Write failing probe and apply tests.** Probe with a matched `LookupOutcome` and ABV 6, assert its verdict has `bid: 3615616, abv: 6`; failed closing canary yields no file. Apply that file and assert persisted proof. Reapply identically: no timestamp/bid change. A new bid conflicts; a current `unrescued_at`, changed ABV, changed issue, matched/retired/missing beer, or an unchanged-zero lookup followed by rearm must skip with explicit reason. Parsing a `rescued` verdict without bid/ABV must throw; negative legacy files must still parse. Update the existing `marks only the unrescued verdicts` test: with a valid positive verdict it now marks one negative and one positive, without confusing the two. The production mutation making tests red is positive verdicts currently being ignored.

```ts
const result = await probeIssueRows({ db, log, canary: async () => true,
  lookup: async () => ({ kind: 'matched', result: { bid: 3615616, name: 'Row 1', brewery: 'Mad Brew' } as never }),
  now: () => new Date('2026-09-24T10:00:00Z') }, 697);
expect(result.status === 'ok' && result.file.verdicts[0]).toMatchObject({
  verdict: 'rescued', bid: 3615616, abv: 6,
});
```

- [ ] **Step 2: Run red tests.** `npx vitest run src/jobs/adjudicate-issue-rows.test.ts src/jobs/adjudicate-apply.test.ts`; expect missing bid/ABV and absent persisted proof.
- [ ] **Step 3: Implement minimal probe/apply extension.** The probe already selects `b.abv`; copy it into matched verdict with `outcome.result.bid` and leave other verdicts backward compatible. `parseVerdictFile` requires safe positive integer bid and an explicitly present finite nullable ABV for rescued, and rejects duplicate `beer_id` entries. In `applyVerdicts`, reuse the existing transaction/current-row checks for both positive and negative verdicts, add ABV check only for rescued, and call `markRescued` after all checks. Report positive written/already separately; a conflicting persisted proof throws and rolls back the file transaction. Never turn a skipped positive verdict into `unrescued`. Preserve no-network apply and four-hour age gate in runner. Update runner print to show both positive and negative counts.

```ts
if (v.verdict === 'rescued' && row.abv !== v.abv) { skip('input_changed'); continue; }
if (v.verdict === 'rescued') {
  const written = markRescued(db, { beerId: v.beer_id, issueNumber: file.issue,
    bid: v.bid, brewery: v.brewery, name: v.name, abv: v.abv,
    lookupCount: v.lookup_count, lookupAt: v.lookup_at, rearmCount: v.rearm_count,
    probedAt: file.probed_at, appliedAt: atIso });
  if (written) report.rescuedMarked += 1;
  else report.rescuedAlreadyMarked += 1;
  continue;
}
```

- [ ] **Step 4: Verify.** `npx vitest run src/jobs/adjudicate-issue-rows.test.ts src/jobs/adjudicate-apply.test.ts`, then `npm test && npm run typecheck`; both exit 0.
- [ ] **Step 5: Commit.** `git add src/jobs/adjudicate-issue-rows.ts src/jobs/adjudicate-issue-rows.test.ts src/jobs/adjudicate-apply.ts src/jobs/adjudicate-apply.test.ts scripts/adjudicate-runner.ts && git commit -m "feat: apply canary-backed rescued verdicts (#697)" -- src/jobs/adjudicate-issue-rows.ts src/jobs/adjudicate-issue-rows.test.ts src/jobs/adjudicate-apply.ts src/jobs/adjudicate-apply.test.ts scripts/adjudicate-runner.ts`.

### Task 3: Fail-closed unlock guard

**Files:** Modify `src/jobs/unlock-fixed-orphans.ts`, `.test.ts`, `src/storage/enrich_failures.ts` only if the Task 1 reader needs one more field.

**Interfaces:** Consume `hasCurrentRescueProof(db, beerId, issueNumber)` from Task 1. `UnlockOutcome` adds `withheld: number` and keeps `unlocked`; remove the old rearm-skipped semantics because negative proof no longer unlocks.

- [ ] **Step 1: Update existing unlock tests to the new contract.** A closed issue without proof must leave the row locked and backoff unchanged; a current positive proof permits exactly one rearm; `unrescued_at` never unlocks; wrong issue, changed lookup/rearm/ABV, manual label removal and new post-close row stay locked. Preserve tests for open-set pagination, GitHub errors, job idempotency, retirement and inactive #695; where those tests need an unlock, seed valid proof through `markRescued`. A row whose close was bypassed must appear in `withheld` and warning logs. The old unconditional-unlock test should fail red against current code.

```ts
const row = seedLocked(db, 'Needs proof', 'matcher_bug', 697);
const out = await unlockFixedOrphans({ db, log, github: stubGithub([]), now: NOW });
expect(out.unlocked).toBe(0);
expect(out.withheld).toBe(1);
expect(db.prepare('SELECT unlocked_at FROM enrich_failures WHERE beer_id = ?')
  .get(row)).toEqual({ unlocked_at: null });
```

- [ ] **Step 2: Run red test.** `npx vitest run src/jobs/unlock-fixed-orphans.test.ts`; expect old unconditional unlock to violate the new assertion.
- [ ] **Step 3: Implement the guard.** Within the closed-row loop, call `hasCurrentRescueProof` immediately before write; on false, increment `withheld`, log `{beerId, issueNumber}` and continue without `markUnlocked` or `rearmLookup`. On true, `rearmLookup` then `markUnlocked`, ideally in one SQLite transaction per row. Keep the full-page and GitHub-error fail-closed guards unchanged. `listLockedRows` already excludes active #695 and retired rows. Never accept `unrescued_issue` as substitute evidence.

```ts
if (!hasCurrentRescueProof(db, row.beer_id, row.issue_number)) {
  withheld += 1;
  log.warn({ beerId: row.beer_id, issueNumber: row.issue_number },
    'unlock-fixed-orphans: closed issue without current rescue proof');
  continue;
}
db.transaction(() => { rearmLookup(db, row.beer_id); markUnlocked(db, row.beer_id, atIso); })();
```

- [ ] **Step 4: Verify.** `npx vitest run src/jobs/unlock-fixed-orphans.test.ts`, then `npm test && npm run typecheck`; both exit 0. Inspect production-relevant SQL and changed-file diff. Do **not** deploy the core alone.
- [ ] **Step 5: Commit.** `git add src/jobs/unlock-fixed-orphans.ts src/jobs/unlock-fixed-orphans.test.ts src/storage/enrich_failures.ts && git commit -m "fix: require rescued proof before orphan unlock (#697)" -- src/jobs/unlock-fixed-orphans.ts src/jobs/unlock-fixed-orphans.test.ts src/storage/enrich_failures.ts`.

## Core review checkpoint

Review the **whole branch**, including inline Tasks 1–3 and the design/plan, for stale-proof acceptance, unintended unlocks, migration integrity and race windows. Resolve findings, rerun `npm test && npm run typecheck`, then write a separate periphery plan for the close command, observability, `spec.md` and runbook. Do not treat core as deployable until periphery has been verified.
