# #696 Legacy Shop-Card Repair Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This project's agent instructions require sequential work in the main thread; do not dispatch subagents.

**Goal:** Make one proven legacy shop card repairable as an atomic, audited database operation without guessing a bid or changing another card's alias.

**Architecture:** A v34 audit table retains the decision after the orphan is deleted. A domain operation takes a hydrated exact bid and explicit historical card evidence, previews all writes, then rechecks the same row and alias inside a transaction before creating or finding the canonical row, merging references, writing the exact alias and audit event. The operator CLI, route-level tests, production-copy rehearsal, and runbook are periphery planned only after a whole-branch review of this core.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, SQLite migrations.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-23-696-legacy-shop-card-repair-design.md`

## Global Constraints

- `spec.md` is authoritative; update §3.6.1 and the schema-version table before implementation.
- Node is `>=24`; use existing dependencies, `cardText`, `cardAbv`, and `mergeIntoCanonical` conventions.
- The card-to-product-to-bid proof, exact historical card ABV, evidence URL, operator, and reason are mandatory; a search candidate is not proof.
- ABV divergence needs `--overwrite-abv`; the alias keeps the historical card ABV, the catalog receives hydrated Untappd ABV, and the audit records both.
- One row at a time, no production writes during this plan; `#677` retains its `orphan-triage` label.
- Follow TDD. After each task run `npm test && npm run typecheck`, then commit only that task's files.
- This core has two tasks. Conduct a whole-branch code review after Task 2, then write a separate periphery plan for CLI, route tests, rehearsal, and docs, per `AGENTS.md`.

## File map

| File | Responsibility |
|---|---|
| `src/storage/schema.ts`, `src/storage/schema.test.ts` | v34 durable repair audit, constraints and migration tests |
| `spec.md` | normative state and alias-writing semantics |
| `src/domain/repair-legacy-card.ts`, `src/domain/repair-legacy-card.test.ts` | preview, fresh precondition checks, atomic repair, focused tests |
| `src/storage/beers.ts` | preserve `untappd_had` on this merge and avoid a pre-commit cache bump |

---

### Task 1: Audit schema and normative semantics

**Files:**
- Modify: `src/storage/schema.ts` after v33
- Modify: `src/storage/schema.test.ts`
- Modify: `spec.md` §3.6.1 and schema-version table

**Interfaces:**
- Produces table `legacy_card_repairs`, unique `orphan_beer_id`, and fields named below. Task 2 writes exactly one event per repaired orphan.

- [ ] **Step 1: Write a failing migration test.** In `src/storage/schema.test.ts`, add a `describe('v34 legacy_card_repairs (#696)')` with an in-memory migrated DB. Assert `PRAGMA table_info(legacy_card_repairs)` contains every column below, `schema_version` max is 34, a complete event can be inserted, and a second event with the same `orphan_beer_id` fails. Also assert empty `reason`, `operator`, `evidence_url`, or raw brewery/name and `overwrite_abv = 2` fail their CHECK constraints. Neither local ID has an FK: the orphan is deleted by this repair, and the canonical may later be replaced. Change existing `schema.test.ts` assertions of latest version 33 at lines near 540 and 589 to 34; leave migration-specific v33 tests intact.
- [ ] **Step 2: Run `npx vitest run src/storage/schema.test.ts`.** Expect the new test to fail because the table is absent.
- [ ] **Step 3: Add v34 to `MIGRATIONS` in `src/storage/schema.ts`.** Use this exact schema, adjusting only formatting to match the file:

```sql
CREATE TABLE legacy_card_repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orphan_beer_id INTEGER NOT NULL UNIQUE,
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  card_brewery TEXT NOT NULL CHECK (length(trim(card_brewery)) > 0),
  card_name TEXT NOT NULL CHECK (length(trim(card_name)) > 0),
  card_abv REAL,
  failure_source_url TEXT NOT NULL,
  target_bid INTEGER NOT NULL CHECK (target_bid > 0),
  canonical_beer_id INTEGER NOT NULL,
  evidence_url TEXT NOT NULL CHECK (length(trim(evidence_url)) > 0),
  operator TEXT NOT NULL CHECK (length(trim(operator)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  overwrite_abv INTEGER NOT NULL CHECK (overwrite_abv IN (0, 1)),
  prior_canonical_abv REAL,
  final_canonical_abv REAL,
  applied_at TEXT NOT NULL
);
CREATE INDEX idx_legacy_card_repairs_issue ON legacy_card_repairs(issue_number);
```

- [ ] **Step 4: Update `spec.md`.** Add §3.6.2 defining the audit table and the manual repair's proof, preview, fresh-row/alias recheck, ABV override, transaction, refusal and idempotence rules. Amend §3.6.1's “only `mergeIntoCanonical` creates an alias” statement to include the manual #696 operation and state that it refuses an alias already pointing to another bid, unlike ordinary automatic alias movement. Add v34 to the migration table, without changing the meanings of `retired_at` or `unrescued_at`.
- [ ] **Step 5: Run `npx vitest run src/storage/schema.test.ts`, then `npm test && npm run typecheck`.** Both must pass. Stage only the three Task 1 files and commit `feat: record legacy shop-card repairs durably`.

### Task 2: Atomic preview and repair domain operation

**Files:**
- Create: `src/domain/repair-legacy-card.ts`
- Create: `src/domain/repair-legacy-card.test.ts`
- Modify: `src/storage/beers.ts`
- Test: existing `src/storage/beers.test.ts` if the shared merge needs direct regression coverage

**Interfaces:**
- Consumes: v34 `legacy_card_repairs`; `HydratedBeer` from `src/sources/untappd/search.ts`; `cardText` and `cardAbv` from `src/domain/card-text.ts`; `mergeIntoCanonical` from `src/storage/beers.ts`.
- Produces:

```ts
export interface LegacyCardRepairInput {
  beerId: number;
  issueNumber: number;
  cardAbv: number | null;
  bid: number;
  evidenceUrl: string;
  operator: string;
  reason: string;
  overwriteAbv: boolean;
  hydrated: HydratedBeer;
  at: string;
}
export interface LegacyCardRepairPreview {
  orphan: {
    id: number; brewery: string; name: string; storedAbv: number | null;
    lookupAt: string | null; lookupCount: number; rearmCount: number;
  };
  failure: {
    issueNumber: number; sourceUrl: string; reviewClass: string | null; outcome: string;
    retiredAt: string | null; unrescuedAt: string | null; unlockedAt: string | null;
  };
  aliasKey: { breweryText: string; nameText: string; abvKey: string };
  aliasTargetBid: number | null;
  canonical: { id: number; abv: number | null } | null;
  hydrated: HydratedBeer;
  referenceCounts: { matchLinks: number; checkins: number; untappdHad: number };
  overwriteAbv: boolean;
}
export function previewLegacyCardRepair(db: DB, input: LegacyCardRepairInput): LegacyCardRepairPreview;
export function applyLegacyCardRepair(
  db: DB, input: LegacyCardRepairInput, expected: LegacyCardRepairPreview,
): { canonicalId: number; kind: 'merged' | 'created' | 'noop' };
```

- [ ] **Step 1: Write failing domain tests with `openDb(':memory:')` and `migrate(db)`.** Seed an orphan with `enrich_failures.issue_number = 677`, a hydrated `HydratedBeer` for the exact bid, and a proof URL/reason/operator. Cover: existing canonical bid; absent bid (new canonical must be inserted directly and never adopt a same-normalized-name third orphan); old-card `6` alias while canonical becomes hydrated `7` only with `overwriteAbv: true`; no override on equal ABV; reject meaningless override; reject missing/nonmatching hydration; reject alias to different bid without any writes; stale issue, lookup state, card text/ABV, retired marker, missing failure, already-linked beer; preserve and deduplicate `untappd_had` by latest `last_seen_at`; redirect match links and checkins; audit survives orphan deletion; repeat the same completed repair returns `noop`, changed inputs on repeat fail. Check exact aliases through `findAliasTarget(db, brewery, name, cardAbv)` from `src/storage/beers.ts`, and call `PRAGMA foreign_key_check` after successful merges.
- [ ] **Step 2: Run `npx vitest run src/domain/repair-legacy-card.test.ts`.** Expect missing exports.
- [ ] **Step 3: Implement input and preview validation.** Require positive integer IDs, finite `cardAbv` or explicit `null`, nonempty reason/operator, valid HTTP(S) evidence URL, `hydrated.bid === input.bid`, and nonempty hydrated name/brewery. Read the orphan and its failure by ID; require `untappd_id IS NULL`, the specified issue, `outcome = 'not_found'`, and no retirement marker. Read the exact alias key, canonical by bid, existing audit event, and three reference counts. Reject an alias whose joined target `untappd_id` differs from `input.bid`. Compare non-null historical card and existing canonical ABVs with `hydrated.abv`; require `overwriteAbv` on a difference, reject the flag when no difference, and reject a conflict with no hydrated ABV. Return the full preview without writing; do not infer historical card ABV from `beers.abv`.
- [ ] **Step 4: Implement apply using a fresh in-transaction preview and immutable snapshot comparison.** The CLI will hydrate before calling apply; this function must not access the network. First check the unique audit event: if the orphan is already gone, return `noop` only when that event matches the issue, exact old card, bid, evidence URL, reason, operator, override and final ABV *and* the live alias still points to the bid; otherwise fail closed. For a live orphan, in one `db.transaction`, re-read its brewery/name/stored ABV and lookup counters, failure issue/outcome/`review_class`/`retired_at`/`unrescued_at`/`unlocked_at`, the alias target, and canonical ID/ABV. Reject movement since the displayed `expected` preview; compare these fields explicitly rather than JSON-stringifying the entire object. Do not accept a fresh hydration result different from the one previewed. Call no network method in this function.
- [ ] **Step 5: Create or find the canonical row without heuristic adoption.** For an absent bid, insert directly into `beers` using hydrated `beer_name`, `brewery_name`, `style`, `abv`, `global_rating`, `normalizeName(beer_name)`, and `normalizeBrewery(brewery_name)` from `src/domain/normalize.ts`; set `untappd_id_source = 'curated'`. For an existing bid, preserve its name/brewery and stronger provenance, fill absent style/rating, and set `abv = hydrated.abv` only when the explicit override applies; if its ABV is null, fill it from hydration. Do not call `upsertBeerByBid` (it may adopt a different orphan).
- [ ] **Step 6: Merge and audit atomically.** Before deleting the orphan, upsert its `untappd_had` references into the canonical `(telegram_id, beer_id)` keys, retaining `MAX(last_seen_at)` on collision. Use `mergeIntoCanonical` for match links/checkins and deletion; pass an explicit `AliasCard` with the old raw brewery/name and proved card ABV so it creates the historical key. Recheck alias collision immediately before calling it, because its default `ON CONFLICT` would otherwise move another bid's key. Insert one `legacy_card_repairs` event in the same outer transaction. Ensure catalog cache version bumps only after the outer transaction commits: add an optional `bumpVersion = true` parameter to `mergeIntoCanonical`, pass `false` here, and bump once after commit. A thrown constraint/error must leave all DB state unchanged.
- [ ] **Step 7: Run `npx vitest run src/domain/repair-legacy-card.test.ts src/storage/beers.test.ts`, then `npm test && npm run typecheck`.** Both must pass. Stage only Task 2 files and commit `feat: atomically repair proven legacy shop cards`.

## Whole-branch review gate

Review the Task 1–2 diff against the approved #696 design and `spec.md`, especially the audit's survival, concurrent/stale-row refusal, exact card ABV, alias collision, `untappd_had` preservation, and cache bump timing. Resolve findings and rerun `npm test && npm run typecheck`. Only then write the separate periphery plan for the CLI, route-level old/new client tests, production-copy dry run, and operator documentation. No production repair or #677 closure belongs to this core plan.
