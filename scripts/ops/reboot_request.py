#!/usr/bin/env python3
"""#469 stage 3: act on the bot's reboot request — the bot asks, root decides.

The bot writes /var/lib/wbb-host-patch/reboot-request ("now <unix>" or "0400 <unix>");
wbb-reboot-request.path starts this as root. The request is deleted in every case before
anything is done, so a refused or repeated request is never acted on twice. A compromised
bot can at worst reboot the host; it gains no root command.
Spec: docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md (Stage 3).
"""
import argparse
import os
import re
import stat
import subprocess
import sys
import time

REQUEST = '/var/lib/wbb-host-patch/reboot-request'
# Debian's pending-reboot flag: root acts only while the host really needs a reboot.
PENDING_FLAG = '/run/reboot-required'
MAX_BYTES = 64
MAX_AGE_SECONDS = 600
FUTURE_SKEW_SECONDS = 60
LINE = re.compile(rb'\A(now|0400) (\d{1,12})\n?\Z')
REBOOT = ['systemctl', 'reboot']
# The fixed unit name makes a second press harmless: systemd-run refuses a loaded unit (C22).
AT_0400 = ['systemd-run', '--unit=wbb-reboot-0400', '--on-calendar=*-*-* 04:00:00 Europe/Warsaw',
           '--timer-property=AccuracySec=1min', 'systemctl', 'reboot']
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}


def run(argv):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60, env=ENV)
    return result.returncode, result.stderr


def take(path):
    """The request's bytes, or None for anything but a small regular file that was deleted.

    Deletes it either way; a request that could not be deleted is a refusal, never an action.
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return b''  # nothing there: the caller tells "no request" from "refused" by existence
    except OSError:
        fd = None  # a symlink (ELOOP), a directory, …
    data = None
    try:
        if fd is not None:
            info = os.fstat(fd)
            if stat.S_ISREG(info.st_mode) and info.st_size <= MAX_BYTES:
                data = os.read(fd, MAX_BYTES + 1)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(path)  # never follows a symlink: removes the link, not its target
        except FileNotFoundError:
            pass
        except OSError:  # IsADirectoryError, PermissionError, …
            data = None
    return data


def handle(path, run_command, now, flag=PENDING_FLAG):
    """(exit code, journal message)."""
    if not os.path.lexists(path):
        return 0, 'no request'
    data = take(path)
    if data is None:
        return 1, 'refused: not a small regular file'
    m = LINE.match(data)
    if m is None:
        return 1, 'refused: unknown content'
    kind, at = m.group(1).decode(), int(m.group(2))
    if not (now - MAX_AGE_SECONDS <= at <= now + FUTURE_SKEW_SECONDS):
        return 1, 'refused: stale or future request'
    if not os.path.exists(flag):
        return 1, 'refused: no reboot pending'
    if kind == 'now':
        code, err = run_command(REBOOT)
        return (0, 'reboot now') if code == 0 else (1, f'systemctl reboot failed: {err.strip()}')
    code, err = run_command(AT_0400)
    if code == 0:
        return 0, 'reboot scheduled for 04:00 Europe/Warsaw'
    if 'already loaded' in err:
        return 0, 'reboot already scheduled for 04:00'
    return 1, f'systemd-run failed: {err.strip()}'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--path', default=REQUEST, help=argparse.SUPPRESS)
    parser.add_argument('--flag', default=PENDING_FLAG, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    code, message = handle(args.path, run, int(time.time()), args.flag)
    print(f'wbb-reboot-request: {message}', file=sys.stderr if code else sys.stdout)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
