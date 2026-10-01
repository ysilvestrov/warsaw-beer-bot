# #750 Managed Test Invocation Documentation and Shipping Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Execute sequentially in the main thread per AGENTS.md.

**Goal:** Document the verified supervisor requirement and publish a reviewed implementation PR.

**Architecture:** Core guard and real-process regressions already passed the whole-core review in the core plan. This phase makes the invocation policy visible in spec and developer instructions, then ships the same change through existing review gates.

**Tech Stack:** Markdown developer instructions; Git/GitHub; existing Claude cross-review CLI.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-01-750-managed-test-invocation-design.md`

## Global Constraints

- No new dependencies, production changes, host installation or automatic historical deletion.
- Guard covers repository configs; the marker is not authentication.
- No extension user-visible effect; no changelog entry or store submission.
- PR uses `Refs #750`; no automatic close before operational closeout.

## Task 1: Document the supported invocation

**Files:** `spec.md`, `README.md`, `AGENTS.md`, `CLAUDE.md`.

- [x] Extend spec section 5.3 with: root and extension repository configs reject missing/empty supervisor context before workers start; use `npm test -- <arguments>` or installed `wbb-test <arguments>`. Explicit external override configs are outside this boundary.
- [x] Add developer README instructions for focused suites and the server-local wrapper. State direct `npx vitest`/`node ...vitest.mjs` using repository configs are rejected.
- [x] Add a short test-invocation instruction next to Testing in both agent instruction files. Explain never inventing `WBB_TEST_TMPDIR` manually: marker publication and cleanup belong to the supervisor.
- [x] Run `git diff --check` and compare prose to approved design/core evidence; commit only these docs and this plan.

## Task 2: Publish and verify the PR

- [ ] Fetch origin/main; rebase if it moved. Re-run full root gate after any rebase.
- [ ] Run `npm run cross-review -- --reviewer claude` without a short process timeout (script permits up to 15 minutes). Check each finding against source, fix valid findings or reject with evidence; re-run full gate after code fixes.
- [ ] Write a concise PR description documenting demonstrated direct rejection and managed cleanup, original manifest cleanup, and residual operational boundaries. Include the required Cross-review marker.
- [ ] Verify branch/remote/no existing matching PR, push and create the PR by default.
- [ ] Wait for current-head GitHub checks and review, resolve technically valid feedback and verify any follow-up push. Do not merge on the user's behalf.
- [ ] Record PR/evidence in #750. Keep the issue open for merge/checkout update and residual cache audit; preserve unmerged worktree and operational evidence.

## Cross-review and final local gate — 2026-10-01

Claude @ bcd72e0 raised one finding: the extension probe observed managed temp cleanup but did not prove its stated cache-routing claim. Accepted and fixed: it now observes a real typed module transformation inside the payload and asserts the exported Vite/module cache paths against the documented payload locations. Mutation deleting those paths fails; restored code passes. Repeated full root gate: 4,712 passed, one existing skip, both typechecks pass. Extension's unchanged configuration previously passed all 836 tests and its typecheck. Cross-review runs once per PR as required; the receipt is 1 finding fixed, 0 rejected.

A separate read-only bounded operational audit found 161 residual source-confirmed caches (2,670 inodes, 82,231,296 allocated bytes), with a new exact manifest and fresh identity/digest verification. 281 roots lack repository provenance and remain outside that proposal. Neither set was deleted by this code work.
