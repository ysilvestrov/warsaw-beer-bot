# #695 Inactive Legacy Orphans: Runtime Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. AGENTS.md requires sequential work in the main thread here.

**Goal:** Make every automatic lookup, client request, triage path, and name/bid adoption respect an active #695 disposition while allowing a distinct corrected card to resolve.

**Architecture:** The core v35 episode table and active readers already exist on this branch. SQL readers exclude active `beer_id`s; client routes veto the exact historical card before any write; normalized reuse skips inactive rows. The matcher checks the exact key and does not use inactive catalogue rows. Manual reopen remains the only way to lift the marker, and ordinary response shapes remain unchanged.

**Tech Stack:** TypeScript, Hono, better-sqlite3, Vitest; no extension change or new dependency.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-23-695-inactive-legacy-orphans-design.md`, `spec.md` §3.6.3, and the reviewed core plan `docs/superpowers/plans/2026-09/2026-09-23-695-inactive-legacy-orphans-core.md`.

## Global Constraints

- Work in `design/issue-695-inactive-orphans`; read AGENTS.md, `spec.md`, and the design first. The core commits through `9a556a8` must remain intact.
- Preserve `retired_at`, `unrescued_at`, `review_class`, and the existing API response/status unions. A row-level exclusion uses an active `legacy_orphan_dispositions` episode, never an inferred age/class.
- An exact-card guard uses `cardText` and `cardAbv` including `null`/zero distinction; it runs before `ensureBeerRow` and before a published bid is considered. A different corrected key is not globally banned.
- Use TDD: test, observe red, implement, focused green, `npm test && npm run typecheck`, commit. No production disposition, deployment, issue close, or PR in this plan without the later gates/approval.
- Verify every automatic path after a review reset and after manual reopen. A direct old-client `/enrich/result` must not write a new beer/failure even if it sends a bid.

## File map

| Files | Responsibility |
|---|---|
| `src/storage/beers.ts`, `src/storage/beers.test.ts` | both enrich pools, normalized orphan reuse, bid adoption, matcher catalogue exclusion |
| `src/storage/enrich_failures.ts`, `.test.ts` | triage, ownerless, lock/unlock, issue-count and web-fallback exclusion |
| `src/storage/stats.ts`, `.test.ts` | pending/relay/locked counts agree with active pools |
| `src/domain/dispose-legacy-orphan.ts`, `.test.ts` | bump process-level catalog version after an applied disposition/reopen, not after no-op |
| `src/api/routes/enrich.ts`, `.test.ts` | exact old-card veto and corrected-card continuation |
| `src/domain/match-list.ts`, `.test.ts`; `src/api/routes/match.ts`, `.test.ts`; `src/api/mcp/match-tool.ts`, `.test.ts` | exact-card veto and no inactive catalogue answer for both clients |
| `src/api/routes/merge-alias-loop.test.ts` or a focused new integration test | old/new card end-to-end acceptance |
| `spec.md` | update current pool/matcher/triage descriptions after behavior is implemented |

---

### Task 1: Row-based pools, triage, unlock, and status counts

**Files:** Modify `src/storage/beers.ts`, `src/storage/beers.test.ts`, `src/storage/enrich_failures.ts`, `src/storage/enrich_failures.test.ts`, `src/storage/stats.ts`, `src/storage/stats.test.ts`.

**Interfaces:** Consumes v35 active state. Produces one exported `inactiveLegacyOrphanPredicate` SQL fragment (assumes `beers b` alias) for `listLookupCandidates`, `orphanNotOnTapPredicate`, and stats; other queries use an equivalent `NOT EXISTS` scoped to their `beer_id`. No new job-level branching.

- [ ] **Step 1: Write failing tests.** Seed one active episode on an on-tap orphan and one on a relay orphan, plus otherwise identical live controls. Assert both pool readers omit only active IDs, `orphansRelayQueue`/`orphansPending` omit them, and the controls still appear. Seed a reset `review_class = NULL` active failure: `listUntriagedFailures` must omit it. Assert `listLockedRows`, `listOwnerlessRows`, `countOwnerlessRows`, `countRowsForIssue`, and `isWebFallbackBlocked` do not offer/charge the inactive row; manual reopen restores the ordinary behavior. The direct query, not merely the cron loop, is the contract.

```ts
expect(listLookupCandidates(db, 20, now).map((r) => r.id)).not.toContain(inactiveOnTapId);
expect(listRelayLookupCandidates(db, 20, now).map((r) => r.id)).not.toContain(inactiveRelayId);
expect(listUntriagedFailures(db, 20).map((r) => r.beer_id)).not.toContain(inactiveRelayId);
expect(collectStatus(db, now).orphansRelayQueue).toBe(liveRelayCount);
```

- [ ] **Step 2: Run red tests.** `npx vitest run src/storage/beers.test.ts src/storage/enrich_failures.test.ts src/storage/stats.test.ts`; failures must be the inactive row appearing, not fixture setup.
- [ ] **Step 3: Add SQL exclusion at read boundaries.** Keep both enrich pools a partition of the *active* eligible orphans: use the same row-level condition in the positive on-tap query and shared negative on-tap predicate. Filter triage/unlock/ownerless/issue-count queries by active episode, even if review was reset. `isWebFallbackBlocked` returns true on an active episode independently of failure class; `orphansPending` and `lockedRows` counts exclude it, while historical audit counts (`sealRetiredFalsified`, etc.) keep their existing semantics unless their metric explicitly means an active queue.

```ts
export const inactiveLegacyOrphanPredicate = `EXISTS (
  SELECT 1 FROM legacy_orphan_dispositions lod
  WHERE lod.beer_id = b.id AND lod.reopened_at IS NULL
)`;
// on-tap and relay WHERE clauses each include: AND NOT ${inactiveLegacyOrphanPredicate}
```

For `enrich_failures ef` queries, use `AND NOT EXISTS (SELECT 1 FROM legacy_orphan_dispositions lod WHERE lod.beer_id = ef.beer_id AND lod.reopened_at IS NULL)`. Do not clear existing failure rows or backoff. Keep `lockedRowPredicate` unchanged: it represents issue locks, not the separate inactive state.

- [ ] **Step 4: Run focused/full gate, commit.** `npx vitest run src/storage/beers.test.ts src/storage/enrich_failures.test.ts src/storage/stats.test.ts`, then `npm test && npm run typecheck`; commit only these files with `git commit -m "fix: exclude inactive legacy orphans from automatic queues"`.

### Task 2: Prevent automatic adoption and refresh the matcher catalogue

**Files:** Modify `src/storage/beers.ts`, `src/storage/beers.test.ts`, `src/domain/dispose-legacy-orphan.ts`, `src/domain/dispose-legacy-orphan.test.ts`, `src/domain/catalog-cache.test.ts` only if its existing test seam needs an assertion. `src/domain/catalog-cache.ts` should not change: its existing `loadCatalog` and version-invalidation contract is sufficient.

**Interfaces:** Consumes Task 1 `inactiveLegacyOrphanPredicate` and core `findActiveDispositionForBeer`. Produces changed behavior of existing `ensureOrphan`, `resolvableOrphan`/`upsertBeerByBid`, and `loadCatalog`: none may select an inactive orphan. The domain command calls existing `bumpCatalogVersion()` after a successful transaction so a stale cached catalogue is rebuilt; no-op does not bump.

- [ ] **Step 1: Write failing tests.** With a same-normalized-pair inactive orphan, `ensureOrphan` must return a *different* ID. `upsertBeerByBid` for a compatible name/bid must create/use another row without setting a bid on the inactive one. `loadCatalog` must omit the inactive orphan but leave ordinary orphans and linked rows visible. A cache created before activation must eventually exclude the row after `applyLegacyOrphanDisposition`; reopening makes it eligible again after refresh. Assert no-op leaves the catalogue version unchanged.

```ts
const newId = ensureOrphan(db, {
  brewery: 'De Cam', name: 'Abrikoos 2018', abv: 7,
  normalized_brewery: 'de cam', normalized_name: 'abrikoos',
});
expect(newId).not.toBe(inactiveBeerId);
expect(db.prepare('SELECT untappd_id FROM beers WHERE id = ?').get(inactiveBeerId))
  .toEqual({ untappd_id: null });
expect(loadCatalog(db).map((r) => r.id)).not.toContain(inactiveBeerId);
```

- [ ] **Step 2: Run red tests.** `npx vitest run src/storage/beers.test.ts src/domain/dispose-legacy-orphan.test.ts src/domain/catalog-cache.test.ts`; failures must identify adoption/catalog leakage.
- [ ] **Step 3: Add the exclusions and cache bump.** Add `NOT EXISTS active disposition` to the `resolvableOrphan` and `ensureOrphan` orphan scans and `loadCatalog`. In `applyLegacyOrphanDisposition` and `applyLegacyOrphanReopen`, store the transaction result, call `bumpCatalogVersion()` only when `kind` is `applied`/`reopened`, then return it. Do not bump inside the transaction or on `noop`; do not change `upsertBeerByBid` provenance rules.

```ts
if (result.kind === 'applied') bumpCatalogVersion();
return result;
```

The callback runs after commit. A no-op or thrown transaction leaves the cache version unchanged. The cache's stale-while-revalidate behavior means one request may still see an old snapshot; Task 4's live row veto must prevent it from returning the inactive row.

- [ ] **Step 4: Run focused/full gate, commit.** `npx vitest run src/storage/beers.test.ts src/domain/dispose-legacy-orphan.test.ts src/domain/catalog-cache.test.ts`, then `npm test && npm run typecheck`; commit the files touched by this task with `git commit -m "fix: prevent inactive orphan adoption and cache reuse"`.

### Task 3: Exact-card guard for old extension requests

**Files:** Modify `src/api/routes/enrich.ts`, `src/api/routes/enrich.test.ts`; add a focused old/new-card route integration test in the same test file or `src/api/routes/merge-alias-loop.test.ts`.

**Interfaces:** Consumes core `findActiveDispositionForCard` and Task 2's adoption exclusions. No new response fields/status values. Both route handlers check the exact key **before** `ensureBeerRow`; `ensureBeerRow` excludes active IDs from `listBeersByNormalized` candidates for a distinct corrected card.

- [ ] **Step 1: Write failing route tests.** Seed active disposition, call `/enrich/candidates` with old card and assert `eligible:false` and unchanged `beers`, `enrich_failures`, lookup counters, and episode. Call `/enrich/result` directly with the same card and a valid published `bid`; assert `{status:'not_found'}` and no hydration/lookup/write. Repeat after review reset and with a client that skipped candidates. Call with corrected name or ABV-only new key: assert it can create/use a different live row, become eligible, and follow normal bid/search resolution; the inactive ID remains untouched. Reopen and assert the old card follows normal eligibility again.

```ts
const before = db.prepare('SELECT COUNT(*) AS n FROM beers').get();
const response = await app.request('/enrich/result', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ brewery: 'De Cam', name: 'Abrikoos 2018', abv: 6,
    algolia: { hits: [] }, bid: 3615616, pageUrl: 'https://flasker.com.ua/' }),
});
expect(await response.json()).toEqual({ status: 'not_found' });
expect(db.prepare('SELECT COUNT(*) AS n FROM beers').get()).toEqual(before);
```

- [ ] **Step 2: Run red tests.** `npx vitest run src/api/routes/enrich.test.ts src/api/routes/merge-alias-loop.test.ts`; expected: old card is still eligible or directly writes, and corrected card reuses inactive row.
- [ ] **Step 3: Guard before mutation.** In candidates, return the existing candidate shape with `eligible:false` and the normal `algolia`/optional `algoliaNarrow` fields for an exact active key; do not call `ensureBeerRow`. In result, return `c.json({status:'not_found'})` before bid hydration or lookup. Filter only active orphan IDs in `ensureBeerRow`'s normalized candidate list; leave linked rows and aliases unchanged. The `ensureOrphan` exclusion from Task 2 covers its fallback. `findActiveDispositionForCard` uses the raw submitted ABV (`null` for absent), not `row.abv`.

```ts
if (findActiveDispositionForCard(deps.db, b.brewery, b.name, b.abv ?? null)) {
  return { brewery: b.brewery, name: b.name, eligible: false,
    algolia: algoliaQuery(deps, searchQueryLadder(b.brewery, b.name).at(-1)!) };
}
// This branch is before ensureBeerRow and before resolveByBid.
```

- [ ] **Step 4: Run focused/full gate, commit.** `npx vitest run src/api/routes/enrich.test.ts src/api/routes/merge-alias-loop.test.ts`, then `npm test && npm run typecheck`; commit with `git commit -m "fix: ignore sealed historical shop cards in relay enrichment"`.

### Task 4: `/match` and MCP veto, cross-path acceptance, whole-branch review

**Files:** Modify `src/domain/match-list.ts`, `src/domain/match-list.test.ts`, `src/api/routes/match.ts`, `src/api/routes/match.test.ts`, `src/api/mcp/match-tool.ts`, `src/api/mcp/match-tool.test.ts`, `spec.md`; add/extend one route-level acceptance test if needed. No new endpoint or public status.

**Interfaces:** Add optional `isInactiveCard?: (item: MatchInput) => boolean` and `isInactiveBeerId?: (id: number) => boolean` to `MatchListOptions`. Route/MCP closures call core `findActiveDispositionForCard`/`findActiveDispositionForBeer` against the live DB. Existing callers without callbacks retain current behavior. The matcher returns the existing null result shape (`matched_beer:null`, `source:null`, no personal rating) for an exact inactive card or an inactive matched ID from a stale cache.

- [ ] **Step 1: Write failing tests.** With a cached catalog built before disposition, the same old card must return no match even if it carries a published bid; no inactive beer ID may escape from the stale cache. A distinct corrected card may match a live linked row; after cache rebuild the inactive row is absent. MCP `runMatchTool` must use the same veto. Manual reopen restores normal matchability after cache refresh. Assert the public result fields/status union remain unchanged.

```ts
expect(oldCardResult.matched_beer).toBeNull();
expect(oldCardResult.source).toBeNull();
expect(newCardResult.matched_beer?.id).toBe(liveBeerId);
expect(mcp.output.results[0].beer).toBeNull();
```

- [ ] **Step 2: Run red tests.** `npx vitest run src/domain/match-list.test.ts src/api/routes/match.test.ts src/api/mcp/match-tool.test.ts`; expected: matcher returns an inactive row or accepts the old published bid.
- [ ] **Step 3: Add live veto without changing other matching rules.** At the top of `matchBeerList`'s item loop, check `isInactiveCard` before bid/alias/matcher; push the existing null-result shape and continue. Before returning any matched candidate, check `isInactiveBeerId`; convert that result to the same null shape. `/match` and MCP supply callbacks, not a stale copy from `CatalogCache`. Use `searched:true` for a deliberately excluded exact key: the active catalogue was checked and no match is allowed, so MCP's existing `not_in_catalog` status applies; do not invent a new public status. On cache revalidation, `loadCatalog` from Task 2 omits the inactive row.

```ts
const inactive = (item: MatchInput) =>
  findActiveDispositionForCard(db, item.brewery, item.name, item.abv ?? null) !== null;
const inactiveId = (id: number) => findActiveDispositionForBeer(db, id) !== null;
const options = { aliases, byUntappdId, isInactiveCard: inactive, isInactiveBeerId: inactiveId };
const outcome = await matchBeerList(prepared, byId, drunkSet, ratings, beers, options);
```

- [ ] **Step 4: Full acceptance and specification check.** Exercise old card `/match` → `/enrich/candidates` → direct `/enrich/result` and corrected card through the same sequence; assert no active duplicate/triage for old input, normal corrected resolution, no automatic reopen on review reset or issue-close job, and manual reopen changes only the episode. Update `spec.md` wording for the now-deployed exclusions. Run `npm test && npm run typecheck`, `git diff --check`, and review the whole branch from `902e52b` for stale cache, ABV-key collisions, issue-closure, audit loss, and unrelated edits. Commit with `git commit -m "fix: keep sealed cards out of matching and complete #695"`. Do not apply a production disposition until a copy-of-production rehearsal and individual evidence review under the rollout plan.

## Completion boundary

After Task 4 the #695 feature is locally implemented, but no #677 row has been classified. Ask whether to create a PR; if yes, fetch/rebase `main`, rerun the full gate, push and wait for CI/AI review. Deployment and the #697 close-out gate remain separate steps. An unknown-identity verdict requires card/ABV provenance and a row-specific investigation; the eight #677 `unrescued` search results do not establish it.
