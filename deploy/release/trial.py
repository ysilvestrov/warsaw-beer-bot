"""Native probe and trial migration of an accepted release, in the wbb-trial sandbox (root helper).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §4, §6 DATA-001,
§10a rows "TRIAL OK".
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2b.md, Task 4.

Each step answers with a Step: `ok`, `failed` (the candidate is bad — the controller
may record it as the failed SHA) or `transient` (this host could not judge it now —
retry, never a failed SHA). The release tree is re-verified against its receipt right
before each run. The trial works on a private copy of a pre snapshot, hashed in the
same pass that copies it, so the bytes checked are the bytes migrated; the live
database is never visible to the sandbox. The scratch is removed whatever happens.
"""
import hashlib
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounded  # noqa: E402
import publish as pub  # noqa: E402
import sandbox as sb  # noqa: E402
from safe_tar import Refused  # noqa: E402
from verify_payload import check_release  # noqa: E402

PROBE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'payload-probe.cjs')
SNAPSHOT_SUM = re.compile(r'([0-9a-f]{64})\n?')
RESULT = re.compile(r'PROBE (OK|FAILED) (native|migrate): (.*)')
# Spec §4: after preparation the host keeps more than 10 GiB free. The trial copy must not
# be what takes it below that (#817 AI review: an unbounded copy could fill /var).
MIN_FREE_AFTER_COPY = 10 * 1024 ** 3


@dataclass(frozen=True)
class Step:
    kind: str            # 'ok' | 'failed' | 'transient'
    detail: str
    node: object = None  # sandbox.NodeIdentity the step ran on, when it ran


def trial_ids():
    entry = pwd.getpwnam(sb.TRIAL_USER)
    return entry.pw_uid, entry.pw_gid


def _scratch(scratch_root, ids):
    path = tempfile.mkdtemp(dir=scratch_root, prefix='run-')
    os.mkdir(os.path.join(path, 'tmp'), 0o700)
    for p in (path, os.path.join(path, 'tmp')):
        os.chown(p, *ids)
    return path


def _host_glibc():
    return os.confstr('CS_GNU_LIBC_VERSION').split()[1]


def _outcome(ran, mode, ident):
    """The probe's own result line decides; systemd's result covers a probe killed before it could print one."""
    if ran.result in ('timeout', 'oom-kill'):
        return Step('failed', f'{mode}: killed by the sandbox ({ran.result})', ident)
    lines = [line for line in ran.stdout.splitlines() if line.startswith('PROBE ')]
    m = RESULT.fullmatch(lines[-1]) if lines else None
    if m is None or m.group(2) != mode:
        return Step('failed', f'{mode}: no result line from the probe ({ran.result}, exit {ran.exit}): '
                              f'{ran.stdout.strip()[-500:]!r}', ident)
    if m.group(1) == 'OK' and ran.exit == 0 and ran.result == 'success':
        return Step('ok', f'{mode}: {m.group(3)}', ident)
    return Step('failed', f'{mode}: {m.group(3)}', ident)


def _run(kind, sha, release, scratch, args, mode, ident, runner, node):
    """(Step, keep scratch?) — the scratch is kept whenever the unit could not be confirmed stopped."""
    try:
        return _outcome(sb.run_sandboxed(kind, sha, release, scratch, PROBE_FILE, args, runner, node), mode, ident), False
    except sb.Unconfirmed as e:
        return Step('transient', f'{e}; scratch kept at {scratch} for inspection', ident), True
    except sb.Transient as e:
        return Step('transient', str(e), ident), False


def _compatible(sha, release, runner, node, glibc):
    """(Node identity, None) when this host can run the release, else (identity or None, Step without running it)."""
    try:
        ident = sb.node_identity(node, runner)
        host_glibc = glibc()
    except (OSError, subprocess.SubprocessError, ValueError, IndexError, AttributeError) as e:
        # A host that will not say which Node or glibc it runs says nothing about the candidate (#817 AI review).
        return None, Step('transient', f'host Node/glibc identity unavailable: {type(e).__name__}: {e}')
    try:
        check_release(release, sha, ident.modules, host_glibc)
    except Refused as e:
        return ident, Step('failed', f'incompatible with this host: {e}', ident)
    return ident, None


def probe(sha, roots, scratch_root, runner=bounded.run, node=sb.NODE, ids=trial_ids, glibc=_host_glibc):
    """Tree still exact, built for this Node/ABI/glibc, and its native SQLite opens in the sandbox."""
    pub.verify_release(sha, roots)
    release = os.path.join(roots.releases, sha)
    ident, refused = _compatible(sha, release, runner, node, glibc)
    if refused:
        return refused
    scratch = _scratch(scratch_root, ids())
    keep = False
    try:
        step, keep = _run('probe', sha, release, scratch, ['native'], 'native', ident, runner, node)
        return step
    finally:
        if not keep:
            shutil.rmtree(scratch, ignore_errors=True)


def _expected_snapshot_sum(snapshot):
    try:
        with open(snapshot + '.sha256', 'rb') as f:
            raw = f.read(129).decode('ascii', 'replace')
    except OSError as e:
        raise Refused(f'{snapshot}.sha256: {e.strerror}') from None
    m = SNAPSHOT_SUM.fullmatch(raw)
    if not m:
        raise Refused(f'{snapshot}.sha256: not a single sha256 line')
    return m.group(1)


def copy_snapshot(snapshot, dest, ids, free=lambda path: shutil.disk_usage(path).free):
    """Copy snapshot into dest (new, 0600, owned by ids), hashing the same bytes; refuse on mismatch.

    Refuses before copying when the copy would leave less than MIN_FREE_AFTER_COPY free, and
    turns any I/O failure (ENOSPC included) into a refusal with the partial copy removed.
    """
    if not os.path.isabs(snapshot):
        raise Refused(f'snapshot path must be absolute: {snapshot!r}')
    want = _expected_snapshot_sum(snapshot)
    try:
        fd = os.open(snapshot, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        raise Refused(f'{snapshot}: cannot open ({e.strerror})') from None
    h = hashlib.sha256()
    try:
        with os.fdopen(fd, 'rb') as src:
            st = os.fstat(src.fileno())
            if not stat.S_ISREG(st.st_mode):
                raise Refused(f'{snapshot}: not a regular file')
            left = free(os.path.dirname(dest)) - st.st_size
            if left < MIN_FREE_AFTER_COPY:
                raise Refused(f'{snapshot}: copying {st.st_size} bytes would leave {left} free, '
                              f'under the {MIN_FREE_AFTER_COPY} the host must keep')
            out_fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(out_fd, 'wb') as out:
                # Exactly the size the free-space check counted (#817 AI review): a snapshot
                # that grows while copied is refused, not followed into the reserve.
                remaining = st.st_size
                while remaining > 0:
                    chunk = src.read(min(1 << 20, remaining))
                    if not chunk:
                        raise Refused(f'{snapshot}: shrank while being copied')
                    h.update(chunk)
                    out.write(chunk)
                    remaining -= len(chunk)
                if src.read(1):
                    raise Refused(f'{snapshot}: grew while being copied')
    except OSError as e:
        if os.path.lexists(dest):
            os.unlink(dest)
        raise Refused(f'{snapshot}: copy failed ({e.strerror or type(e).__name__})') from None
    except Refused:
        if os.path.lexists(dest):
            os.unlink(dest)
        raise
    if h.hexdigest() != want:
        os.unlink(dest)
        raise Refused(f'{snapshot}: sha256 {h.hexdigest()} != {want}')
    os.chown(dest, *ids)


def trial(sha, snapshot, roots, scratch_root, runner=bounded.run, node=sb.NODE, ids=trial_ids, glibc=_host_glibc,
          free=lambda path: shutil.disk_usage(path).free):
    """Migrate a private copy of the pre snapshot twice with the release's own code, in the sandbox."""
    pub.verify_release(sha, roots)
    release = os.path.join(roots.releases, sha)
    # The same gate as the probe: no release code runs on a host it was not built for (#817 AI review).
    ident, refused = _compatible(sha, release, runner, node, glibc)
    if refused:
        return refused
    owner = ids()
    scratch = _scratch(scratch_root, owner)
    keep = False
    try:
        db = os.path.join(scratch, 'trial.db')
        try:
            copy_snapshot(snapshot, db, owner, free)
        except Refused as e:
            # A bad snapshot or a full disk says nothing about the candidate; the next tick retries.
            return Step('transient', f'snapshot unusable: {e}')
        pub.verify_release(sha, roots)
        step, keep = _run('trial', sha, release, scratch, ['migrate', db], 'migrate', ident, runner, node)
        return step
    finally:
        if not keep:
            shutil.rmtree(scratch, ignore_errors=True)
