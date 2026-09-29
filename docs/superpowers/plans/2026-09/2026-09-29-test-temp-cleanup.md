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
  Worker exit fallback covers collection failure that skips hooks; normal teardown
  removes the exit listener. SIGKILL remains outside this guarantee.
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
