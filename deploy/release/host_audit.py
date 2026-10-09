"""Host audit of an accepted release's lockfile, before any of its code runs.

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §5 (audit 2 of 2).
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2b.md, Task 2.

CI audited the tree when it was built; advisories keep arriving, so the host asks the
registry again right before a new activation. It runs as the operator, who cannot read
the root-only receipt (#817 review): the two files npm needs are proven against the
release's own root-owned tree-manifest.json instead, hashed as they are read, and the
manifest's digest is returned for the controller to match against the receipt. Only
those two files go into a fresh private directory: probe A2 showed a .npmrc beside
the lockfile is read, so nothing else may be there. The registry is named on the
command line, both npm config files are empty files of our own (probe A3: they cannot
share a path), the environment is PATH and HOME only, and no install, build or
lifecycle script runs. The verdict comes from the JSON (audit_verdict.py), never from
npm's exit code; a timeout or a missing report is `unrunnable` — retry later, not a
failed SHA.
"""
import functools
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounded  # noqa: E402
import tree_manifest as tm  # noqa: E402
from audit_verdict import Verdict, audit_verdict  # noqa: E402
from safe_tar import Refused  # noqa: E402

NPM = '/usr/bin/npm'
REGISTRY = 'https://registry.npmjs.org/'
PROJECT_FILES = ('package.json', 'package-lock.json')
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_REPORT_BYTES = 32 * 1024 * 1024
TIMEOUT_S = 120
PATH = '/usr/bin:/bin'


@dataclass(frozen=True)
class AuditResult:
    verdict: Verdict
    # sha256 of the release's tree-manifest.json the audited bytes were checked against. The
    # receipt is root-only (0600), so the operator cannot read it; the controller compares
    # this digest with the receipt through the root `verify` step before acting on the verdict.
    tree_sha256: str


def _read_owned(path, owner, cap, want_mode=None):
    """Bytes of a regular file owned by owner, not writable by group/other (exact mode if given)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        raise Refused(f'{path}: cannot open ({e.strerror})') from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise Refused(f'{path}: not a regular file')
        if (st.st_uid, st.st_gid) != owner or st.st_mode & 0o022 or (
                want_mode is not None and stat.S_IMODE(st.st_mode) != want_mode):
            raise Refused(f'{path}: owner {st.st_uid}:{st.st_gid} mode {stat.S_IMODE(st.st_mode):04o} — '
                          f'not a file of an accepted release')
        if st.st_size > cap:
            raise Refused(f'{path}: {st.st_size} bytes, over {cap}')
        chunks, total = [], 0
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            total += len(chunk)
            if total > cap:
                raise Refused(f'{path}: grew past {cap} bytes while reading')
            chunks.append(chunk)
        return b''.join(chunks)
    finally:
        os.close(fd)


def _check_dir(path, owner):
    try:
        st = os.lstat(path)
    except OSError as e:
        raise Refused(f'{path}: {e.strerror} — no accepted release here') from None
    if not stat.S_ISDIR(st.st_mode) or (st.st_uid, st.st_gid) != owner or st.st_mode & 0o022:
        raise Refused(f'{path}: owner {st.st_uid}:{st.st_gid} mode {stat.S_IMODE(st.st_mode):04o} — '
                      'not a directory only the release owner can change')


def release_inputs(release_dir, owner):
    """package.json and package-lock.json of an accepted release, proven without the root-only receipt.

    Only the owner (root in production) can change releases/ and the tree, so the tree's own
    tree-manifest.json is as trustworthy as the tree; each file's bytes are hashed as read and
    must equal its manifest entry. Returns ({name: bytes}, sha256 of the manifest).
    """
    _check_dir(os.path.dirname(os.path.abspath(release_dir)), owner)
    _check_dir(release_dir, owner)
    manifest_bytes = _read_owned(os.path.join(release_dir, tm.MANIFEST_NAME), owner, MAX_MANIFEST_BYTES, 0o644)
    try:
        entries = {e['path']: e for e in json.loads(manifest_bytes)['entries']}
    except (ValueError, KeyError, TypeError):
        raise Refused(f'{release_dir}: unreadable tree-manifest.json') from None
    files = {}
    for name in PROJECT_FILES:
        data = _read_owned(os.path.join(release_dir, name), owner, MAX_FILE_BYTES, 0o644)
        want = entries.get(name, {})
        if want.get('type') != 'file' or (want.get('size'), want.get('sha256')) != (len(data), hashlib.sha256(data).hexdigest()):
            raise Refused(f'{release_dir}/{name}: does not match the release manifest')
        files[name] = data
    return files, hashlib.sha256(manifest_bytes).hexdigest()


def audit_argv(npm, userconfig, globalconfig):
    return [npm, 'audit', '--omit=dev', '--package-lock-only', '--json',
            '--userconfig', userconfig, '--globalconfig', globalconfig,
            '--registry', REGISTRY, '--ignore-scripts']


def audit_release(release_dir, workdir, owner=(0, 0), runner=None, npm=NPM, extra_env=None, euid=os.geteuid):
    """AuditResult of a fresh npm audit of release_dir's lockfile. Never runs as root.

    extra_env exists for a live probe behind a TLS-intercepting proxy (a CA bundle);
    production passes nothing, so the environment is exactly PATH and HOME.
    """
    if euid() == 0:
        raise Refused('the host audit must not run as root')
    # Bounded capture: a report larger than we would read is cut while it streams, not after
    # it has filled memory (#817 AI review).
    runner = runner or functools.partial(bounded.run, cap=MAX_REPORT_BYTES + 1)
    files, tree_sha256 = release_inputs(release_dir, owner)
    base = tempfile.mkdtemp(dir=workdir, prefix='audit-')
    try:
        project = os.path.join(base, 'project')
        home = os.path.join(base, 'home')
        os.mkdir(project, 0o700)
        os.mkdir(home, 0o700)
        for name, data in files.items():
            fd = os.open(os.path.join(project, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
        userconfig = os.path.join(base, 'user.npmrc')
        globalconfig = os.path.join(base, 'global.npmrc')
        for path in (userconfig, globalconfig):
            os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        env = {'PATH': PATH, 'HOME': home, **(extra_env or {})}
        return AuditResult(_run_audit(runner, npm, userconfig, globalconfig, project, env), tree_sha256)
    finally:
        shutil.rmtree(base, ignore_errors=True)


def _run_audit(runner, npm, userconfig, globalconfig, project, env):
    try:
        result = runner(audit_argv(npm, userconfig, globalconfig), cwd=project, env=env,
                        capture_output=True, timeout=TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
        return Verdict('unrunnable', reason=f'never arrived — npm audit timed out after {TIMEOUT_S} s')
    except OSError as e:
        return Verdict('unrunnable', reason=f'never arrived — npm could not start ({e.strerror})')
    if len(result.stdout) > MAX_REPORT_BYTES or getattr(result, 'truncated', False) and len(result.stdout) >= MAX_REPORT_BYTES:
        return Verdict('unrunnable', reason=f'is over {MAX_REPORT_BYTES} bytes — not a report we read')
    verdict = audit_verdict(result.stdout.decode('utf-8', 'replace'))
    stderr = result.stderr.decode('utf-8', 'replace').strip()
    if verdict.kind == 'unrunnable' and stderr:
        # Without this an empty report says nothing about why (an npm that would not
        # start, a TLS failure); the environment holds no credential to leak.
        return Verdict('unrunnable', reason=f'{verdict.reason} (npm stderr: {stderr[-500:]})')
    return verdict
