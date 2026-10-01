# Test diagnostics digest: periphery implementation plan

> **For agentic workers:** Use superpowers:executing-plans sequentially in the main thread, as required by AGENTS.md.

**Goal:** Connect the reviewed diagnostic contract to the installed monitor and the existing morning report, then ship a held PR.

**Architecture:** The monitor cron exports into an operator-owned shared directory. `dailyStatus` reads the snapshot only when sending its existing once-per-day report; the report's delivery marker is unchanged.

**Tech Stack:** Existing shell/Python installer, TypeScript report, Vitest and Python unittest; no new dependencies or bot environment keys.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-01-test-diagnostics-digest-design.md`

## Global constraints

- Use `readTestDiagnosticsLine(now: Date, path?: string): string` from the reviewed core.
- Shared default path is `/var/tmp/wbb-resource-monitor/summary.json`; directory/file modes are 0755/0644. Private monitor state remains 0700/0600.
- Missing, invalid or older-than-900-second data never becomes zero and never blocks the rest of the report.
- Do not send test notifications or extra morning reports during development.
- Do not change inode/disk thresholds, automatic cleanup, test supervisor or PID classification.
- A `[deploy:hold]` title and `deploy:hold` label are required because the installed monitor and cron change.

## Task 1: Installer export configuration

**Files:** `deploy/install-resource-monitor.sh`, `scripts/ops/test_install_monitor.py`.

**Interfaces:** Installer environment `WBB_RESOURCE_SUMMARY_DIR` overrides its default directory for controlled tests; cron passes `--summary-dir`. No new production `.env` key.

- [ ] Set the fixture's export directory to its temporary root. Update exact cron expectations with `--summary-dir`; assert mode 0755 and preservation of existing private state on repeat installation. Add refusal tests for symlink or writable export directories.

```python
self.env['WBB_RESOURCE_SUMMARY_DIR'] = str(self.root/'summary')
self.assertEqual((self.root/'summary').stat().st_mode & 0o777, 0o755)
```

- [ ] Run `python3 -B -m unittest discover -s scripts/ops -p test_install_monitor.py -v` and observe the new export/cron tests fail.
- [ ] Extend the existing fd-based `ensure` function with an explicit final directory mode. For a newly created export directory use `fchmod` to establish 0755 despite umask; refuse an existing directory with mismatched ownership or mode rather than widening private permissions.

```python
summary = pathlib.Path(os.environ.get('WBB_RESOURCE_SUMMARY_DIR', '/var/tmp/wbb-resource-monitor')).absolute()
ensure(summary, mode=0o755)
# Add to the existing command list:
'--summary-dir', str(summary)
```

- [ ] Re-run installer tests; verify the synthetic crontab only, never the host's cron.

## Task 2: Report integration

**Files:** `src/jobs/daily-status.ts`, `src/jobs/daily-status.test.ts`.

**Interfaces:** Add trailing optional `testDiagnosticsLine?: string | null` to `buildStatusMessage`; add optional `testDiagnosticsPath?: string` to `DailyStatusDeps` for choosing a snapshot path. Existing runtime callers use the default.

- [ ] Add real temporary-file tests driving `dailyStatus` with its normal DB, clock and notification sink. Assert the exact new line and exactly one send across repeated ticks. Add unavailable-file case that still advances the successful-delivery marker. Add failed-send case that keeps the marker unset and retries with the line.

```typescript
await dailyStatus({ db, log: silentLog, now: () => new Date('2026-10-01T07:00:00Z'),
  testDiagnosticsPath: path, notifyAdmin: async (text) => { sent.push(text); } });
expect(sent[0].split('\n').filter((line) => line.startsWith('• Тести:'))).toEqual([
  '• Тести: 0 каталогів потребують перевірки · диск: 30.00 GiB вільно · inode: 2 000 000 вільно',
]);
```

- [ ] Run `npm test -- src/jobs/daily-status.test.ts`; observe the missing line before implementing.
- [ ] Read the diagnostic line using the digest's `now`, append it in the existing Стан section, and keep the current morning window and delivery marker flow.

```typescript
const testDiagnosticsLine = readTestDiagnosticsLine(now, deps.testDiagnosticsPath);
// Final optional argument in buildStatusMessage; builder adds `• ${testDiagnosticsLine}`.
```

- [ ] Re-run the report and consumer suites.

## Task 3: Documentation, rollout and shipping

**Files:** `spec.md`, `deploy/README.md`, this plan. Primary ignored `tmp/install-test-diagnostics-digest.sh` holds the user's executable operational instructions.

- [ ] Update operational monitoring and daily-status specification to distinguish immediate resource transitions from diagnostic morning reporting, include freshness/unavailable semantics and bounded managed-run coverage.
- [ ] Document installing the refreshed immutable monitor copy, publishing a no-notification snapshot, verifying service-user readability, manual held deployment and health. Produce the same concrete commands in the requested shell file.
- [ ] Run full `npm test` and `npm run typecheck`; fetch main and rebase if it moved, repeating the gate after any rebase. Review the complete diff and run the mandatory Claude cross-review once on the completed branch; technically verify each finding, fix or reject with evidence, and repeat the full gate after code fixes.
- [ ] Push and create the held PR with rollout steps and the cross-review marker. Wait for GitHub checks and review; resolve valid findings and finish at merge-ready, leaving merge to the user.
- [ ] Do not claim installed behavior changed before host installation is verified. Keep the unmerged worktree and operational artifacts.

## Execution evidence

Core commit `3ec8531` already passed 4755 tests and both typecheck commands before this plan was written.

- Tasks 1–2 completed: installer red had three failures, then all eight tests passed; dailyStatus red had three missing-line failures, then all 81 report/reader tests passed.
- Full branch gate after integration: 4758 tests pass, one existing skip; both typecheck commands pass. `git diff --check` and shell syntax checks pass.
- Main refreshed before shipping and remains `0f5834c`; no rebase required.
- Whole-branch main-thread review checked approved scope, private/shared permissions, legacy notification state, unknown-versus-zero reporting, exact clock/bounds, independent alert/export failures, report retry/idempotency and the held rollout. No unresolved findings.
- Primary checkout `tmp/install-test-diagnostics-digest.sh` contains the concrete post-merge operations and health/line verification. It has not been executed against production.
- Independent Claude review and GitHub checks remain shipping gates; their results belong to the PR receipt.

## Claude review disposition

Claude reviewed `451b622` once and raised four findings:

1. **Fixed:** reproduced the inventory truncation race with real temporary directories: listing sizes `[257, 256]`, 256 returned rows, no marker. Added a failing regression and used the same first listing for selecting entries and checking its limit. No test process lifecycle or cleanup changes.
2. **Rejected:** inaccessible intermediate directories affect a nested `WBB_RESOURCE_SUMMARY_DIR` override. The override is the controlled installer-test seam, not a supported bot configuration; production's fixed `/var/tmp/wbb-resource-monitor` has an existing traversable parent. A separately configurable production export path and permission changes to arbitrary parents are outside this design.
3. **Fixed:** added narrower-directory-mode cases and UID-mismatch coverage. UID simulation changes only the OS stat boundary; real file reads and reader validation remain in place. A mutation removing the UID comparison must fail this test.
4. **Fixed:** the existing exact full-message assertion now includes the diagnostic line at its actual position in Стан, before the user/traffic rows and На кранах зараз.

The final shipping marker is `Cross-review: claude @ 451b622 — 4 findings: 3 fixed, 1 rejected`. Re-run the full gate after these changes; do not run a second Claude review for this PR.

Post-review gate completed: 4761 tests pass, one existing skip, both typecheck commands pass. The UID mutation failed with the exact expected reader assertion and the source was restored before this gate. A live temporary snapshot also passed the reader under the actual service user. Production cron and bot remain unchanged until the held rollout.
