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
import publish as pub  # noqa: E402
import sandbox as sb  # noqa: E402
from safe_tar import Refused  # noqa: E402
from verify_payload import check_release  # noqa: E402

PROBE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'payload-probe.cjs')
SNAPSHOT_SUM = re.compile(r'([0-9a-f]{64})\n?')
RESULT = re.compile(r'PROBE (OK|FAILED) (native|migrate): (.*)')


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


def _outcome(code, stdout, mode, ident):
    lines = [line for line in stdout.splitlines() if line.startswith('PROBE ')]
    m = RESULT.fullmatch(lines[-1]) if lines else None
    if m is None or m.group(2) != mode:
        return Step('failed', f'{mode}: no result line from the probe (exit {code}): {stdout.strip()[-500:]!r}', ident)
    if m.group(1) == 'OK' and code == 0:
        return Step('ok', f'{mode}: {m.group(3)}', ident)
    return Step('failed', f'{mode}: {m.group(3)}', ident)


def probe(sha, roots, scratch_root, runner=subprocess.run, node=sb.NODE, ids=trial_ids, glibc=_host_glibc):
    """Tree still exact, built for this Node/ABI/glibc, and its native SQLite opens in the sandbox."""
    pub.verify_release(sha, roots)
    release = os.path.join(roots.releases, sha)
    ident = sb.node_identity(node, runner)
    try:
        check_release(release, sha, ident.modules, glibc())
    except Refused as e:
        return Step('failed', f'incompatible with this host: {e}', ident)
    scratch = _scratch(scratch_root, ids())
    try:
        code, out = sb.run_sandboxed('probe', sha, release, scratch, PROBE_FILE, ['native'], runner, node)
        return _outcome(code, out, 'native', ident)
    except sb.Transient as e:
        return Step('transient', str(e), ident)
    finally:
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


def copy_snapshot(snapshot, dest, ids):
    """Copy snapshot into dest (new, 0600, owned by ids), hashing the same bytes; refuse on mismatch."""
    if not os.path.isabs(snapshot):
        raise Refused(f'snapshot path must be absolute: {snapshot!r}')
    want = _expected_snapshot_sum(snapshot)
    try:
        fd = os.open(snapshot, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        raise Refused(f'{snapshot}: cannot open ({e.strerror})') from None
    h = hashlib.sha256()
    with os.fdopen(fd, 'rb') as src:
        if not stat.S_ISREG(os.fstat(src.fileno()).st_mode):
            raise Refused(f'{snapshot}: not a regular file')
        out_fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(out_fd, 'wb') as out:
            for chunk in iter(lambda: src.read(1 << 20), b''):
                h.update(chunk)
                out.write(chunk)
    if h.hexdigest() != want:
        os.unlink(dest)
        raise Refused(f'{snapshot}: sha256 {h.hexdigest()} != {want}')
    os.chown(dest, *ids)


def trial(sha, snapshot, roots, scratch_root, runner=subprocess.run, node=sb.NODE, ids=trial_ids):
    """Migrate a private copy of the pre snapshot twice with the release's own code, in the sandbox."""
    pub.verify_release(sha, roots)
    release = os.path.join(roots.releases, sha)
    owner = ids()
    scratch = _scratch(scratch_root, owner)
    try:
        db = os.path.join(scratch, 'trial.db')
        try:
            copy_snapshot(snapshot, db, owner)
        except Refused as e:
            # A bad snapshot says nothing about the candidate; the next tick takes a new one.
            return Step('transient', f'snapshot unusable: {e}')
        pub.verify_release(sha, roots)
        code, out = sb.run_sandboxed('trial', sha, release, scratch, PROBE_FILE, ['migrate', db], runner, node)
        return _outcome(code, out, 'migrate', None)
    except sb.Transient as e:
        return Step('transient', str(e))
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
