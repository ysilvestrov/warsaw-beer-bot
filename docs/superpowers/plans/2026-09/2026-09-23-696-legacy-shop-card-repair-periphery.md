# #696 Legacy Shop-Card Repair Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This project's agent instructions require sequential work in the main thread; do not dispatch subagents.

**Goal:** Expose the reviewed #696 repair core as a safe operator command and verify that old and corrected shop cards resolve without production writes.

**Architecture:** A thin CLI parses explicit proof and historical-card ABV, hydrates the exact bid, prints a dry-run preview, then calls the atomic domain operation only with `--apply`. Existing HTTP alias readers need no behavior change; route tests exercise them against a repaired in-memory database. A copy of production data is used only for dry-run/rehearsal after tests and review.

**Tech Stack:** TypeScript, tsx, better-sqlite3, Vitest, existing Algolia client.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-23-696-legacy-shop-card-repair-design.md`; core plan: `docs/superpowers/plans/2026-09/2026-09-23-696-legacy-shop-card-repair-core.md`.

## Global Constraints

- Node `>=24`; no new dependencies or extension changes.
- Dry-run is the default and performs no database writes. It shows whether schema v34 is present; `--apply` refuses an older schema, hydrates again, prints a fresh preview, and refuses stale or colliding state.
- Required flags: `--beer`, `--issue`, `--card-abv` (decimal or `absent`), `--bid`, `--evidence`, `--reason`, `--operator`. `--overwrite-abv` is optional but mandatory on ABV divergence. Reject unknown, repeated, missing-value or malformed flags.
- The URL and reason are stored in `legacy_card_repairs`; a candidate search result is never enough evidence. The operator must separately establish that the proof URL represents the historical card.
- The current branch is an isolated worktree. Run `npm test && npm run typecheck` after each code task; commit only the task's files.
- Do not apply to production or close #677 in this plan. The #695 inactive state and #697 runbook gate remain separate issues.

## File map

| File | Responsibility |
|---|---|
| `scripts/repair-legacy-card.ts`, `scripts/repair-legacy-card.test.ts` | strict CLI parsing, hydration, dry-run/apply orchestration and test seam |
| `package.json` | `npm run repair-legacy-card` entry |
| `src/api/routes/merge-alias-loop.test.ts` | old-card `/match` and `/enrich/*` regressions after manual repair |
| `docs/orphan-triage-issues-runbook.md` | #696 operator invocation, proof and ABV warning; #697 closure gate is not implemented here |

---

### Task 1: Operator CLI

**Files:**
- Create: `scripts/repair-legacy-card.ts`
- Create: `scripts/repair-legacy-card.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `previewLegacyCardRepair` and `applyLegacyCardRepair` from `src/domain/repair-legacy-card.ts`; `createAlgoliaSearch` and `HydratedBeer` from `src/sources/untappd/*`.
- Produces:

```ts
export interface RepairCliArgs {
  beerId: number; issueNumber: number; cardAbv: number | null; bid: number;
  evidenceUrl: string; reason: string; operator: string;
  overwriteAbv: boolean; apply: boolean;
}
export function parseRepairCliArgs(argv: string[]): RepairCliArgs;
export async function runRepairLegacyCard(
  argv: string[], deps: {
    db: DB;
    hydrate: (bids: number[]) => Promise<Map<number, HydratedBeer | null>>;
    print: (line: string) => void;
  },
): Promise<void>;
```

- [ ] **Step 1: Write failing tests.** In `scripts/repair-legacy-card.test.ts`, assert `parseRepairCliArgs` parses `--card-abv 6` and `--card-abv absent` distinctly; rejects missing/repeated/unknown flags, non-positive IDs, `NaN`, negative ABV and an evidence URL without HTTP(S). With an in-memory DB and injected hydrate, assert dry-run prints the old card, stored and hydrated ABVs, exact alias key, issue, bid, evidence, reason, and intended overwrite but leaves `beers`, `beer_aliases`, `enrich_failures`, and `legacy_card_repairs` untouched. Assert `--apply` produces one audit/alias and a second hydration refusal leaves the DB unchanged. Keep network out of tests.
- [ ] **Step 2: Run `npx vitest run scripts/repair-legacy-card.test.ts`.** It must fail for missing CLI exports.
- [ ] **Step 3: Implement parser and runner.** Parse only the named flags and require exactly one occurrence each; `--card-abv absent` maps to `null`, a decimal maps to a finite non-negative number. Read `MAX(schema_version.version)` before hydration; preview prints `schemaVersion`/`readyToApply`, while `--apply` refuses versions below 34. Hydrate `[bid]` once per invocation and require the map to contain a non-null record for that exact bid. Build `LegacyCardRepairInput` with `at = new Date().toISOString()`, call `previewLegacyCardRepair`, print a JSON object with the complete preview plus `evidenceUrl`, `reason`, `operator`, `overwriteAbv`, and `apply`. Return after printing when `apply` is false. When true, pass the just-printed preview into `applyLegacyCardRepair` and print the result. Do not store or apply a stale preview file.
- [ ] **Step 4: Wire the real command.** Add `"repair-legacy-card": "tsx scripts/repair-legacy-card.ts"` to `package.json`. In the script's `require.main === module` branch, call `loadOperatorEnv`; parse usage before `loadEnv/openDb`; construct `createAlgoliaSearch` with `ALGOLIA_DEFAULTS`, configured keys and `WEBSHARE_PROXY` as `scripts/adjudicate-runner.ts` does; close DB in `finally`; print errors and exit nonzero. The runner stays injectable for tests.
- [ ] **Step 5: Run `npx vitest run scripts/repair-legacy-card.test.ts`, then `npm test && npm run typecheck`.** Both pass. Stage only Task 1 files and commit `feat: expose audited legacy card repair command`.

### Task 2: HTTP regressions and operator guide

**Files:**
- Modify: `src/api/routes/merge-alias-loop.test.ts`
- Modify: `docs/orphan-triage-issues-runbook.md`

**Interfaces:**
- Consumes: Task 1 command; existing `/match`, `/enrich/candidates`, and `/enrich/result` routes.
- Produces: runnable old/new-client route proof and a documented operator command, without changing production API code.

- [ ] **Step 1: Add a failing route-level regression.** Seed a known catalog bid and an old-card orphan in the existing route-test fixture. Apply `repairLegacyCard` with a 6% historical card and 7% hydrated bid. Assert `/match` identifies the old 6% card via alias without creating an orphan, `/enrich/candidates` returns the same bid without consuming a search, and the corrected card still follows the current adapter's bid path. Assert a 7% variant of the *old spelling* has no inferred alias. Use the request and auth helpers already in `merge-alias-loop.test.ts`; do not mock route internals.
- [ ] **Step 2: Run `npx vitest run src/api/routes/merge-alias-loop.test.ts`.** If the test passes immediately because routes already honor aliases, keep it as an integration regression; do not make a production-route change merely to force red.
- [ ] **Step 3: Document the invocation.** In `docs/orphan-triage-issues-runbook.md`, show dry-run then `--apply` with the same explicit flags, including `--card-abv absent` and `--overwrite-abv` only for a genuine mismatch. State that the proof URL alone is not proof of the old card-to-product association, search candidates are not identity evidence, and #677 cannot close until every row has a durable disposition. Point to `legacy_card_repairs` for reason/evidence and to the exact alias key for an emergency correction; do not claim the #697 closure gate exists yet.
- [ ] **Step 4: Run `npx vitest run src/api/routes/merge-alias-loop.test.ts`, then `npm test && npm run typecheck`.** Both pass. Stage only Task 2 files and commit `test: prove legacy shop cards resolve through API`.

## Release rehearsal and stopping point

After Task 2, review the whole #696 diff against the design. Use a temporary **copy** of the production database to run the command without `--apply`; inspect the preview for one proven row and one unresolved row, and verify that the copy has no new alias/audit or changed orphan state. Only if the exact historical card and ABV proof is available, rehearse `--apply` on the copy and check its alias, audit, canonical ABV and `PRAGMA foreign_key_check`. Do not apply to the live database as part of this plan. Re-run `npm test && npm run typecheck` after review fixes. At this point the code is ready for PR consideration, while #677 remains open pending #695 and #697.
