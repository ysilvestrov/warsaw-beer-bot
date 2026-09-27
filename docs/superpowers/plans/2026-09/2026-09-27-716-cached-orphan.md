# #716 Cached Orphan Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep newly linked beers from becoming eight-hour search badges.

**Architecture:** `/match` waits for catalog rebuilds after a version change.
`/enrich/candidates` marks an already linked, ineligible row so the extension
can recheck it via `/match` and conditionally replace its cached orphan.

**Tech Stack:** TypeScript, Hono, SQLite, Vitest, MV3 extension.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-27-716-cached-orphan-design.md`

## Global Constraints

- Keep existing API fields and old extension clients working.
- Do not expose auth tokens or personal data in tests or logs.
- Do not alter backoff, search budget, or published bid repair behavior.

## Task 1: Fresh catalog after a version change

- [ ] Update the existing catalog cache test: first `get()` after a version bump must return the new catalog; a TTL-only expiry still serves stale once.
- [ ] Run the test red, update `CatalogCache.get()` with a single-flight read barrier on version changes, and run it green.
- [ ] Update the cache contract in `spec.md` and run server tests/typecheck.

## Task 2: Linked candidate signal

- [ ] Add route tests for linked, orphan-backoff, active disposition and contradictory-bid candidates.
- [ ] Run red, add an optional `linked` response field only when a selected row is safely linked, then run green.
- [ ] Document the additive response field in `spec.md` and run server tests/typecheck.

## Task 3: Extension cache recovery

- [ ] Add a failing content test: a cached orphan gets `linked: true`, `/match` returns a linked result, the cache and badge become found; a following page load stays found.
- [ ] Add tests for a failed/short recheck and a concurrent cache replacement.
- [ ] Batch linked rechecks, reuse the existing `/match` bridge and conditional cache write, and keep old `linked`-absent responses unchanged.
- [ ] Update the extension changelog and install guide if needed; run extension tests/typecheck.

## Task 4: Whole-branch gate and review

- [ ] Run `npm test && npm run typecheck` and extension `npm test && npm run typecheck`.
- [ ] Review the diff for API compatibility, stale writes, and scope; fix valid findings.
- [ ] Commit only task-owned files and ask whether to open a PR, per `AGENTS.md`.
