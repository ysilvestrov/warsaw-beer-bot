# Test temporary cleanup implementation plan

> Execution: inline in the main thread per AGENTS.md tool mapping.

**Goal:** stop ordinary successful/failed test runs leaking temporary directories.
**Architecture:** explicit per-file allocation registry with root afterAll ownership;
no machine-wide prefix deletion from test code.
**Stack:** Node.js fs, Vitest; existing dependencies only.
**Spec:** docs/superpowers/specs/2026-09/2026-09-29-test-temp-cleanup-design.md

## Core (review before peripheral migrations)

- [x] Add `scripts/test-temp.ts` exporting `makeTempDirectory(prefix): string`.
  Register a path immediately after mkdtempSync(join(tmpdir(), prefix)); root afterAll
  removes only registered paths with rmSync and aggregates cleanup failures.
  Runner onAfterRunFiles fallback covers collection failure and retries paths
  retained after failed hooks. No exit listener; SIGKILL remains outside this guarantee.
- [x] Add child-Vitest regression in `scripts/test-temp.test.ts`: private TMPDIR,
  passing and failing fixture runs, exact status and `readdirSync(root) === []`.
  Include hook setup failure and shared fixture lifetime. Red before helper.
- [x] Review registry ownership/error propagation, run focused tests/typecheck.

## Periphery after core review

Create separate plan after core verification, covering all observed leaky allocation
sites (autodeploy and verify-corpus, set-env, AI review symlink, auth bootstrap).
Keep registered fixtures through root afterAll, preserving the existing shared lifetime.
Then run focused historical replay under private TMPDIR, full gate only after
inode relief, review, fetch/rebase, full gate, push PR, wait for reviews/checks.

## Operational work

Frozen allowlist + identity/fingerprint verification; exclude protected/special
files, foreign ownership/device and unknown fixture shapes. Exclude active tests,
cwd/fd/maps references; new runs allocate different mkdtemp names. Delete in small
batches only after activity can be separated; pause on changed candidates or health.
Record before/after, retained uncertainty, SIGKILL policy and alert threshold in
inode-cleanup-report.md. Never deploy the code during this task.

## Review follow-up

- [x] Add a worker-local callback registry and TestRunner subclass configured in
  vitest.config.ts. AfterAll cleans ordinary fixtures; runner drains remaining
  callbacks even after collection failure, reports every permanent failed path,
  and detaches callbacks after its final attempt. Preserve built-in runner cleanup.
- [x] Child configurations use the same runner; prove failed collection, transient
  cleanup recovery, permanent error diagnostics and reused-worker collection runs.
- [ ] Full gate, commit/push, reply to AI feedback, await new CI/review.
