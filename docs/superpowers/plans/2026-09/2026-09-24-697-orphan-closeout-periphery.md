# #697 Orphan Closeout Periphery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. AGENTS.md routes subagent tasks to sequential work in the main thread, so execute inline.

**Goal:** Give operators a dry-run-first, fail-closed way to close a parser/matcher orphan issue only after every live row has a durable disposition, then make withheld rows visible and update the runbook.

**Architecture:** A read-only DB inspector classifies every linked row using the v36 positive proof and active #695 disposition; repaired #696 rows are reported from their audit log. A separate operator CLI checks GitHub state, repeats the DB/GitHub preflight before an explicit PATCH, and verifies the result. The unlock job records withheld row IDs in `job_state` for the daily digest. No production issue or row is changed by implementation/testing.

**Tech Stack:** TypeScript, better-sqlite3, native fetch, Vitest, `tsx`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-24-697-orphan-closeout-gate-design.md`, `spec.md` §3.13, and core plan `docs/superpowers/plans/2026-09/2026-09-24-697-orphan-closeout-core.md`.

## Global Constraints

- Use the existing isolated worktree. Core v36/proof/guard commits are prerequisites. Do not mutate #677, production DB or GitHub in this work.
- Zero blockers means every **live** row names the issue and has current positive proof or matching active #695. A #696 repair has no live row and appears in `legacy_card_repairs` audit. `retired_at`, `unrescued_at`, matched-but-still-failing, stale proof, or no verdict block closeout.
- `--close` is the only network write. Dry-run is the default and needs no `GITHUB_TOKEN` write authority beyond GET. Any GitHub or DB failure refuses closure. A UI close can bypass CLI but cannot bypass the core unlock guard.
- Red test before behavior code; full `npm test && npm run typecheck` and path-limited commit per task. No new dependencies, extension changes or automated deployment.

## File map

| File | Responsibility |
| --- | --- |
| `src/jobs/orphan-closeout.ts`, `.test.ts` | read all live issue rows and repair journals, classify positive/inactive/blocker |
| `src/infra/github-closeout.ts`, `.test.ts` | GET current issue state/labels and PATCH state closed via native fetch |
| `scripts/close-orphan-issue.ts`, `.test.ts`, `package.json` | strict args, dry-run JSON, repeated preflight, explicit close and postcheck |
| `src/jobs/unlock-fixed-orphans.ts`, `.test.ts` | persist daily withheld IDs/issue numbers atomically with unlock work |
| `src/jobs/daily-status.ts`, `.test.ts` | show withheld IDs/issue numbers from same-day job state |
| `spec.md`, `docs/orphan-triage-issues-runbook.md` | current v36 semantics and exact closeout commands |

---

### Task 1: Read-only per-row closeout inspection

**Files:** Create `src/jobs/orphan-closeout.ts`, `src/jobs/orphan-closeout.test.ts`.

**Interfaces:** Produce `inspectOrphanIssue(db: DB, issueNumber: number): CloseoutReport` with `rows: {beerId:number; state:'rescued'|'inactive'|'blocked'; reason:string}[]`, `repairs: {orphanBeerId:number; targetBid:number}[]`, and `ready: boolean`. Consume core `hasCurrentRescueProof` and #695 `findActiveDispositionForBeer`.

- [ ] **Step 1: Write failing tests.** Seed a fresh migrated DB with one proof-valid parser row, one active #695 row for the same issue/key, one `unrescued` row, and one #696 repair journal. Expect three row classifications, one repair, `ready:false`. Remove/move the blocker and expect `ready:true`. Change proof ABV/lookup/issue, mark `retired_at`, or use a disposition for another issue/key: each must be blocked. An empty issue cohort is ready but visibly has zero rows/repairs.

```ts
expect(inspectOrphanIssue(db, 697)).toMatchObject({
  ready: false,
  rows: [
    { beerId: 1, state: 'rescued' },
    { beerId: 2, state: 'inactive' },
    { beerId: 3, state: 'blocked' },
  ],
  repairs: [{ orphanBeerId: 4, targetBid: 3615616 }],
});
```

- [ ] **Step 2: Run red test.** `npx vitest run src/jobs/orphan-closeout.test.ts`; expect missing inspector, not fixture errors.
- [ ] **Step 3: Implement read-only inspector.** Query `enrich_failures ef JOIN beers b` by exact `ef.issue_number = ? ORDER BY ef.beer_id`, including retired and already-linked rows. If an active disposition matches the same issue and current exact `cardText`/`cardAbv` key, classify `inactive`; else if `hasCurrentRescueProof`, `rescued`; else `blocked` with a human-readable reason. Query `legacy_card_repairs WHERE issue_number = ? ORDER BY orphan_beer_id` only for audit, never to excuse a live row. No `UPDATE`, network, or `--limit`.

```ts
const state = disposition?.issueNumber === issueNumber
  && disposition.breweryText === cardText(row.brewery)
  && disposition.nameText === cardText(row.name)
  && disposition.abvKey === cardAbv(row.abv)
  ? 'inactive'
  : hasCurrentRescueProof(db, row.beer_id, issueNumber) ? 'rescued' : 'blocked';
```

- [ ] **Step 4: Verify.** Focused test, then `npm test && npm run typecheck`; both exit 0.
- [ ] **Step 5: Commit.** `git add src/jobs/orphan-closeout.ts src/jobs/orphan-closeout.test.ts && git commit -m "feat: inspect every orphan issue row before closeout (#697)" -- src/jobs/orphan-closeout.ts src/jobs/orphan-closeout.test.ts`.

### Task 2: Dry-run-first GitHub close command

**Files:** Create `src/infra/github-closeout.ts`, `.test.ts`, `scripts/close-orphan-issue.ts`, `.test.ts`; modify `package.json`.

**Interfaces:** `GithubCloseoutClient` has `getIssue(n): Promise<{number:number; state:'open'|'closed'; labels:string[]; isPullRequest:boolean}>` and `closeIssue(n): Promise<void>`. `runCloseOrphanIssue(argv, {db, github, print}): Promise<number>` returns exit code 0 only for a ready dry-run or a completed close with a clean postcheck; nonzero on blockers/failures. `parseCloseArgs` accepts exactly `--issue <positive-int>` and optional `--close`.

- [ ] **Step 1: Write failing CLI and client tests.** Dry-run prints every row plus repairs and never PATCHes; blocked returns nonzero and `--close` never PATCHes. Ready `--close` obtains GitHub issue twice, inspects DB twice, PATCHes once, then re-reads issue/DB; if a row appears between checks, no PATCH; if after PATCH, report incomplete and nonzero while core guard still blocks it. Reject closed issue, missing label, PR number, malformed args, missing token in live main, GET/PATCH errors. The fetch fake must check HTTP method, endpoint, and body; DB is real in-memory SQLite.

```ts
expect(await runCloseOrphanIssue(['--issue', '697'], { db, github, print })).toBe(0);
expect(closedCalls).toBe(0);
expect(await runCloseOrphanIssue(['--issue', '697', '--close'], { db, github, print })).toBe(0);
expect(closedCalls).toBe(1);
```

- [ ] **Step 2: Run red tests.** `npx vitest run src/infra/github-closeout.test.ts scripts/close-orphan-issue.test.ts`; expect missing APIs.
- [ ] **Step 3: Implement minimal client and runner.** Use GitHub REST `/repos/${repo}/issues/${n}` with bearer token and standard headers; GET accepts only exact issue number/state/labels, rejects `pull_request`; PATCH sends only `{state:'closed'}` and checks response. Parse args before env/DB. Main loads `loadOperatorEnv`, `loadEnv`, `openDb`, requires v36 before inspecting and `GITHUB_TOKEN` for all live GitHub requests; `runCloseOrphanIssue` does two preflights on `--close`, prints each, and a postcheck after PATCH. Add `"close-orphan-issue": "tsx scripts/close-orphan-issue.ts"` to `package.json`.

```ts
const first = await preflight();
print(JSON.stringify(first));
if (!first.ready || !args.close) return first.ready ? 0 : 1;
const second = await preflight();
if (!second.ready) return 1;
await github.closeIssue(args.issue);
const final = await preflightClosed();
return final.ready ? 0 : 1;
```

- [ ] **Step 4: Verify.** Focused tests, then `npm test && npm run typecheck`; both exit 0. Do not execute a live `--close`.
- [ ] **Step 5: Commit.** Stage only these five paths and commit `feat: gate orphan issue closure on per-row proof (#697)`.

### Task 3: Visibility and operator contract

**Files:** Modify `src/jobs/unlock-fixed-orphans.ts`, `.test.ts`, `src/jobs/daily-status.ts`, `.test.ts`, `spec.md`, `docs/orphan-triage-issues-runbook.md`.

**Interfaces:** `UNLOCK_LAST_RESULT_KEY = 'unlock_fixed_orphans_last_result'`; value `{date:string; withheld:{beerId:number; issueNumber:number}[]}`. `dailyStatus` reads only today's value and displays its count and first five `#issue/beer_id` pairs; old or malformed value contributes no line.

- [ ] **Step 1: Write failing status/integration tests.** A closed, unproved row makes unlock persist its ID/issue atomically, while a proved row does not appear; daily status includes the same-day withheld pair and ignores yesterday's/malformed JSON. Failure in the DB transaction leaves neither rearm nor result state committed. Existing open-page/GitHub-error behavior remains fail-closed.

```ts
expect(JSON.parse(getJobState(db, UNLOCK_LAST_RESULT_KEY)!)).toEqual({
  date: '2026-08-16', withheld: [{ beerId: 1, issueNumber: 697 }],
});
expect(buildStatusMessage(metrics, '2026-08-16', null, null, '1: #697 / beer 1'))
  .toContain('#697 / beer 1');
```

- [ ] **Step 2: Run red tests.** `npx vitest run src/jobs/unlock-fixed-orphans.test.ts src/jobs/daily-status.test.ts`; expect missing result key/status line.
- [ ] **Step 3: Implement status and docs.** Persist the dated withheld list with the existing unlock transaction. In daily status, parse and compare Warsaw date before adding the line; escape/ignore malformed data and bound displayed pairs to five. Update `spec.md` migration table v36, §3.13 proof columns/adjudicate/unlock semantics, and runbook §4.1/§5 with #695/#696/positive-proof outcomes, exact dry-run/`--close` commands, blocker handling, bid/alias conflicts, and post-close checks. Remove obsolete claims that `unrescued` unlocks without rearm or that any closure grants a retry. Documentation is human prose and needs no source-text tests; verify rendered instructions against the actual CLI.

```bash
npm run adjudicate -- --issue 697
npm run adjudicate -- --apply /tmp/adjudicate-697-<timestamp>.json
npm run close-orphan-issue -- --issue 697
npm run close-orphan-issue -- --issue 697 --close
```

- [ ] **Step 4: Verify.** Focused tests and `npm test && npm run typecheck`; `git diff --check`; check `npm run close-orphan-issue --` prints usage before DB access. No live close/deploy.
- [ ] **Step 5: Commit.** Stage only Task 3 paths and commit `docs: complete evidence-gated orphan closeout workflow (#697)`.

## Final gate

Review the entire branch against the design (including core review fixes), verify all tests/typecheck, and report any production audit/deployment prerequisites. Fetch/rebase on `origin/main` and rerun the full gate only if the user confirms opening a PR. Do not close #697 or #677 merely because the code branch is green; deployment and per-row production dispositions are separate actions.
