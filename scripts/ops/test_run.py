#!/usr/bin/env python3
"""Linux test supervisor. Inventory is read-only; only this run's root is removed."""
import argparse
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class SafetyError(Exception):
    pass


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def start_time(pid):
    # comm can contain spaces and parentheses; fields after the LAST ')' are stable.
    return int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19])


def default_base():
    return Path(os.environ.get('WBB_TEST_RUNS_DIR',
                               str(Path(tempfile.gettempdir()) / f'wbb-test-runs-{os.getuid()}')))


def private_directory(path):
    """Open every component without symlink traversal, then verify private ownership."""
    path = Path(os.path.abspath(path))
    fd = os.open('/', DIRECTORY_FLAGS)
    try:
        parts = path.parts[1:]
        for index, part in enumerate(parts):
            if index == len(parts) - 1:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise SafetyError('test base must be owned by the current uid with mode 0700')
        return path, fd
    except BaseException:
        os.close(fd)
        raise


def write_metadata(fd, value):
    handle = os.open('run.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=fd)
    with os.fdopen(handle, 'w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.fsync(fd)


def check_tree(fd, device):
    """Only directory entries; symlink targets are never opened."""
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if info.st_dev != device:
            raise SafetyError('run tree crosses a filesystem; retained')
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, DIRECTORY_FLAGS, dir_fd=fd)
            try:
                if os.fstat(child).st_ino != info.st_ino:
                    raise SafetyError('run tree changed during cleanup; retained')
                check_tree(child, device)
            finally:
                os.close(child)


def remove_owned(base_fd, name, root_fd):
    original = os.fstat(root_fd)
    current = os.stat(name, dir_fd=base_fd, follow_symlinks=False)
    if (current.st_dev, current.st_ino, current.st_uid, stat.S_IMODE(current.st_mode)) != (
            original.st_dev, original.st_ino, os.getuid(), 0o700):
        raise SafetyError('run root identity changed; retained')
    check_tree(root_fd, original.st_dev)
    if not shutil.rmtree.avoids_symlink_attacks:
        raise SafetyError('fd-safe rmtree is required; retained')
    finished = '.finished-' + uuid.uuid4().hex
    os.mkdir(finished, 0o700, dir_fd=base_fd)
    staging_fd = os.open(finished, DIRECTORY_FLAGS, dir_fd=base_fd)
    try:
        os.rename(name, 'root', src_dir_fd=base_fd, dst_dir_fd=staging_fd)
        claimed = os.stat('root', dir_fd=staging_fd, follow_symlinks=False)
        if (claimed.st_dev, claimed.st_ino) != (original.st_dev, original.st_ino):
            raise SafetyError('claimed root identity changed; retained')
        shutil.rmtree('root', dir_fd=staging_fd)
    finally:
        os.close(staging_fd)
    os.rmdir(finished, dir_fd=base_fd)


def direct_children():
    return [int(pid) for pid in Path(
        f'/proc/self/task/{os.getpid()}/children').read_text().split()]


def run(command, base):
    if not sys.platform.startswith('linux'):
        raise SafetyError('test supervision requires Linux and Python 3; no unsafe fallback')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise SafetyError('cannot establish child subreaper; tests were not started')
    base, base_fd = private_directory(base)
    name = 'run-' + uuid.uuid4().hex
    root_fd = lease_fd = None
    interrupted = 0
    main = None
    main_status = None
    signalled = set()

    def interrupted_by(signum, _frame):
        nonlocal interrupted
        interrupted = interrupted or signum

    previous = {s: signal.signal(s, interrupted_by) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        # Coordinate publication/removal with inventories, without a leftover
        # registry file or a lock held for the duration of a test run.
        fcntl.flock(base_fd, fcntl.LOCK_EX)
        os.mkdir(name, 0o700, dir_fd=base_fd)
        root_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=base_fd)
        os.mkdir('tmp', 0o700, dir_fd=root_fd)
        lease_fd = os.open('lease.lock', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                           0o600, dir_fd=root_fd)
        fcntl.flock(lease_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        info = os.fstat(root_fd)
        identity = {'version': 1, 'id': name[4:], 'uid': os.getuid(),
                    'device': info.st_dev, 'inode': info.st_ino, 'boot_id': boot_id(),
                    'supervisor_pid': os.getpid(), 'supervisor_start': start_time(os.getpid())}
        write_metadata(root_fd, identity)
        fcntl.flock(base_fd, fcntl.LOCK_UN)
        payload = str(base / name / 'tmp')
        env = dict(os.environ, TMPDIR=payload, TMP=payload, TEMP=payload,
                   WBB_TEST_TMPDIR=payload, WBB_TEST_RUN_ID=identity['id'],
                   NODE_COMPILE_CACHE=str(Path(payload) / 'node-compile-cache'))
        if interrupted:
            main_status = 128 + interrupted
        else:
            try:
                main = subprocess.Popen(command, env=env, start_new_session=True)
            except OSError:
                main_status = 127
        while main is not None:
            if interrupted:
                # Only unreaped direct children belong to us; a detached orphan is
                # adopted here even if it escaped the initial process group.
                for pid in direct_children():
                    try:
                        identity_key = (pid, start_time(pid))
                        if identity_key not in signalled:
                            if pid == main.pid and main_status is None:
                                os.killpg(pid, interrupted)
                            else:
                                os.kill(pid, interrupted)
                            signalled.add(identity_key)
                    except ProcessLookupError:
                        pass
                    except FileNotFoundError:
                        pass
            try:
                pid, status_code = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:  # ECHILD proves all descendants ended.
                break
            if pid == main.pid:
                main.returncode = os.waitstatus_to_exitcode(status_code)
                main_status = main.returncode if main.returncode >= 0 else 128 - main.returncode
            if pid == 0:
                time.sleep(0.02)
        if main_status is None:
            raise SafetyError('initial child status is unknown; retained')
        fcntl.flock(base_fd, fcntl.LOCK_EX)
        remove_owned(base_fd, name, root_fd)
        fcntl.flock(base_fd, fcntl.LOCK_UN)
        return 128 + interrupted if interrupted else main_status
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        for fd in (lease_fd, root_fd, base_fd):
            if fd is not None:
                os.close(fd)


def observed_processes(ids):
    """One bounded metadata scan, never print/read application file contents."""
    found = {identity: [] for identity in ids}
    errors = 0
    deadline = time.monotonic() + 2
    for name in os.listdir('/proc'):
        if time.monotonic() > deadline:
            errors += 1
            break
        if not name.isdigit():
            continue
        try:
            process = Path('/proc') / name
            if process.stat().st_uid != os.getuid():
                continue
            environ = (process / 'environ').read_bytes().split(b'\0')
            for identity in ids:
                if f'WBB_TEST_RUN_ID={identity}'.encode() in environ:
                    found[identity].append(int(name))
        except (FileNotFoundError, ProcessLookupError):
            pass
        except PermissionError:
            errors += 1
    return found, errors


def inventory(base):
    """Do not delete crash leftovers, even if a process audit observes none."""
    if not Path(base).exists() and not Path(base).is_symlink():
        return []
    base, fd = private_directory(base)
    records = []
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        for name in sorted(os.listdir(fd))[:256]:
            row = {'name': name, 'status': 'uncertain_metadata'}
            root_fd = lease_fd = None
            try:
                if not re.fullmatch(r'run-[0-9a-f]{32}', name):
                    raise SafetyError('unrecognised run name')
                root_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=fd)
                info = os.fstat(root_fd)
                handle = os.open('run.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
                with os.fdopen(handle) as stream:
                    metadata_stat = os.fstat(stream.fileno())
                    if (not stat.S_ISREG(metadata_stat.st_mode) or metadata_stat.st_uid != os.getuid()
                            or metadata_stat.st_nlink != 1 or metadata_stat.st_size > 4096):
                        raise SafetyError('unsafe or oversize run metadata')
                    data = json.load(stream)
                if (data['version'], data['id'], data['uid'], data['device'], data['inode'],
                    info.st_uid, stat.S_IMODE(info.st_mode)) != (
                        1, name[4:], os.getuid(), info.st_dev, info.st_ino, os.getuid(), 0o700):
                    raise SafetyError('run identity mismatch')
                lease_fd = os.open('lease.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
                lease_stat = os.fstat(lease_fd)
                if (not stat.S_ISREG(lease_stat.st_mode) or lease_stat.st_uid != os.getuid()
                        or lease_stat.st_nlink != 1):
                    raise SafetyError('unsafe lease')
                locked = False
                try:
                    fcntl.flock(lease_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    locked = True
                row['id'] = data['id']
                if data['boot_id'] != boot_id():
                    row['status'] = 'previous_boot_retained'
                else:
                    row['status'] = 'uncertain_current_boot'
                    try:
                        same = start_time(data['supervisor_pid']) == data['supervisor_start']
                        if same and locked:
                            row['status'] = 'active'
                    except (FileNotFoundError, ProcessLookupError):
                        pass
            except (OSError, ValueError, KeyError, TypeError, SafetyError):
                pass  # Unknown identity means retained, never permission to delete.
            finally:
                for handle in (lease_fd, root_fd):
                    if handle is not None:
                        os.close(handle)
            records.append(row)
        if len(os.listdir(fd)) > 256:
            records.append({'name': '(inventory truncated)', 'status': 'uncertain_metadata'})
    finally:
        os.close(fd)
    observed, errors = observed_processes([r['id'] for r in records if 'id' in r])
    for row in records:
        references = observed.get(row.get('id'), [])
        row['observed_processes'] = references
        row['audit_errors'] = errors
        if references and row['status'] != 'active':
            row['status'] = 'observed_processes'
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=default_base())
    parser.add_argument('--inspect', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.inspect:
        print(json.dumps(inventory(args.base)))
        return 0
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('a command after -- is required')
    return run(command, args.base)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except BlockingIOError:
        print(json.dumps({'status': 'registry_busy', 'retained': True}))
        sys.exit(75)
    except (OSError, SafetyError) as error:
        print(f'test-run: retained on failure ({type(error).__name__})', file=sys.stderr)
        sys.exit(125)
