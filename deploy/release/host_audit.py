"""Host audit of an accepted release's lockfile, before any of its code runs.

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §5 (audit 2 of 2).
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2b.md, Task 2.

CI audited the tree when it was built; advisories keep arriving, so the host asks the
registry again right before a new activation. Only the two files npm needs are copied
out of releases/<sha> into a fresh private directory: probe A2 showed a .npmrc beside
the lockfile is read, so nothing else may be there. The registry is named on the
command line, both npm config files are empty files of our own (probe A3: they cannot
share a path), the environment is PATH and HOME only, and no install, build or
lifecycle script runs. The verdict comes from the JSON (audit_verdict.py), never from
npm's exit code; a timeout or a missing report is `unrunnable` — retry later, not a
failed SHA.
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audit_verdict import Verdict, audit_verdict  # noqa: E402
from safe_tar import Refused  # noqa: E402

NPM = '/usr/bin/npm'
REGISTRY = 'https://registry.npmjs.org/'
PROJECT_FILES = ('package.json', 'package-lock.json')
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_REPORT_BYTES = 32 * 1024 * 1024
TIMEOUT_S = 120
PATH = '/usr/bin:/bin'


def _copy_regular(src, dest, cap):
    try:
        fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        raise Refused(f'{src}: cannot open ({e.strerror})') from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise Refused(f'{src}: not a regular file')
        if st.st_size > cap:
            raise Refused(f'{src}: {st.st_size} bytes, over {cap}')
        data = os.read(fd, cap + 1)
        while len(data) <= cap:
            chunk = os.read(fd, cap + 1 - len(data))
            if not chunk:
                break
            data += chunk
        if len(data) > cap:
            raise Refused(f'{src}: grew past {cap} bytes while reading')
    finally:
        os.close(fd)
    out = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(out, 'wb') as f:
        f.write(data)


def audit_argv(npm, userconfig, globalconfig):
    return [npm, 'audit', '--omit=dev', '--package-lock-only', '--json',
            '--userconfig', userconfig, '--globalconfig', globalconfig,
            '--registry', REGISTRY, '--ignore-scripts']


def audit_release(release_dir, workdir, runner=subprocess.run, npm=NPM, extra_env=None, euid=os.geteuid):
    """Verdict of a fresh npm audit of release_dir's lockfile. Never runs as root.

    extra_env exists for a live probe behind a TLS-intercepting proxy (a CA bundle);
    production passes nothing, so the environment is exactly PATH and HOME.
    """
    if euid() == 0:
        raise Refused('the host audit must not run as root')
    base = tempfile.mkdtemp(dir=workdir, prefix='audit-')
    try:
        project = os.path.join(base, 'project')
        home = os.path.join(base, 'home')
        os.mkdir(project, 0o700)
        os.mkdir(home, 0o700)
        for name in PROJECT_FILES:
            _copy_regular(os.path.join(release_dir, name), os.path.join(project, name), MAX_FILE_BYTES)
        userconfig = os.path.join(base, 'user.npmrc')
        globalconfig = os.path.join(base, 'global.npmrc')
        for path in (userconfig, globalconfig):
            os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        env = {'PATH': PATH, 'HOME': home, **(extra_env or {})}
        try:
            result = runner(audit_argv(npm, userconfig, globalconfig), cwd=project, env=env,
                            capture_output=True, timeout=TIMEOUT_S, check=False)
        except subprocess.TimeoutExpired:
            return Verdict('unrunnable', reason=f'never arrived — npm audit timed out after {TIMEOUT_S} s')
        except OSError as e:
            return Verdict('unrunnable', reason=f'never arrived — npm could not start ({e.strerror})')
        if len(result.stdout) > MAX_REPORT_BYTES:
            return Verdict('unrunnable', reason=f'is over {MAX_REPORT_BYTES} bytes — not a report we read')
        verdict = audit_verdict(result.stdout.decode('utf-8', 'replace'))
        stderr = result.stderr.decode('utf-8', 'replace').strip()
        if verdict.kind == 'unrunnable' and stderr:
            # Without this an empty report says nothing about why (an npm that would not
            # start, a TLS failure); the environment holds no credential to leak.
            return Verdict('unrunnable', reason=f'{verdict.reason} (npm stderr: {stderr[-500:]})')
        return verdict
    finally:
        shutil.rmtree(base, ignore_errors=True)
