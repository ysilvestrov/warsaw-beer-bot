# Resource monitoring rollout and historical evidence

> **For agentic workers:** Use superpowers:executing-plans sequentially;
> preserve other sessions' work and production processes.

**Goal:** Activate reviewed standalone operator commands and submit a checked PR.
**Architecture:** Immutable per-version copies in the operator's .local/lib; one
managed five-minute crontab block; optional wbb-test command for older checkouts.
**Tech Stack:** Bash, Python standard library, cron, existing Telegram notifier.
**Spec:** docs/superpowers/specs/2026-09/2026-09-29-resource-monitor-test-runs-design.md
**Core checkpoint:** fc9ab39; full root/extension tests and typechecks passed.

## Global constraints

- No production stop/restart/deploy, broad /tmp sweep or historical deletion.
- Never replace unrelated crontab lines or tools; preserve an exact local backup.
- Install copies only after checks; source edits do not silently alter installed code.
- Every historical benefit estimate distinguishes unique inode and last-hardlink removal.

## Task 1: Operator installer

Files: deploy/install-resource-monitor.sh, scripts/ops/test_install_monitor.py.
Interfaces: shell installer run from repository; WBB_OPS_HOME/WBB_CRONTAB are
test seams, real defaults are the current user's home and crontab executable.

- [x] Write real-script test with isolated home and file-backed crontab executable;
  existing comment/job survive, two installs produce one managed block, foreign
  wrapper/malformed markers refuse without writing the crontab.
- [x] Run test RED before installer exists. Implement versioned code copies, managed
  wbb-test, exact crontab backup, compare crontab before replacement, 5-minute schedule,
  timeout/low priority and explicit default /tmp/wbb-test-runs-UID.
- [x] Run focused and full gates; commit, then activate as operator with permitted
  host escalation. Validate read-only Telegram channel accessibility without sending
  synthetic operational alerts; initial healthy sample and >=one genuine cron tick.

## Task 2: Historical scan and proposal

Files: ignored tmp/resource-evidence/historical-survey.py, summaries and compressed
manifest; tracked inode-followup-report.md contains only aggregate evidence.

- [x] One nice/ionice sequential metadata scan: cache, known wbb fixtures, other
  directories; separate per-phase deadlines, no symlink/filesystem traversal.
- [x] Validate Vitest filename/environment/layout against local source; parse only
  structural header/id fields of bounded sample files, never output cached code.
- [x] Count entries/files/dirs, global unique inode, blocks/logical bytes and links
  seen versus nlink. Keep partial results labelled partial; complete source-confirmed
  roots alone enter a proposal. Protected/unknown entries stay excluded.
- [x] Snapshot bounded process-reference audit and production health; record limitations
  and prerequisite no-tests window before any later historical deletion approval.

## Task 3: Final verification and PR

- [ ] Record installed hashes, real timer samples, root/disk/service metrics and actual
  no-root-leftovers after ordinary npm tests; list untouched active stale checkouts.
- [ ] Fetch/rebase main immediately before PR; re-run full gate after any rebase/code fix.
- [ ] Once-per-PR Claude cross-review with authorized tracked diff/code only; verify
  findings technically, commit necessary fixes and refresh installed copies if relevant.
- [ ] Push/create PR, wait for GitHub checks/review and resolve valid findings. Do not
  merge/deploy bot. Report installed versus PR-only work and decisions still required.
