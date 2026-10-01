# Test diagnostics in the morning report

## Request and scope

The administrator treats Telegram alerts as requests for human intervention:
either a known manual action that is deliberately not automated, or a serious
failure requiring manual repair. Recovery messages belong to an alert that was
actually raised. Changes in the inventory of test directories satisfy neither
condition. The user approved moving this diagnostic information to the existing
morning report and disabling the separate inventory notifications.

This change removes test-inventory notifications, including their recovery
messages. Existing inode/disk warning, critical and recovery transitions keep
their thresholds and delivery acknowledgement. It adds one line to `dailyStatus`.
It does not implement cleanup, change the test supervisor, or repair PID namespace
classification. The bounded inventory helper must use one directory listing for
both selecting entries and deciding truncation; test-launch and cleanup behavior
are unchanged. PR #773 remains independent.

## Evidence obtained before planning

- `resource_monitor.tick` currently includes changes to `announced.runs` in its
  Telegram message, even when both filesystem resource levels are normal.
- A live probe recorded an active supervisor as PID 4 in the Codex namespace;
  host PID 4 had a different start time. Host inventory reported live children as
  `observed_processes`, which the monitor treats as retained. Therefore inventory
  classification is not proof that a directory is abandoned or safe to delete.
- The installed monitor runs as the operator, separately from the bot. Its state
  directory is mode 0700 and its state file is mode 0600. A live read-permission
  check as `warsaw-beer-bot` confirmed that it cannot read that private state.
- A temporary synthetic JSON owned by the operator, in a mode 0755 directory
  with a mode 0644 file, was read successfully as `warsaw-beer-bot`; the received
  contents matched exactly. The probe removed its temporary directory.
- During cross-review, a controlled live filesystem probe reduced 257 directories
  to 256 between the inventory helper's two listings. Its old implementation
  returned 256 rows without a truncation marker, despite omitting an entry from
  the first listing. Preserve the first listing's completeness evidence.
- `dailyStatus` already provides the Warsaw morning window, successful-delivery
  marker and restart catch-up. Adding a line uses that existing delivery path.

## Alternatives and decision

1. **Export a small shared snapshot (chosen).** The existing monitor is the only
   collector; the bot reads a bounded diagnostic file. Private state stays private.
2. Make the full monitor state readable. This exposes unnecessary history and
   couples the report to the monitor's internal acknowledgement format.
3. Collect the test inventory again inside the bot. The service user lacks access
   to operator-owned test directories, and collection would duplicate the cron.

## Producer and shared snapshot

The installer creates `/var/tmp/wbb-resource-monitor` as an operator-owned mode
0755 directory, refusing symlink paths, foreign ownership and writable access for
other users. Existing private state and tool directories keep their current modes.
The monitor receives this export directory explicitly from its managed cron;
manual invocations without an export directory do not publish a snapshot.

The only shared file is `summary.json`, mode 0644, written by atomic replacement.
It contains no credentials, process identifiers, command lines, directory names,
or private paths. Version 1 fields:

| Field | Meaning |
| --- | --- |
| `version` | Exactly 1 |
| `timestamp` | Unix seconds of the filesystem measurement |
| `inodes_free` | Free inode count from `statvfs('/')` |
| `bytes_available` | Available bytes from `statvfs('/')` |
| `runs_inventory_available` | Whether this tick completed an inventory |
| `pending_runs` | Count whose status is not `active`, or null when unavailable |

The export is independent of Telegram delivery and is published before an alert
delivery attempt. A transport failure must not prevent recording diagnostic
evidence. The monitor still attempts resource alerts if snapshot publication fails;
the publication failure is logged locally and the older snapshot expires normally.

An inventory exception or busy lock produces unavailable inventory, not a
fabricated directory and not zero. The 256-entry inventory bound and overflow
marker must be handled as incomplete inventory, not as a precise count.
The count covers only the managed test-run inventory; historical unmanaged Vitest
caches and unrelated `/tmp` contents are outside its coverage.

## Notification state

Only changes in the inode/disk levels can trigger the monitor's Telegram callback.
No test inventory text is appended to resource messages. An old `announced.runs`
value cannot trigger a recovery notification after upgrade. Preserve compatibility
when reading existing version-1 private state; do not clear resource delivery
acknowledgements or historical samples during installation.

## Consumer and report text

The bot reads `/var/tmp/wbb-resource-monitor/summary.json` only when it is about to
send the morning report. The reader accepts a path argument for focused tests;
production uses the fixed path, so no new environment key is required.
Read at most 16 KiB; refuse symlink/nonregular files, unsafe directory/file modes,
multiple hard links, inconsistent directory/file ownership, invalid JSON/version,
nonfinite timestamps, negative/noninteger counters, and inconsistent inventory
availability/count fields. This is local diagnostic telemetry, not authorization
for deleting files or proof of system health.

A snapshot is fresh when its timestamp is not in the future and its age is at most
15 minutes. Exact boundary: 900 seconds is accepted, greater than 900 is stale.
Use the same `now` as the digest. Missing, invalid or unreadable input cannot stop
delivery of the rest of the report.

Example with fresh complete inventory:

`• Тести: 1 каталог потребує перевірки · диск: 32.07 GiB вільно · inode: 1 890 348 вільно`

Plural forms cover 0, 1, 2–4 and other counts. A fresh empty inventory explicitly
shows zero. A fresh snapshot with unavailable inventory says that test-directory
data is unavailable while retaining its measured free-resource counters. Stale
input says `• Тести: дані монітора застарілі`; absent, unreadable or invalid input
says `• Тести: дані монітора недоступні`. Do not call an uncertain directory trash,
claim it is safe to delete, or require an immediate action in this report line.

## Claims and their evidence

| Recorded fact or displayed claim | Evidence and limit |
| --- | --- |
| Shared snapshot filesystem counters | Validated counters from this tick's `statvfs('/')`; timestamp records when measured |
| `pending_runs = N` | Complete bounded inventory with N statuses other than `active`; does not prove abandonment, byte usage or cleanup safety |
| Inventory unavailable | Busy lock, failed audit or incomplete inventory; no replacement with zero |
| Fresh snapshot | Valid timestamp within [now − 900 seconds, now], checked by the reader |
| Resource transition delivered | Existing Telegram response `ok:true`; inventory changes never advance resource acknowledgements |
| Morning report delivered | Existing successful `notifyAdmin` and only then `daily_status_last_sent` |
| Bot can read shared telemetry | Live synthetic permission probe; host acceptance must verify the actual installed snapshot as the service user |
| Old inventory notifications disabled | Regression tests with both appearance and disappearance, including old private state; host acceptance verifies installed cron points to the new copy |

## Verification and rollout

Focused tests cover silent inventory appearance/disappearance, existing resource
alert/recovery delivery and retries, busy/error/overflow inventory, snapshot
publication and permissions, exact payload, failed export versus alert delivery,
reader size/type/freshness boundaries, report text, and installer preservation.
Cross-language integration must read a Python-produced synthetic snapshot through
the TypeScript reader. Run the full root test/typecheck gate and required reviews.

PR title starts with `[deploy:hold]` and carries the `deploy:hold` label because
installed operator copies and cron must be refreshed. The PR lists: update the
operator checkout after merge, run `bash deploy/install-resource-monitor.sh`,
verify the new cron and readable fresh snapshot, then run `bash deploy/deploy.sh`.
Provide commands in a shell file under the primary checkout's `./tmp/`, as the
user requested for operational commands. Acceptance verifies health and renders
the new line without sending an extra Telegram report. Preserve monitor state;
no retrospective inventory recovery is sent.

## Implementation staging

Plan the core producer/consumer contract and focused verification first. Review
that core before writing the separate periphery plan for installer, daily report,
specification updates, rollout instructions and final shipping. No implementation
has been written at this design-review checkpoint.
