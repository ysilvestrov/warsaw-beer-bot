# #666 Extension Orphan Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cached catalogue orphans remain eligible for client enrichment, and a successful enrichment persists across reloads.

**Architecture:** Keep cache lookup and enrichment queue separate in `runOverlay`. Carry the original match result to `enrichOrphans`, which is the sole place that translates enrichment events and can persist the confirmed result.

**Tech Stack:** TypeScript, Vitest, Chrome storage cache.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-20-666-extension-orphan-cache-design.md`

## Global Constraints

- Preserve the server-owned eligibility and backoff rules.
- Cache only a server-confirmed `found` identity from enrichment.
- Keep user-facing extension copy in `extension/CHANGELOG.md` and the Ukrainian install guide current.

---

### Task 1: Queue cached catalogue orphans

**Files:**
- Modify: `extension/src/content/index.ts`
- Test: `extension/src/content/index.test.ts`

- [ ] Add a failing test for a cached `MatchResult` with `matched_beer.untappd_id === null`: `/match` is not called and `enrich` receives the card plus its original result.
- [ ] Run `npm --prefix extension test -- src/content/index.test.ts` and observe that the callback is not called.
- [ ] Extract the existing orphan eligibility predicate so cache-hit and fresh `/match` candidates apply the identical drunk/uncertain/bid rules.
- [ ] Build the unified orphan callback payload from both cache hits and fresh results; do not return early when only cache-hit orphans exist.
- [ ] Re-run the focused test and commit the task.

### Task 2: Persist only successful enrichment

**Files:**
- Modify: `extension/src/content/index.ts`
- Modify: `extension/src/content/main.ts`
- Test: `extension/src/content/index.test.ts`
- Test: `extension/src/content/main.test.ts`

- [ ] Add failing integration coverage: a `found` event updates the cached original result with its Untappd id and global rating; a later overlay uses that result without `/match` or enrichment.
- [ ] Add failing coverage that `blocked` leaves the cache orphan eligible on the next overlay.
- [ ] Run the focused extension tests and observe both failures.
- [ ] Carry the full original `MatchResult` in the orphan payload and conditionally write only in `main.ts`'s `found` event through the service worker's serialized cache queue, preserving all non-identity fields and refusing a stale write after a newer refresh.
- [ ] Re-run focused tests, then `npm --prefix extension test` and `npm --prefix extension run typecheck`.

### Task 3: Explain the visible fix

**Files:**
- Modify: `extension/CHANGELOG.md`
- Modify: `docs/extension-install-uk.md`

- [ ] Add one user-facing Unreleased entry: previously delayed or temporarily failed missing-beer checks can resume after reload, and a found beer keeps its rating.
- [ ] Amend the guide's reload instruction to say that cards left past the per-page limit resume on a reload.
- [ ] Run the root full gate: `npm test && npm run typecheck`.
