# #695 Inactive Legacy Orphans: Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository, AGENTS.md routes subagent tasks to sequential work in the main thread; follow that higher-priority rule.

**Goal:** Persist and audit an operator-only inactive/reopen decision for one legacy orphan and one exact historical shop card.

**Architecture:** A v35 SQLite table records disposition episodes, with partial unique indexes for the active beer and exact card key. A narrow storage reader exposes active decisions; a domain command previews and transactionally applies or reopens one episode, and a CLI supplies explicit operator inputs. This is the **core only**: do not deploy or apply a disposition until a separately planned periphery change makes every automatic reader honor it.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, existing `tsx` operator commands; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-23-695-inactive-legacy-orphans-design.md` and `spec.md` §3.6.3.

## Global Constraints

- Read `spec.md`, the design above, and AGENTS.md before implementing. Work in the existing isolated worktree `design/issue-695-inactive-orphans`; do not touch another worktree's edits.
- `retired_at`, `unrescued_at`, `review_class`, lookup counters, and `beer_aliases` retain their meanings. No bulk operation by issue number and no production row disposition in this plan.
- An active decision covers one `beer_id` and one `(cardText(brewery), cardText(name), cardAbv(abv))` key. ABV, including explicit absence, must come from historical card evidence, not an assumption from current `beers.abv`.
- Every write rechecks live row, issue, failure, alias, and active-decision state inside one transaction. A different proposal conflicts; an identical retry may be a no-op only against persisted evidence.
- Use the existing dry-run-first CLI style. Full gate after each task: `npm test && npm run typecheck`; commit only after a passing gate. No new dependency or unrelated refactor.
- Before any PR, fetch/rebase onto current `main`, rerun the full gate, and ask the user whether to create the PR. Core alone is not safe to deploy.

## File map

| File | Responsibility |
|---|---|
| `src/storage/schema.ts`, `src/storage/schema.test.ts` | v35 table/indexes and migration constraints; no data backfill |
| `src/storage/legacy-orphan-dispositions.ts`, `.test.ts` | read active episode by row or exact card; insert/close episode only for domain command |
| `src/domain/dispose-legacy-orphan.ts`, `.test.ts` | input validation, preview, stale-state checks, one-row apply and explicit reopen |
| `scripts/dispose-legacy-orphan.ts`, `.test.ts`, `package.json` | strict CLI parsing, schema-version guard, dry-run output and `--apply` |
| `spec.md` | add v35 to the migration inventory only when the migration exists; §3.6.3 already specifies behavior |

---

### Task 1: Schema and active-disposition storage boundary

**Files:** Modify `src/storage/schema.ts`, `src/storage/schema.test.ts`, `spec.md`; create `src/storage/legacy-orphan-dispositions.ts`, `src/storage/legacy-orphan-dispositions.test.ts`.

**Interfaces:** Produces `findActiveDispositionForBeer(db: DB, beerId: number): ActiveLegacyDisposition | null`, `findActiveDispositionForCard(db: DB, brewery: string, name: string, abv: number | null): ActiveLegacyDisposition | null`, and `ActiveLegacyDisposition` with `id`, `beerId`, `issueNumber`, raw card fields, normalized key, reason/evidence/operator, `inactiveAt`. Domain Task 2 is the only writer: `insertLegacyDisposition(db, row)` and `closeLegacyDisposition(db, id, reopening)` run inside its transaction, with no transaction hidden in storage.

```ts
export interface LegacyDispositionInsert {
  beerId: number; issueNumber: number; cardBrewery: string; cardName: string;
  cardAbv: number | null; breweryText: string; nameText: string; abvKey: string;
  failureSourceUrl: string; reason: string; evidenceUrl: string; operator: string;
  inactiveAt: string;
}
export interface LegacyReopening {
  reopenedAt: string; reopeningReason: string; reopeningEvidenceUrl: string;
  reopeningOperator: string;
}
export function insertLegacyDisposition(db: DB, row: LegacyDispositionInsert): number;
export function closeLegacyDisposition(db: DB, id: number, reopening: LegacyReopening): boolean;
```

- [ ] **Step 1: Write migration tests that fail without v35.** In `schema.test.ts`, migrate a fresh `:memory:` DB, assert `legacy_orphan_dispositions` and both partial unique indexes exist, then insert one active row and assert duplicate active `beer_id` and duplicate active exact key throw. Close the row, then assert a new episode for the same beer/key inserts; old evidence remains. In the storage test, use a seeded orphan/failure and assert absent/active/reopened exact-card and row lookups. Include `abv = null`, `abv = 0`, and `abv = 6` as distinct keys.

```ts
expect(db.prepare("SELECT name FROM sqlite_master WHERE name='legacy_orphan_dispositions'").get())
  .toEqual({ name: 'legacy_orphan_dispositions' });
expect(findActiveDispositionForCard(db, 'De Cam', 'Abrikoos 2018', 6)?.beerId).toBe(29955);
expect(findActiveDispositionForCard(db, 'De Cam', 'Abrikoos 2018', 7)).toBeNull();
expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
```

- [ ] **Step 2: Run red tests.** `npx vitest run src/storage/schema.test.ts src/storage/legacy-orphan-dispositions.test.ts`; expected failure: missing table/export, not a fixture/setup error.
- [ ] **Step 3: Add migration v35 and storage code.** Append one migration after v34. Use a historical `beer_id` without cascading FK. The exact-key columns and `reopened_at` drive active lookup; indexes enforce active uniqueness even for direct SQL. No migration-time classification/backfill.

```sql
CREATE TABLE legacy_orphan_dispositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beer_id INTEGER NOT NULL CHECK (beer_id > 0),
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  card_brewery TEXT NOT NULL CHECK (length(trim(card_brewery)) > 0),
  card_name TEXT NOT NULL CHECK (length(trim(card_name)) > 0),
  card_abv REAL CHECK (card_abv IS NULL OR card_abv BETWEEN 0 AND 100),
  brewery_text TEXT NOT NULL CHECK (length(brewery_text) > 0),
  name_text TEXT NOT NULL CHECK (length(name_text) > 0),
  abv_key TEXT NOT NULL,
  failure_source_url TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence_url TEXT NOT NULL CHECK (length(trim(evidence_url)) > 0),
  operator TEXT NOT NULL CHECK (length(trim(operator)) > 0),
  inactive_at TEXT NOT NULL,
  reopened_at TEXT,
  reopening_reason TEXT,
  reopening_evidence_url TEXT,
  reopening_operator TEXT,
  CHECK ((reopened_at IS NULL AND reopening_reason IS NULL AND reopening_evidence_url IS NULL AND reopening_operator IS NULL)
      OR (reopened_at IS NOT NULL AND length(trim(reopening_reason)) > 0
          AND length(trim(reopening_evidence_url)) > 0 AND length(trim(reopening_operator)) > 0))
);
CREATE UNIQUE INDEX idx_legacy_orphan_active_beer
  ON legacy_orphan_dispositions(beer_id) WHERE reopened_at IS NULL;
CREATE UNIQUE INDEX idx_legacy_orphan_active_card
  ON legacy_orphan_dispositions(brewery_text, name_text, abv_key) WHERE reopened_at IS NULL;
CREATE INDEX idx_legacy_orphan_dispositions_issue ON legacy_orphan_dispositions(issue_number);
```

```ts
export function findActiveDispositionForCard(
  db: DB, brewery: string, name: string, abv: number | null,
): ActiveLegacyDisposition | null {
  return readActiveCard(db, cardText(brewery), cardText(name), cardAbv(abv));
}
```

`readActiveCard` maps the selected SQL snake_case columns to the declared interface; `findActiveDispositionForBeer` uses `WHERE beer_id = ? AND reopened_at IS NULL`. `insertLegacyDisposition` executes a parameterized `INSERT` with all decision fields; `closeLegacyDisposition` uses `UPDATE ... WHERE id = ? AND reopened_at IS NULL` and returns whether one row changed. The domain layer must never use `INSERT OR REPLACE` or `ON CONFLICT DO UPDATE`. Add v35 to `spec.md` migration table with “no backfill; active exact-card and row indexes.”

- [ ] **Step 4: Run focused and full gate.** `npx vitest run src/storage/schema.test.ts src/storage/legacy-orphan-dispositions.test.ts`; then `npm test && npm run typecheck`. Both must pass.
- [ ] **Step 5: Commit.** `git add src/storage/schema.ts src/storage/schema.test.ts src/storage/legacy-orphan-dispositions.ts src/storage/legacy-orphan-dispositions.test.ts spec.md && git commit -m "feat: persist audited inactive legacy orphan episodes"`.

### Task 2: Preview, apply, and manual reopen

**Files:** Create `src/domain/dispose-legacy-orphan.ts`, `src/domain/dispose-legacy-orphan.test.ts`; modify only the storage module from Task 1 if its exact writer signatures need the declared input fields.

**Interfaces:** Consumes Task 1 active readers/writers. Produces `previewLegacyOrphanDisposition(db, input): LegacyDispositionPreview`, `applyLegacyOrphanDisposition(db, input, expected): {episodeId: number; kind: 'applied' | 'noop'}`, `previewLegacyOrphanReopen(db, input): LegacyReopenPreview`, `applyLegacyOrphanReopen(db, input, expected): {episodeId: number; kind: 'reopened' | 'noop'}`. `LegacyDispositionInput` has `beerId`, `issueNumber`, `cardBrewery`, `cardName`, `cardAbv`, `reason`, `evidenceUrl`, `operator`, `at`. `LegacyReopenInput` has `episodeId`, `reason`, `evidenceUrl`, `operator`, `at`. Previews include all row/failure fields used by the apply comparison and exact alias/active-key collision state.

- [ ] **Step 1: Write failing domain tests.** Seed a v35 in-memory DB with one `parser_bug` `not_found` failure. Assert preview alone leaves DB unchanged; apply creates one active episode without changing `review_class`, `unrescued_at`, `untappd_lookup_count`, or failure; exact retry is no-op; changed reason/evidence is conflict. Assert refusal when card text differs from row/failure, row is linked/retired/repaired, issue moved, alias exists, active key belongs to another row, or lookup/failure state changes after preview. Assert reopen requires new evidence, stamps the same episode once, preserves original fields, and a later new episode can be inserted. Assert failed write leaves no partial episode.

```ts
const preview = previewLegacyOrphanDisposition(db, input);
expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_orphan_dispositions').get()).toEqual({ n: 0 });
expect(applyLegacyOrphanDisposition(db, input, preview)).toMatchObject({ kind: 'applied' });
expect(findActiveDispositionForBeer(db, input.beerId)?.reason).toBe(input.reason);
expect(applyLegacyOrphanDisposition(db, input, preview)).toMatchObject({ kind: 'noop' });
```

- [ ] **Step 2: Run red tests.** `npx vitest run src/domain/dispose-legacy-orphan.test.ts`; expected failure: missing exported functions.
- [ ] **Step 3: Implement validation and previews.** Validate positive safe IDs, ABV in `[0,100]` or explicit `null`, nonempty raw card/reason/operator, HTTP(S) evidence URL, valid UTC timestamp. Activation preview reads orphan plus `enrich_failures` by `beer_id`, demands `untappd_id IS NULL`, `outcome='not_found'`, matching `issue_number`, `retired_at IS NULL`, and exact `cardText` agreement of supplied card with both rows. Read exact `beer_aliases` key and both active indexes; any alias or other active decision is a conflict. Include `beers.abv`, lookup/rearm state, failure class/count/time/source/unlocked/unrescued state, and three reference counts in the preview. Reopen preview reads the active episode by `id` and exposes the **current** row/failure state even if its review or issue changed meanwhile; the active episode, not a possibly reset review row, is the authority for reopening. Do not infer whether identity is unknown from search results; the operator's reason/evidence is the judgement.

```ts
const key = {
  breweryText: cardText(input.cardBrewery),
  nameText: cardText(input.cardName),
  abvKey: cardAbv(input.cardAbv),
};
if (key.breweryText !== cardText(orphan.brewery)
  || key.nameText !== cardText(orphan.name)
  || key.breweryText !== cardText(failure.brewery)
  || key.nameText !== cardText(failure.name)) {
  throw new Error('historical card differs from orphan/failure');
}
```

- [ ] **Step 4: Implement transactionally checked apply/reopen.** `apply` begins a `db.transaction`, handles an existing active episode first: exact same input/evidence/operator/issue/key returns `noop`, anything else throws. Otherwise recompute preview **inside** the transaction, compare every precondition field with the expected preview (including lookup/failure state, alias and active-key state, reference counts), then insert. `reopen` likewise re-previews inside one transaction and updates only `reopened_at`/reopening fields with `WHERE reopened_at IS NULL`; exact same already-closed action is `noop`, conflicting closure is error. Never call `rearmLookup`, set a bid, mutate aliases, or delete the original decision. The caller supplies `expected` from a fresh preview; without it, a new write refuses.

```ts
return db.transaction(() => {
  const current = previewLegacyOrphanDisposition(db, input);
  if (!sameDispositionSnapshot(current, expected)) throw new Error('stale disposition preview');
  const episodeId = insertLegacyDisposition(db, {
    ...input, ...current.key, failureSourceUrl: current.failure.sourceUrl,
    inactiveAt: input.at,
  });
  return { episodeId, kind: 'applied' as const };
})();
```

`sameDispositionSnapshot` compares explicitly declared preview fields (not raw JSON from outside the transaction). The test must mutate each precondition class at least once: issue, card text, lookup counter, failure timestamp, alias, active key, and references. Validation of an identical retry uses the persisted episode, not a caller-provided preview.

```ts
return db.transaction(() => {
  const current = previewLegacyOrphanReopen(db, input);
  if (!sameReopenSnapshot(current, expected)) throw new Error('stale reopen preview');
  if (!closeLegacyDisposition(db, input.episodeId, {
    reopenedAt: input.at, reopeningReason: input.reason,
    reopeningEvidenceUrl: input.evidenceUrl, reopeningOperator: input.operator,
  })) throw new Error('episode is no longer active');
  return { episodeId: input.episodeId, kind: 'reopened' as const };
})();
```

- [ ] **Step 5: Run focused and full gate.** `npx vitest run src/domain/dispose-legacy-orphan.test.ts`; then `npm test && npm run typecheck`. Both must pass.
- [ ] **Step 6: Commit.** `git add src/domain/dispose-legacy-orphan.ts src/domain/dispose-legacy-orphan.test.ts src/storage/legacy-orphan-dispositions.ts && git commit -m "feat: require fresh evidence for inactive orphan decisions"`.

### Task 3: Dry-run-first operator CLI and whole-core review

**Files:** Create `scripts/dispose-legacy-orphan.ts`, `scripts/dispose-legacy-orphan.test.ts`; modify `package.json`.

**Interfaces:** Consumes Task 2 preview/apply/reopen functions. Produces `parseDispositionCliArgs(argv)` and `runDisposeLegacyOrphan(argv, { db, print })`. Command: `npm run dispose-legacy-orphan -- --beer <id> --issue <n> --card-brewery <text> --card-name <text> --card-abv <decimal|absent> --reason <text> --evidence <http(s)-url> --operator <name> [--apply]`; reopen mode: `--reopen <episode-id> --reason ... --evidence ... --operator ... [--apply]`. Modes are mutually exclusive and do not accept extra flags.

- [ ] **Step 1: Write failing CLI tests.** Exercise decimal/absent/zero ABV, missing/duplicate/unknown flags, bad URL and IDs, mutual exclusivity, dry-run no-write, `--apply` write, identical retry, and conflicting retry. Check that apply refuses schema `<35` before writing and that reopening requires `--reopen` plus new reason/evidence. Seed the same in-memory orphan/failure fixture as Task 2.

```ts
await runDisposeLegacyOrphan(args, { db, print: (line) => lines.push(line) });
expect(JSON.parse(lines[0])).toMatchObject({ apply: false, readyToApply: true });
expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_orphan_dispositions').get()).toEqual({ n: 0 });
await runDisposeLegacyOrphan([...args, '--apply'], { db, print: () => {} });
expect(findActiveDispositionForBeer(db, 29955)).not.toBeNull();
```

- [ ] **Step 2: Run red tests.** `npx vitest run scripts/dispose-legacy-orphan.test.ts`; expected failure: missing CLI exports.
- [ ] **Step 3: Implement strict parser and runner using `scripts/repair-legacy-card.ts` conventions.** Parse flags **before** opening production DB or loading config. Parse `--card-abv absent` as `null`, otherwise finite decimal `0..100`; parse IDs as positive safe integers. No network call is needed. Check `MAX(schema_version) >= 35` for apply; dry run can print `readyToApply: false` but must not write. Print the full preview plus operator inputs; apply obtains a fresh preview, prints it, then calls the domain writer with that preview. For identical retries whose row state has already changed only because this command wrote the episode, allow the domain's audited no-op path; do not bypass its conflict checks. Use `loadOperatorEnv`, `loadEnv`, `openDb`, and a `require.main === module` guard like `repair-legacy-card.ts`.

```ts
type CliArgs =
  | { mode: 'activate'; input: Omit<LegacyDispositionInput, 'at'>; apply: boolean }
  | { mode: 'reopen'; input: Omit<LegacyReopenInput, 'at'>; apply: boolean };
// A parser rejects any flag outside its mode's exact set, duplicates and missing values.
// The runner supplies `at: new Date().toISOString()` after parsing, not during preview tests.
```

```ts
const schemaVersion = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as
  { v: number | null }).v ?? 0;
if (args.apply && schemaVersion < 35) throw new Error(`schema v35 required (current v${schemaVersion})`);
const preview = args.mode === 'reopen'
  ? previewLegacyOrphanReopen(db, args.input)
  : previewLegacyOrphanDisposition(db, args.input);
print(JSON.stringify({ ...preview, schemaVersion, readyToApply: schemaVersion >= 35,
  apply: args.apply, reason: args.input.reason, evidenceUrl: args.input.evidenceUrl,
  operator: args.input.operator }, null, 2));
```

Add `"dispose-legacy-orphan": "tsx scripts/dispose-legacy-orphan.ts"` to `package.json` scripts. Do not alter the extension, public API, or runbook in this core plan.

- [ ] **Step 4: Run focused and full gate.** `npx vitest run scripts/dispose-legacy-orphan.test.ts`; then `npm test && npm run typecheck`. Both must pass.
- [ ] **Step 5: Commit and review the whole core.** `git add scripts/dispose-legacy-orphan.ts scripts/dispose-legacy-orphan.test.ts package.json && git commit -m "feat: add dry-run operator control for legacy orphan inactivity"`. Review **all core commits including the already committed design/spec** for data-integrity, stale-preview, manual-reopen, and idempotency failures; fix and rerun the full gate. Only after this whole-core review write the separate periphery plan for enrich pools, client relay, `/match`/MCP, triage, unlock, adoption, and stats. Do not deploy or mark any production row inactive at this checkpoint.

## Coverage check before the next plan

This core plan implements durable episodes, exact-key and per-row readers, operator preview/apply/reopen, evidence/audit, and no automatic reopen **write**. It intentionally does **not** connect the readers to automatic paths. The periphery plan must enumerate each runtime path in the design and prove the old-card/new-card behavior end to end before #695 is shippable. #697 closure gate and #677 per-row dispositions remain later rollout steps.
