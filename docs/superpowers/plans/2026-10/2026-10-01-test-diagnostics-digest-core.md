# Test diagnostics digest: core implementation plan

> **For agentic workers:** Use superpowers:executing-plans, sequentially in the main thread as required by AGENTS.md.

**Goal:** Stop inventory Telegram notifications and transfer an honest, bounded diagnostic snapshot from Python to TypeScript.

**Architecture:** The existing operator monitor publishes a small atomic JSON export. The bot reads and formats it without accessing private state. Review this core before planning installer/report integration.

**Tech Stack:** Existing Python standard library, Node filesystem APIs, TypeScript, Vitest; no dependencies.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-01-test-diagnostics-digest-design.md`

## Global constraints

- Version 1 fields: `version`, `timestamp`, `inodes_free`, `bytes_available`, `runs_inventory_available`, `pending_runs`.
- Read at most 16 KiB. Freshness is inclusive 900 seconds; future timestamps are invalid.
- Private state stays private. Shared directory/file modes are 0755/0644, owner is the operator.
- Inventory is diagnostic, never proof of abandonment or cleanup safety; incomplete inventory has null count.
- Only inode/disk transitions send immediate Telegram messages. Preserve thresholds, history and resource acknowledgements.
- No production installation or extra Telegram sends during development.

## Task 1: Silent inventory and shared snapshot producer

**Files:** `scripts/ops/resource_monitor.py`, `scripts/ops/test_resource_monitor.py`.

**Interfaces:** Add `publish_summary(directory: Path, sample: dict, runs: list | None) -> None` and optional `summary_dir=None` to `tick`. Add `--summary-dir` to the monitor CLI. Existing callers of `tick` remain valid.

- [ ] Write regression tests for inventory appearance/disappearance and legacy announced inventory, expecting exactly `messages == []`. Replace obsolete inventory-notification expectations.
- [ ] Add producer tests with literal full payload and modes; unavailable/truncated/audit-error inventory expects null count; symlink/unsafe modes refuse; transport failure still leaves export; publication failure still delivers resource alert.

```python
tick(state, sample(300), messages.append,
     [{'name': 'run-a', 'status': 'uncertain_current_boot'}], summary)
self.assertEqual(messages, [])
self.assertEqual(json.loads((summary/'summary.json').read_text()), {
    'version': 1, 'timestamp': 300, 'inodes_free': 2000000,
    'bytes_available': 32212254720,
    'runs_inventory_available': True, 'pending_runs': 1})
```

- [ ] Run `python3 -B -m unittest discover -s scripts/ops -p test_resource_monitor.py -v`; observe the inventory regression failure before writing implementation.
- [ ] Implement directory validation via O_DIRECTORY/O_NOFOLLOW, owner/mode checks, atomic bounded JSON replacement with fsync; publish before delivery and catch/log export failures independently. Reduce notification changes to inode/disk only, keep legacy state readable, and represent inventory exceptions as unavailable.

```python
changes = [f'{key}: {announced[key]} → {wanted[key]}'
           for key in ('inode', 'disk') if wanted[key] != announced[key]]
```

- [ ] Re-run focused tests and inspect that existing resource/retry tests remain green.

## Task 2: Bounded consumer and diagnostic line

**Files:** Create `src/jobs/test-diagnostics.ts` and `src/jobs/test-diagnostics.test.ts`.

**Interfaces:** `readTestDiagnosticsLine(now: Date, path = '/var/tmp/wbb-resource-monitor/summary.json'): string`; always returns a report line body and never propagates missing/invalid filesystem input. Periphery will pass it to the existing message builder.

- [ ] Write real-file tests using temporary directories, literal payloads and exact lines. Include singular/plural/zero, unavailable inventory, stale/missing/invalid input, future timestamp, 900/901-second boundary, symlink/file type/link/mode/size refusal, and inconsistent availability/count fields.

```typescript
expect(readTestDiagnosticsLine(new Date(1_200_000), path)).toBe(
  'Тести: 1 каталог потребує перевірки · диск: 30.00 GiB вільно · inode: 2 000 000 вільно',
);
```

- [ ] Run `npm test -- src/jobs/test-diagnostics.test.ts`; observe missing implementation failure, then implement using filesystem handles and an explicitly bounded read, validated version/counters and the digest's supplied clock. Close all handles in finally.
- [ ] Add a cross-language test that executes Python `publish_summary` into a temporary export directory, then asserts the exact line through the TypeScript consumer. Run focused consumer and producer suites.

## Task 3: Core gate and review

- [ ] Run `npm test` and `npm run typecheck`, saving output under ignored `tmp/test-diagnostics-validation/`.
- [ ] Review the complete core diff against the design: no false zero, no inventory sends, legacy ack compatibility, bounded reads, no credential exposure, export/alert failure independence. Record findings and resolutions here.
- [ ] Commit only owned core/test/plan files after the full gate, then write the periphery plan against the reviewed interfaces.

## Execution evidence

- Tasks 1–3 completed, reviewed sequentially in the main thread as required by AGENTS.md.
- Producer red: 4 regression failures and 9 missing-interface errors. Producer green: all 28 tests pass; existing resource transitions and retry acknowledgement remain covered.
- Consumer red after minimal interface stub: 13 failures / 30 passes. Consumer green: 43 passes, including a real Python-produced snapshot.
- Full gate: 254 test files pass, one existing file skipped; 4755 tests pass, one existing test skipped. Both TypeScript typecheck commands pass.
- Core review: checked silent inventory appearance/disappearance and upgrade state, resource acknowledgements, export/transport independence, unavailable inventory, read bounds, file handles/modes, freshness and the shared JSON contract. No unresolved findings. This main-thread review is not the independent Claude cross-review, which will run once on the finished branch.
- Reader opens the directory once and reads its file through the pinned `/proc/self/fd` descriptor on Linux, preventing an atomic export replacement from mixing directory/file checks.
- The next plan owns installer, dailyStatus integration, spec and deployment instructions; those were not implemented before this core review.
