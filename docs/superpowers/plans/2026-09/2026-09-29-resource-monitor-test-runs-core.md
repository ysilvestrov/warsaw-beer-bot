# Resource monitor and test supervisor core

> **For agentic workers:** Use superpowers:executing-plans sequentially in this session;
> AGENTS.md maps subagents to sequential work. Track the checkboxes below.

**Goal:** Monitor root resources and contain ordinary Vitest fixtures/cache without unsafe crash deletion.
**Architecture:** Python standard-library monitor and Linux subreaper supervisor; npm remains the test entrypoint.
**Tech Stack:** Python >=3.12, Linux procfs/flock/prctl, Node >=24, Vitest 5, existing Telegram channel.
**Spec:** docs/superpowers/specs/2026-09/2026-09-29-resource-monitor-test-runs-design.md

## Global constraints

- No production stop/restart/deploy or historical deletion.
- No new dependency; no writes to other sessions' checkouts, DB or env.
- Warning >=80% for 900s; critical >=90% or <100000 free; five minute sampling.
- Run dirs 0700; same-boot crashed supervisor is never proof of inactivity.

## Task 1: Test-run ownership and kernel completion

Files: scripts/ops/test_run.py, scripts/ops/test_test_run.py; package.json,
vitest.config.ts. Interfaces: `run(command, base) -> exit_code`,
`inventory(base) -> list[dict]`; CLI `test_run.py [--base PATH] -- COMMAND...`
and `test_run.py --inspect [--base PATH]` (read-only).

- [x] Write process integration tests first: exact child exit 0/7; payload paths/modes;
  concurrent roots; detached child keeps directory until release; SIGINT ->130;
  SIGKILL with surviving child remains retained. Tests own scratch TemporaryDirectory.
- [x] Run `python3 -m unittest discover -s scripts/ops -p test_test_run.py -v`;
  expected missing supervisor failure before implementation.
- [x] Implement private base/root, manifest and lock before spawn; set subreaper;
  inherit only explicit TMP variables + random run marker; reap all children; only
  then check own root identity and use fd-safe no-follow, same-device removal.
- [x] Implement inventory retaining all found roots; exact PID/starttime+boot_id and
  lease distinguishes live/uncertain; observed descendants override dead launcher.
- [x] Change npm test to `python3 scripts/ops/test_run.py -- node node_modules/vitest/vitest.mjs run`;
  put Vite cacheDir under `WBB_TEST_TMPDIR` when supplied. Write a real child Vitest
  cache probe in an isolated config; assert cache inside payload while running and
  entire run root gone after successful and failed assertions.
- [x] Run focused process suite and existing #744 regressions; inspect no owned roots.

## Task 2: Resource transition monitor

Files: scripts/ops/resource_monitor.py, scripts/ops/test_resource_monitor.py,
scripts/ops.test.ts (runs both stdlib unittest suites as part of npm test).
Interfaces: `evaluate(state, sample) -> state`, `tick(state_dir, sample, notify, runs)`;
CLI `resource_monitor.py --state-dir PATH --runs-dir PATH [--notify telegram|none]`.

- [x] Write literal synthetic samples for 79.99/80/89.99/90%, free 99999/100000,
  disk 10/5 GiB, 0/5/10/15 minute waiting; gaps and filesystem changes reset.
- [x] Write tests for at most 864 samples, insufficient/monotone/cleanup forecasts,
  single transition/recovery delivery, failed delivery retry and unchanged crash inventory.
- [x] Run suite RED, then implement statvfs collection, validated bounded state,
  nonblocking flock, atomic state writes, bounded logs and notifier using existing
  read-env/sudo arrangement (no secrets in exceptions, argv or persisted state).
- [x] Run GREEN and `npm test -- scripts/ops.test.ts scripts/test-temp.test.ts && npm run typecheck`.

## Task 3: Core review checkpoint

- [x] Review full diff for supervisor fork/race/signal/failure boundaries and monitor
  acknowledgement/state continuity. Fix verified issues with regression tests.
- [x] Run full `npm test && npm run typecheck`, then commit core.
- [x] Only after this review, write rollout/historical inventory plan.

Core review: inspect Linux waitpid ownership, detached descendant adoption, PID
reuse and interruption; fd-based private staging avoids replacement of foreign
paths. Normal removal is gated by ECHILD; inventory never removes discoveries.
Monitor validates bounds and records samples before retryable acknowledged delivery.
Full root gate: 4202 passed, 1 skipped; extension: 836 passed; both typechecks green.
Python regressions: 23 cases, including exact real transformed-module cache
containment on success/failure. Existing #744 ten regressions remain green.
