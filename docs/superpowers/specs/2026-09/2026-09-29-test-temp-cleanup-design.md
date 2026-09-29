# Test temporary resource cleanup

The host is critically short of ext4 inodes despite available disk blocks. Live
inventory links the `wbb-ad-*`, `wbb-drift-*`, guard, ships, qualify, installed-current,
read-env, state and verify-gitbody leftovers to test `mkdtempSync` calls with no
removal hooks. Other tests also omit cleanup or perform it only after success.
This affects development infrastructure, not bot behaviour.

## Choice and scope

Use explicit resource registration at allocation and Vitest lifecycle cleanup.
Keep all registered fixtures until root `afterAll`: some existing suites allocate
shared fixtures during collection or beforeAll, so afterEach removal would break them.
Normal per-file cleanup bounds retained resources to one suite without changing fixture lifetime.
Collection failures skip hooks; a synchronous worker exit fallback releases those
registered resources when the worker exits normally, and is removed after normal teardown.
Registration must happen immediately after allocation, before writes/git/setup
can fail. Do not remove directories by prefix or scan the machine in test hooks.
A helper owns only paths it creates. Existing sound `finally` cleanup stays intact.

Alternatives: a global TMPDIR wrapper contains crashes but doesn't fix missing
teardown; periodic age cleanup has no proof of inactivity. Neither substitutes
for cleanup in the tests. A separate run root and held advisory lock are proposed
for future crash recovery; this change does not silently install a scheduler.

## Required behaviour

- Successful tests, assertion failures, failed beforeEach/beforeAll and synchronous
  allocation-followed-by-setup failures release registered directories.
- Shared fixtures created during collection/beforeAll survive per-test cleanup.
- A failing test fixture created in an isolated child Vitest run leaves no own
  temporary directories after the child exits normally with failure.
- SIGKILL cannot run hooks: crash remnants are retained for separate, evidence-based
  operational cleanup. No PID-only or mtime-only assertion of inactivity.
- No production deployment or runtime behaviour changes; no new dependencies.

## Claims and evidence

| Recorded fact | What it claims | Evidence |
|---|---|---|
| Operational candidate manifest | Exact previously existing fixture root, owner, type, descendant counts and identity | Live lstat/scandir, explicit source allocation and fixture shape; no symlink traversal |
| Root fingerprint | Contents at survey time | Digest of relative names and inode/stat metadata, recomputed before deletion |
| Deletion ledger | A specific candidate was removed | Successful fd-based removal followed by filesystem counters and service checks |
| Test-owned directory registry | This test scope created these paths | mkdtemp result registered immediately; no external discovery |
| Successful cleanup assertion | Child test process left its private TMPDIR empty | Allocation path/existence assertions plus explicit readdir equality after success and controlled failure |

Operational scans are partial where permissions/time limits intervene; neither
entry count nor apparent size proves unexplained root usage belongs to /tmp.
