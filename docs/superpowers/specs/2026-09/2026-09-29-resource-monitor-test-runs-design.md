# Root filesystem monitoring and isolated test runs

Implement the user's server maintenance requirements without stopping or restarting
production, deploying the bot, changing another session's checkout, or deleting
historical /tmp entries. Remote main has #744 (rebased as c87dcbe..7d87cba);
three active local checkouts still lack it. Use a new worktree from origin/main.

## Monitoring

A standalone Python 3 standard-library command measures statvfs('/') every five
minutes from the operator's existing cron, with a nonblocking flock against overlap.
There is no existing resource monitor or usable user systemd manager. Reuse the
autodeploy read-env helper and configured Telegram admin channel; read only the two
notification keys, never log them. Do not run the bot or access its database.

Inode warning is >=80% continuously for 900 seconds, critical is >=90% or
<100000 free immediately. Disk warning is <=10 GiB continuously for 900 seconds;
critical is <=5 GiB immediately. This 75 GiB filesystem currently uses 41.76 GiB,
with 29.94 GiB available; 10 GiB exceeds the prior 6.49 GiB temp incident and 5 GiB
preserves working space. Synthetic inputs exercise thresholds, never a disk filler.

Persist at most 864 samples (three days), reset continuity on device changes,
non-increasing time or gaps >450 seconds. Forecast only with >=13 consecutive
samples spanning >=1 hour, no resource increase (cleanup), and positive consumption;
report an estimate, never use it as evidence for deletion. Notifications report
resource state transitions and recovery; retain delivery acknowledgement separately
so failed delivery is retryable. Do not announce recovery while still above the
warning threshold during its waiting period. Bounded local logs record failures.

## Test runs

`npm test` invokes a Linux Python supervisor before Node/Vitest loads. Each run
owns a random root below a private 0700 uid-specific base, with a separate 0700
payload passed as TMPDIR/TMP/TEMP to all descendants. Override Vite cacheDir into
the payload too. Keep #744's per-file resource cleanup. Validate actual Vitest
transform cache placement during a test, then verify the entire run root is absent.

Choose Linux PR_SET_CHILD_SUBREAPER: the kernel reparents orphaned descendants,
including detached/double-forked children, to this supervisor. Successful completion
means waitpid reports ECHILD, not merely that the initial Node process exited. Keep
the initial command's exit code, or 128+signal on interruption. Forward interruption
to the test process group and newly adopted direct children. Never kill unrelated
processes. If descendants keep running, wait and retain the directory.

Alternatives rejected: a PID/mtime sweeper cannot prove descendants are dead;
a dedicated cgroup would be stronger after supervisor SIGKILL but this operator has
no passwordless cgroup delegation or user systemd. Do not add privileged infrastructure.

Metadata records protocol version, uid, root device/inode, boot_id, supervisor
PID/starttime and random run identity; a held flock provides a live lease. A bounded
directory flock coordinates root publication/removal with inventories. A busy
inventory preserves its prior known leftovers while filesystem sampling continues;
it never announces recovery from a partial snapshot.
The
read-only inventory checks these identities and matching process environment markers
without printing environment contents. When the supervisor is SIGKILLed, same-boot
leftovers remain uncertain even with zero observed references: a child can scrub its
environment. A changed boot_id proves old processes ended, but still do not automatically
delete crash leftovers. Report them for an explicit identity/activity-checked manifest.
Inventory never deletes any discovered root. Normal completion deletes only the
root allocated by this supervisor using fd-safe rmtree, without following symlinks
or crossing filesystems; changed identity or cleanup errors retain evidence and fail.

## Historical inventory

One sequential low-priority, timed scan of previously excluded groups and Vitest
caches; no contents of env, DB, user files or profiles. Count paths separately from
unique (device,inode), allocated blocks and logical bytes. A hardlink inode is
potentially reclaimed only if all nlink entries are contained in the proposed set.
Partial trees are explicitly partial, never promoted to cleanup candidates.
Prepare a new exact compressed manifest only for source/shape-confirmed groups;
record inactivity limitations. No historical deletion is authorized in this task.

## Claims and evidence

| Recorded fact | Claim | Required evidence |
|---|---|---|
| Sample | Root filesystem counters at timestamp | statvfs('/') and st_dev, range validation |
| Warning continuity | Threshold held for 15 minutes | All consecutive samples satisfy threshold, gaps <=450s |
| Delivery acknowledgement | Operational alert was accepted | Telegram JSON ok:true; never just request attempted |
| Forecast | Approximate recent exhaustion rate | >=13 continuous samples, >=1h, positive monotone consumption |
| Run metadata | Supervisor allocated this private root | mkdtemp/uuid allocation, lstat identity and uid/mode |
| Normal completion | All run descendants ended | Subreaper waitpid ECHILD, initial child exit collected |
| Active run | Lease and supervisor identity match | flock plus boot_id/PID/starttime, not PID alone |
| Crash inventory | Root is retained, activity uncertain or observed | Protocol identity validation and bounded proc metadata audit |
| Previous boot | Prior processes cannot survive reboot | Recorded boot_id differs; still no automatic deletion |
| Historical manifest | Specific inode identities and cleanup benefit bounds | Complete no-follow scan and all-link accounting; human approval pending |

## Verification and rollout

Tests cover thresholds/equality, continuity gaps/restarts, bounded history, delivery
failure/recovery, forecast minimum, success/failure, SIGINT/SIGTERM, concurrent runs,
adopted detached child, SIGKILL survivor, PID reuse, changed root/symlink and real cache.
Core is reviewed before a separate rollout/historical plan. Full npm test and typecheck,
Claude cross-review and GitHub CI/review gate the PR. Install only standalone operator
monitor/test commands as verified copies, retaining existing crontab entries. Final
report separates installed state, PR-only npm/config changes, measurements and decisions.
