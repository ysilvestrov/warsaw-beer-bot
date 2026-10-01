# #750 Managed Test Invocation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execute sequentially in the main thread per AGENTS.md tool mapping.

**Goal:** Reject direct root/extension Vitest launches before workers can leave unmanaged transformation caches.

**Architecture:** Both existing Vitest configs require the existing WBB_TEST_TMPDIR invocation marker. The existing Linux Python supervisor continues to own run creation, environment publication, descendant supervision and cleanup. No second launcher, sweeper or authentication mechanism is introduced.

**Tech Stack:** TypeScript/Vitest 5, Python 3.12+ unittest and subprocess.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-01-750-managed-test-invocation-design.md`

## Global Constraints

- Linux/Python 3.12+ supervisor; preserve managed exit codes and nested child invocations.
- No new dependencies or production runtime changes.
- Missing or empty `WBB_TEST_TMPDIR` is a startup error.
- Marker is an invocation convention, not an authentication credential.
- External replacement configs and old checkouts remain outside enforcement.
- No deletion outside an explicitly approved historical manifest.
- Root and extension user behavior is unchanged; no extension changelog entry.

## Task 1: Guard both configs with real subprocess regressions

**Files:** Modify `scripts/ops/test_test_run.py`, `vitest.config.ts`, `extension/vitest.config.ts`.

**Interfaces:** Consume `WBB_TEST_TMPDIR` from `scripts/ops/test_run.py`; produce a startup error containing the following exact message when the marker is absent or empty:

```text
Vitest requires the test supervisor to clean temporary caches. Run npm test -- <arguments> (from the package directory), or wbb-test <arguments> on the operator host.
```

- [ ] Add a Python integration test to existing `TestRun`. For both root/extension and missing/empty marker cases, create a private fallback temp dir and a probe config importing that package's real config. Include a one-test typed fixture which writes a suite-execution sentinel. Remove `WBB_TEST_TMPDIR`/`WBB_TEST_RUN_ID` from the child environment; set the empty case explicitly. Run the real Vitest CLI with `--cache=false` and assert `returncode == 1`, the exact guard message, sentinel absence and `list(fallback.iterdir()) == []`. The intended red result is returncode 0 and a cache directory, not a missing executable.
- [ ] Add a managed extension regression: run `npm test -- src/manifest.test.ts --cache=false` with a dedicated `WBB_TEST_RUNS_DIR` and fallback temp directory. Assert `returncode == 0`, that the named suite ran, empty managed base and empty fallback. Existing root real-transformation success/failure coverage stays intact.
- [ ] Run the new direct test via `PYTHONPATH=scripts/ops python3 -B -m unittest test_test_run.TestRun.test_direct_vitest_requires_supervisor_before_workers` and observe red in both packages.
- [ ] In each config, immediately after reading `WBB_TEST_TMPDIR`, add exactly:

```ts
if (!testTmp) {
  throw new Error('Vitest requires the test supervisor to clean temporary caches. Run npm test -- <arguments> (from the package directory), or wbb-test <arguments> on the operator host.');
}
```

- [ ] Replace optional cache routing in each config with `cacheDir: join(testTmp, 'vite-cache')` and `fsModuleCachePath: join(testTmp, 'vitest-module-cache')`.
- [ ] Run direct rejection, managed extension and existing root real-transformation success/failure regressions. All must pass.
- [ ] Run `npm test` and `npm run typecheck` in root, and `npm test` plus `npm run typecheck` in extension. These include the Python integration bridge and nested custom-config children.
- [ ] Review the whole core diff for startup ordering, inherited marker compatibility, deterministic assertions, no unmanaged fallback and no production changes; run `git diff --check`.
- [ ] Commit configs and Python integration tests with mechanism-naming message `fix(test): reject unmanaged Vitest launches before workers start`.

## Task 2: Core review checkpoint

- [ ] Confirm all original design claims about rejection and managed cleanup are evidenced by live subprocess results, not optional marker semantics alone.
- [ ] Record the core gate and review result here. Only then write the separate documentation/shipping plan. That plan covers `spec.md`, developer instructions, rebase, final gate, Claude cross-review, PR and GitHub checks. Historical cleanup evidence remains operational and no new historical deletion is authorized by this code plan.
