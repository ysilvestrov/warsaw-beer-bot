#!/usr/bin/env bash
# Run as the operator, without sudo. Installs no bot code or production unit.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -B - "$PWD" <<'PY'
import fcntl, hashlib, os, pathlib, shlex, stat, subprocess, sys, tempfile

repo = pathlib.Path(sys.argv[1])
home = pathlib.Path(os.environ.get('WBB_OPS_HOME', str(pathlib.Path.home()))).absolute()
crontab = os.environ.get('WBB_CRONTAB', '/usr/bin/crontab')
marker = '# Managed by warsaw-beer-bot resource monitor installer'
begin, end = '# BEGIN wbb-resource-monitor', '# END wbb-resource-monitor'

def ensure(path, private=False):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(part, 0o700, dir_fd=fd)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or (private and stat.S_IMODE(info.st_mode) != 0o700):
            raise RuntimeError('operator directory ownership/mode mismatch')
    finally:
        os.close(fd)

def table():
    result = subprocess.run([crontab, '-l'], capture_output=True, text=True)
    if result.returncode == 1 and 'no crontab for' in result.stderr:
        return ''
    if result.returncode != 0:
        raise RuntimeError('cannot read current crontab')
    return result.stdout

def write(path, data, mode=0o600):
    if path.is_symlink():
        raise RuntimeError('refusing symlink destination')
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        name = stream.name
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

try:
    if '\n' in str(home) or '%' in str(home):
        raise RuntimeError('unsupported path characters for cron')
    state = home / '.local/state/wbb-resource-monitor'
    tools = home / '.local/lib/wbb-ops'
    binaries = home / '.local/bin'
    ensure(state, private=True)
    ensure(tools, private=True)
    ensure(binaries)
    lock = os.open(state/'install.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX)
    wrapper = binaries / 'wbb-test'
    if wrapper.exists() or wrapper.is_symlink():
        wrapper_fd = os.open(wrapper, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(wrapper_fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_nlink != 1 or info.st_size > 4096
                    or marker.encode() not in os.read(wrapper_fd, 4096)):
                raise RuntimeError('existing wbb-test is unrelated; retained')
        finally:
            os.close(wrapper_fd)
    original = table()
    lines = original.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if line.strip() == begin]
    ends = [i for i, line in enumerate(lines) if line.strip() == end]
    if len(starts) != len(ends) or len(starts) > 1 or (starts and starts[0] >= ends[0]):
        raise RuntimeError('malformed existing managed cron block; retained')
    unrelated = ''.join(lines[:starts[0]] + lines[ends[0]+1:]) if starts else original
    if 'resource_monitor.py' in unrelated or 'wbb-resource-monitor' in unrelated:
        raise RuntimeError('an unmanaged resource monitor already exists; retained')
    payloads = {name: (repo/'scripts/ops'/name).read_bytes()
                for name in ('test_run.py', 'resource_monitor.py')}
    version = hashlib.sha256(b''.join(payloads.values())).hexdigest()[:16]
    installed = tools/version
    ensure(installed, private=True)
    for name, payload in payloads.items():
        destination = installed/name
        if destination.exists() or destination.is_symlink():
            if destination.is_symlink() or destination.read_bytes() != payload:
                raise RuntimeError('installed version differs from verified payload; retained')
        else:
            write(destination, payload)
    wrapper_body = ('#!/bin/sh\n' + marker + '\nexec /usr/bin/python3 -B ' +
                    shlex.quote(str(installed/'test_run.py')) +
                    ' -- node ./node_modules/vitest/vitest.mjs run "$@"\n')
    write(wrapper, wrapper_body.encode(), 0o700)
    command = ['/usr/bin/timeout', '60s', '/usr/bin/nice', '-n', '19', '/usr/bin/ionice', '-c', '3',
               '/usr/bin/python3', '-B', str(installed/'resource_monitor.py'),
               '--state-dir', str(state), '--runs-dir', f'/tmp/wbb-test-runs-{os.getuid()}',
               '--notify', 'telegram']
    block = begin + '\n*/5 * * * * ' + shlex.join(command) + ' >/dev/null 2>&1\n' + end + '\n'
    replacement = unrelated + ('' if not unrelated or unrelated.endswith('\n') else '\n') + block
    backup = state/'crontab.before-install'
    if not backup.exists():
        write(backup, original.encode())
    write(state/'crontab.previous-install', original.encode())
    if table() != original:
        raise RuntimeError('crontab changed during preparation; retry without overwriting it')
    with tempfile.NamedTemporaryFile(mode='w', dir=state, delete=False) as stream:
        stream.write(replacement)
        stream.flush()
        proposal = stream.name
    try:
        if subprocess.run([crontab, proposal], capture_output=True).returncode != 0:
            raise RuntimeError('crontab installation failed')
    finally:
        os.unlink(proposal)
    print(f'Installed operator tools: {installed}; five-minute cron and {wrapper}')
except (OSError, RuntimeError) as error:
    reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    print(f'Install refused: {reason}', file=sys.stderr)
    sys.exit(1)
PY
