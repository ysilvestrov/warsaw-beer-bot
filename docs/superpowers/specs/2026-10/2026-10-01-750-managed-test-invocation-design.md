# #750: Require managed repository test invocations

Date: 2026-10-01
Issue: https://github.com/ysilvestrov/warsaw-beer-bot/issues/750
Status: User approved the design; core implemented and verified on 2026-10-01.

## Goal

Prevent ordinary direct Vitest invocations from creating unmanaged temporary
transformation caches. Repository tests in both the root package and extension
must enter through the existing supervisor (`npm test` or installed `wbb-test`).
Preserve test results, exit codes and cleanup for managed invocations.

## Verified problem

PR #745 wrapped root and extension `npm test` in `scripts/ops/test_run.py`.
The supervisor publishes `WBB_TEST_TMPDIR`, redirects TMPDIR/TMP/TEMP and caches,
and removes its own run directory only after all descendants have exited.
Both Vitest configs currently use that variable optionally and silently fall
back to unmanaged paths when it is missing.

Live replay on 2026-10-01, main `0f5834c`, ran each package's existing focused
suite directly through `node node_modules/vitest/vitest.mjs run --cache=false`:

| Package and suite | Exit code | Disposable transformation cache roots left |
|---|---:|---:|
| Root, `scripts/test-temp.test.ts` | 0 | 1 |
| Extension, `src/manifest.test.ts` | 0 | 1 |

Each replay used a private scratch directory which was removed afterward.
Evidence: server-local `tmp/750-evidence/direct-vitest-baseline.json`.
A separate existing real-Vitest success/failure regression passed through
`npm test`, proving the managed path removes the transformed cache, unregistered
fixture and run directory after both results.

The filesystem survey found 195 additional cache-shaped roots created after
#745 merged, with module-ID/hash evidence pointing to worktrees and temporary
review directories. A passing managed-path test does not establish that other
commands also enter that path.

Vitest's fork worker sets `cacheFs = true` independently of the optional
persistent `fsModuleCache`. Disabling `fsModuleCache` is therefore insufficient
for the observed leak. Changing worker transport or replacing the test pool
would broaden this fix.

## Chosen approach

Require the existing supervisor marker in both repository Vitest configs before
exporting the configuration. A missing or empty `WBB_TEST_TMPDIR` is a startup
error. The error explains that temporary caches require supervisor cleanup and
gives usable commands: `npm test -- <arguments>`, extension `npm test` from its
package directory, or installed `wbb-test <arguments>` on this operator host.

Use the marker's existing meaning: the supervisor passes it only to its command
and descendants. Nested Vitest subprocesses inside a managed run retain that
context and continue to work. The guard is for accidental unmanaged invocation;
the marker is not an authentication credential or proof that a directory is
still live. Do not introduce a second supervisor or a filesystem sweeper.

After the guard, cache paths can be set from the required marker without an
unmanaged fallback. Keep existing pool, runner, setup files and suite behavior.
No new dependencies or production runtime changes are needed.

## Supported boundaries

- Root and extension invocations using their repository configs require the
  supervisor, including focused tests and test discovery/watch commands.
- Managed child Vitest invocations continue to inherit the run context.
- Arbitrary replacement configs, copied old configs and explicit environment
  forgery are outside this enforcement boundary. This change cannot patch old
  checkouts without updating them. The operator's installed `wbb-test` already
  supports running tests from those checkouts without unmanaged caches.
- Vitest configuration loading occurs before workers start. A live regression
  must verify that rejection leaves no disposable transformation cache root;
  this ordering is not accepted merely from reading the config.
- Existing SIGKILL/reboot retention policy remains: the supervisor reports
  uncertain leftovers and does not automatically delete discovered directories.

## Claims and evidence

| Recorded claim / artifact | What proves it | Limits |
|---|---|---|
| Unmanaged tests leak transformation caches | Two live private-scratch replays, successful suites and one root left per package | Focused suites; not a full filesystem attribution |
| A launch has managed context | `WBB_TEST_TMPDIR` published by the existing supervisor and inherited by descendants | Invocation marker, not authentication or a live-process certificate |
| A rejected repository launch creates no transformation cache | Real child CLI replay with the marker removed, exact nonzero status/message and cache inventory | Repository config boundary; external override configs are excluded |
| Managed success/failure cleans its complete run | Existing real-Vitest regression observes a transformed module inside the payload, then checks cache/fixture/root absence and exit code | Supervisor SIGKILL has deliberately weaker guarantees |
| Historical manifest cleanup is complete | Exact 2,145-path deletion ledger matches frozen manifest, per-path absence, original counts and post-cleanup health | Only the original manifest, not every `/tmp` directory |
| Actual reclaimed resources | Before/after statvfs: 216,420 net free inodes and 5,489,938,432 bytes | Concurrent filesystem activity can change net counters |
| No more unmanaged launches after rollout | Guard regression plus updated checkout configs and observed inventory over later runs | Cannot claim all sessions updated from a merge alone |

## Implementation and verification scope

1. Add subprocess regressions beside existing supervisor/Vitest integration
   coverage. Exercise root and extension direct launches with managed markers
   removed and dedicated temporary locations. Assert the exact error contract,
   failure status, no suite execution and no unmanaged transform cache.
2. Require the marker in both configs. Preserve managed root/extension focused
   execution and the existing success/failure cleanup regression.
3. Update `spec.md` section 5.3 and developer test instructions in README and
   AGENTS.md/CLAUDE.md where appropriate so agents use the managed commands.
   This has no extension user-visible effect and requires no extension changelog
   entry or Chrome Web Store submission.
4. Run root full gate, extension tests/typecheck, relevant Python integration
   coverage, rebase if necessary, Claude cross-review once, then open a PR and
   wait for GitHub review/checks. The user merges the PR.

The guard and integration regressions form the core. Review their behavior
before finalizing the developer-documentation changes. The change alters the
supported test invocation contract, so the architectural workflow applies.

## Operational closeout

The operator already removed the exact original 2,145-root manifest. Independent
verification found no manifest paths remaining, no skips, and all production
services healthy. Evidence is in issue comments and server-local
`tmp/750-evidence/result-1790884333886001216.json` and its deletion ledger.

The 195 additional cache roots and historical unproven groups were not in that
manifest. Do not expand deletion scope or claim all historical rubbish is gone.
Their handling needs a fresh bounded provenance/identity/activity audit and an
explicit deletion manifest, using the same privileged safeguards. Keep #750
open until the agreed prevention change is merged, relevant checkouts use it,
and the residual cache disposition is recorded. Link the implementation PR
with `Refs #750`, not an automatic close before operational verification.
