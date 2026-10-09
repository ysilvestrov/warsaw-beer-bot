"""Native probe and trial migration of an accepted release, in the wbb-trial sandbox (root helper).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §4, §6 DATA-001,
§10a rows "TRIAL OK".
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2b.md, Task 4.

Each step answers with a Step: `ok`, `failed` (the candidate is bad — the controller
may record it as the failed SHA) or `transient` (this host could not judge it now —
retry, never a failed SHA). A host that cannot prepare the run (no wbb-trial user, no
scratch, a full disk) or a unit systemd could not start is `transient`, never `failed`
(2b review B1, B2). The release tree is re-verified against its receipt right
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

PROBE_NAME = 'payload-probe.cjs'
PROBE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), PROBE_NAME)
SNAPSHOT_SUM = re.compile(r'([0-9a-f]{64})\n?')
# 2b review S2: the trial reads a snapshot by name from one fixed directory, never a path.
SNAPSHOT_NAME = re.compile(r'[0-9A-Za-z][0-9A-Za-z._-]*-pre\.db')
RESULT = re.compile(r'PROBE (OK|FAILED) (native|migrate): (.*)')
MIGRATED = re.compile(r'schema (none|\d+) -> (null|\d+) \(knows (\d+)\)')
# 2b review B2: systemd's own exit statuses for a unit whose process it never got to exec
# (226/NAMESPACE, 217/USER, 200/CHDIR, 203/EXEC, ...). Node's own codes stay below 200.
SYSTEMD_EXEC_STATUS = range(200, 244)
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


def _install_probe(scratch, ids):
    """Copy the installed probe into the scratch, 0400 and owned by the trial user (2v review).

    The sandbox once ran PROBE_FILE where it is installed; a helper directory wbb-trial cannot
    read made Node die with MODULE_NOT_FOUND before any PROBE line — a host failure that read
    as a failed candidate. The copy is the one file the unit is sure to be able to read.
    """
    with open(PROBE_FILE, 'rb') as src:
        data = src.read()
    dest = os.path.join(scratch, PROBE_NAME)
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)
    os.chown(dest, *ids)


def _scratch(scratch_root, ids):
    path = tempfile.mkdtemp(dir=scratch_root, prefix='run-')
    try:
        os.mkdir(os.path.join(path, 'tmp'), 0o700)
        for p in (path, os.path.join(path, 'tmp')):
            os.chown(p, *ids)
        # Inside the try: a probe that cannot be copied is the host's problem (transient), never the candidate's.
        _install_probe(path, ids)
    except OSError:
        shutil.rmtree(path, ignore_errors=True)
        raise
    return path


def host_glibc():
    return os.confstr('CS_GNU_LIBC_VERSION').split()[1]


def _never_started(ran):
    """systemd created the unit but did not get to run Node in it: a host setup failure (2b review B2)."""
    return ran.result == 'resources' or (ran.result == 'exit-code' and ran.exit in SYSTEMD_EXEC_STATUS)


def _migrated(detail):
    """None when the migrate line shows a sound move, else why not (2b review N5)."""
    m = MIGRATED.fullmatch(detail)
    if m is None:
        return f'unexpected migrate result {detail!r}'
    before, after, knows = m.groups()
    if after == 'null':
        return f'no schema version after migrate ({detail})'
    if before != 'none' and int(after) < int(before):
        return f'schema moved backwards ({detail})'
    if before != 'none' and int(before) > int(knows):
        return f'the database is newer than this release ({detail})'
    return None


def _outcome(ran, mode, ident):
    """The probe's own result line decides; systemd's result covers a probe killed before it could print one."""
    if ran.result in ('timeout', 'oom-kill'):
        return Step('failed', f'{mode}: killed by the sandbox ({ran.result})', ident)
    lines = [line for line in ran.stdout.splitlines() if line.startswith('PROBE ')]
    if not lines and _never_started(ran):
        return Step('transient', f'{mode}: the sandbox unit did not start the probe ({ran.result}, exit {ran.exit}): '
                                 f'{ran.stdout.strip()[-500:]!r}', ident)
    m = RESULT.fullmatch(lines[-1]) if lines else None
    if m is None or m.group(2) != mode:
        return Step('failed', f'{mode}: no result line from the probe ({ran.result}, exit {ran.exit}): '
                              f'{ran.stdout.strip()[-500:]!r}', ident)
    if m.group(1) == 'OK' and ran.exit == 0 and ran.result == 'success':
        unsound = _migrated(m.group(3)) if mode == 'migrate' else None
        if unsound:
            return Step('failed', f'{mode}: {unsound}', ident)
        return Step('ok', f'{mode}: {m.group(3)}', ident)
    return Step('failed', f'{mode}: {m.group(3)}', ident)


def _run(kind, sha, release, scratch, args, mode, ident, runner):
    """(Step, keep scratch?) — the scratch is kept whenever the unit could not be confirmed stopped."""
    try:
        # The binary whose identity was taken, not the path that led to it (2b review N9).
        ran = sb.run_sandboxed(kind, sha, release, scratch, os.path.join(scratch, PROBE_NAME), args, runner,
                               ident.realpath)
        return _outcome(ran, mode, ident), False
    except sb.Unconfirmed as e:
        return Step('transient', f'{e}; scratch kept at {scratch} for inspection', ident), True
    except sb.Transient as e:
        return Step('transient', str(e), ident), False


def _compatible(sha, release, runner, node, glibc):
    """(Node identity, None) when this host can run the release, else (identity or None, Step without running it)."""
    try:
        ident = sb.node_identity(node, runner)
        libc = glibc()
    except (OSError, subprocess.SubprocessError, ValueError, IndexError, AttributeError) as e:
        # A host that will not say which Node or glibc it runs says nothing about the candidate (#817 AI review).
        return None, Step('transient', f'host Node/glibc identity unavailable: {type(e).__name__}: {e}')
    try:
        check_release(release, sha, ident.modules, libc)
    except Refused as e:
        return ident, Step('failed', f'incompatible with this host: {e}', ident)
    return ident, None


def _prepare(ids, scratch_root):
    """(trial owner, scratch) or a transient Step: a host that cannot set the run up says nothing about the candidate."""
    try:
        owner = ids()
        return owner, _scratch(scratch_root, owner), None
    except KeyError:
        return None, None, Step('transient', f'no {sb.TRIAL_USER} user on this host')
    except OSError as e:
        return None, None, Step('transient', f'cannot prepare the sandbox scratch: {e.strerror or type(e).__name__}')


def probe(sha, roots, scratch_root, runner=bounded.run, node=sb.NODE, ids=trial_ids, glibc=host_glibc):
    """Tree still exact, built for this Node/ABI/glibc, and its native SQLite opens in the sandbox."""
    pub.verify_release(sha, roots)
    release = os.path.join(roots.releases, sha)
    ident, refused = _compatible(sha, release, runner, node, glibc)
    if refused:
        return refused
    _, scratch, unprepared = _prepare(ids, scratch_root)
    if unprepared:
        return unprepared
    keep = False
    try:
        step, keep = _run('probe', sha, release, scratch, ['native'], 'native', ident, runner)
        return step
    finally:
        if not keep:
            shutil.rmtree(scratch, ignore_errors=True)


def _expected_snapshot_sum(root_fd, name, label):
    try:
        fd = os.open(name + '.sha256', os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK, dir_fd=root_fd)
        with os.fdopen(fd, 'rb') as f:
            raw = f.read(129).decode('ascii', 'replace')
    except OSError as e:
        raise Refused(f'{label}.sha256: {e.strerror}') from None
    m = SNAPSHOT_SUM.fullmatch(raw)
    if not m:
        raise Refused(f'{label}.sha256: not a single sha256 line')
    return m.group(1)


def check_snapshot_name(name):
    if not isinstance(name, str) or not SNAPSHOT_NAME.fullmatch(name):
        raise Refused(f'not a pre snapshot name: {name!r}')


def copy_snapshot(snapshot_root, name, dest, ids, free=lambda path: shutil.disk_usage(path).free):
    """Copy snapshot_root/name into dest (new, 0600, owned by ids), hashing the same bytes; refuse on mismatch.

    The snapshot and its .sha256 are both opened relative to one handle on snapshot_root, none
    of them through a symlink (2b review S2), so the two reads cannot be pointed at different
    directories between them. Refuses before copying when the copy would leave less than
    MIN_FREE_AFTER_COPY free, and turns any I/O failure (ENOSPC included) into a refusal with
    the partial copy removed.
    """
    check_snapshot_name(name)
    label = os.path.join(snapshot_root, name)
    try:
        root_fd = os.open(snapshot_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as e:
        raise Refused(f'{snapshot_root}: cannot open the snapshot directory ({e.strerror})') from None
    try:
        _copy_from(root_fd, name, label, dest, ids, free)
    finally:
        os.close(root_fd)


def _copy_from(root_fd, name, label, dest, ids, free):
    want = _expected_snapshot_sum(root_fd, name, label)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK, dir_fd=root_fd)
    except OSError as e:
        raise Refused(f'{label}: cannot open ({e.strerror})') from None
    h = hashlib.sha256()
    try:
        with os.fdopen(fd, 'rb') as src:
            st = os.fstat(src.fileno())
            if not stat.S_ISREG(st.st_mode):
                raise Refused(f'{label}: not a regular file')
            left = free(os.path.dirname(dest)) - st.st_size
            if left < MIN_FREE_AFTER_COPY:
                raise Refused(f'{label}: copying {st.st_size} bytes would leave {left} free, '
                              f'under the {MIN_FREE_AFTER_COPY} the host must keep')
            out_fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(out_fd, 'wb') as out:
                # Exactly the size the free-space check counted (#817 AI review): a snapshot
                # that grows while copied is refused, not followed into the reserve.
                remaining = st.st_size
                while remaining > 0:
                    chunk = src.read(min(1 << 20, remaining))
                    if not chunk:
                        raise Refused(f'{label}: shrank while being copied')
                    h.update(chunk)
                    out.write(chunk)
                    remaining -= len(chunk)
                if src.read(1):
                    raise Refused(f'{label}: grew while being copied')
            if h.hexdigest() != want:
                raise Refused(f'{label}: sha256 {h.hexdigest()} != {want}')
            # Inside the try (2b review B1): a chown that fails is the host's problem, never a traceback.
            os.chown(dest, *ids)
    except OSError as e:
        if os.path.lexists(dest):
            os.unlink(dest)
        raise Refused(f'{label}: copy failed ({e.strerror or type(e).__name__})') from None
    except Refused:
        if os.path.lexists(dest):
            os.unlink(dest)
        raise


def trial(sha, snapshot, roots, scratch_root, snapshot_root, runner=bounded.run, node=sb.NODE, ids=trial_ids,
          glibc=host_glibc, free=lambda path: shutil.disk_usage(path).free):
    """Migrate a private copy of the pre snapshot `snapshot_root/<snapshot>` twice with the release's own code."""
    check_snapshot_name(snapshot)
    pub.verify_release(sha, roots)
    release = os.path.join(roots.releases, sha)
    # The same gate as the probe: no release code runs on a host it was not built for (#817 AI review).
    ident, refused = _compatible(sha, release, runner, node, glibc)
    if refused:
        return refused
    owner, scratch, unprepared = _prepare(ids, scratch_root)
    if unprepared:
        return unprepared
    keep = False
    try:
        db = os.path.join(scratch, 'trial.db')
        try:
            copy_snapshot(snapshot_root, snapshot, db, owner, free)
        except Refused as e:
            # A bad snapshot or a full disk says nothing about the candidate; the next tick retries.
            return Step('transient', f'snapshot unusable: {e}')
        # The copy took time: the tree the sandbox runs is checked again right before it (2b review N4).
        pub.verify_release(sha, roots)
        step, keep = _run('trial', sha, release, scratch, ['migrate', db], 'migrate', ident, runner)
        return step
    finally:
        if not keep:
            shutil.rmtree(scratch, ignore_errors=True)
