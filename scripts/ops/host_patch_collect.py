#!/usr/bin/env python3
"""#469 stage 2: root host-patch collector. Local facts only, never the network.

Writes /var/tmp/wbb-host-patch/summary.json atomically: directory 0755 and file 0644,
both owned by the user running it (root in production). A fact it cannot read is
written as null, never guessed. Spec:
docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md (Stage 2).
"""
import argparse
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time

OUT_DIR = '/var/tmp/wbb-host-patch'
SUMMARY = 'summary.json'
PACKAGES = ('nodejs', 'cloudflared', 'litestream')
LIVEPATCH_OK = ('applied', 'nothing-to-apply')
TIMEOUT_SECONDS = 120
# /snap/bin: canonical-livepatch is a snap. It only starts in its own unit's cgroup (spec C15).
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin', 'LC_ALL': 'C'}


def run(argv):
    """stdout of a command that exited 0; any other outcome raises."""
    result = subprocess.run(argv, capture_output=True, text=True, timeout=TIMEOUT_SECONDS, env=ENV)
    if result.returncode != 0:
        raise RuntimeError(f'{argv[0]} exited {result.returncode}')
    return result.stdout


def attempt(read):
    """A fact that cannot be read is null, never guessed."""
    try:
        return read()
    except Exception:
        return None


def parse_needrestart(text):
    kernel = {}
    services = []
    for line in text.splitlines():
        key, sep, value = line.partition(': ')
        if not sep:
            continue
        if key == 'NEEDRESTART-SVC':
            services.append(value.strip())
        elif key in ('NEEDRESTART-KCUR', 'NEEDRESTART-KEXP'):
            kernel[key] = value.strip()
    if set(kernel) != {'NEEDRESTART-KCUR', 'NEEDRESTART-KEXP'}:
        return None, services
    return {'running': kernel['NEEDRESTART-KCUR'],
            'newest_installed': kernel['NEEDRESTART-KEXP']}, services


def map_livepatch(text):
    running = [entry for entry in json.loads(text)['Status'] if entry.get('Running') is True]
    if len(running) != 1:
        raise ValueError('livepatch status names no single running kernel')
    current = running[0]
    if current.get('Supported') != 'supported':
        state = 'unsupported-kernel'
    else:
        raw = (current.get('Livepatch') or {}).get('State')
        state = raw if raw in LIVEPATCH_OK else 'unknown'
    date = current.get('UpgradeRequiredDate')
    return {'state': state, 'upgrade_required_date': date if isinstance(date, str) and date else None}


def count_security(text):
    """`apt list --upgradable` lines are `name/archive[,archive…] version arch [upgradable from: …]`."""
    count = 0
    for line in text.splitlines():
        _name, slash, rest = line.partition('/')
        if not slash or '[upgradable from:' not in rest:
            continue
        archives = rest.split(' ', 1)[0].split(',')
        if any(archive.endswith('-security') for archive in archives):
            count += 1
    return count


def boot_time(root):
    """`btime` of /proc/stat, or None when it cannot be read — never guessed."""
    try:
        for line in (root / 'proc/stat').read_text().splitlines():
            key, _sep, value = line.partition(' ')
            if key == 'btime':
                return int(value)
    except Exception:
        pass
    return None


def reboot_required(root, previous):
    """None means no reboot is pending. Any stat error other than ENOENT propagates (no write).

    notify-reboot-required rewrites the flag per package, so its mtime is the LATEST request;
    `since` carries forward the first one seen, unless a reboot has happened since."""
    try:
        since = int((root / 'var/run/reboot-required').stat().st_mtime)
    except FileNotFoundError:
        return None
    try:
        lines = (root / 'var/run/reboot-required.pkgs').read_text().splitlines()
    except FileNotFoundError:
        lines = []
    carried = (previous.get('reboot_required') or {}).get('since') if isinstance(previous, dict) \
        and isinstance(previous.get('reboot_required'), dict) else None
    booted = boot_time(root)
    if type(carried) is int and booted is not None and carried >= booted:
        since = min(carried, since)
    return {'since': since, 'packages': list(dict.fromkeys(l.strip() for l in lines if l.strip()))}


def last_run(root):
    try:
        return int((root / 'var/lib/apt/periodic/unattended-upgrades-stamp').stat().st_mtime)
    except FileNotFoundError:
        return None


def merge_stale(services, previous, now, booted):
    """A unit keeps the `since` of the first run that saw it stale; a unit no longer listed drops.

    /var/tmp survives a reboot, but the reboot proves every process fresh: a `since` from before
    the last boot is dropped, and with no readable boot time nothing is carried forward."""
    seen = {}
    entries = previous.get('stale_services') if isinstance(previous, dict) and booted is not None else None
    for entry in entries if isinstance(entries, list) else []:
        if (isinstance(entry, dict) and isinstance(entry.get('unit'), str)
                and type(entry.get('since')) is int and entry['since'] >= booted):
            seen[entry['unit']] = entry['since']
    return [{'unit': unit, 'since': min(seen.get(unit, now), now)} for unit in dict.fromkeys(services)]


def package_version(run_command, name):
    status, _tab, version = run_command(
        ['dpkg-query', '-W', '-f=${db:Status-Abbrev}\t${Version}', name]).partition('\t')
    return version.strip() or None if status[1:2] == 'i' else None


def collect(run_command, root, now, previous):
    needrestart = attempt(lambda: parse_needrestart(run_command(['needrestart', '-b', '-r', 'l'])))
    return {
        'version': 1,
        'timestamp': now,
        'kernel': needrestart[0] if needrestart else None,
        'reboot_required': reboot_required(root, previous),
        'livepatch': attempt(lambda: map_livepatch(
            run_command(['canonical-livepatch', 'status', '--format', 'json']))),
        'stale_services': merge_stale(needrestart[1], previous, now, boot_time(root)) if needrestart else None,
        'unattended': {
            'last_run': last_run(root),
            'security_pending': attempt(lambda: count_security(run_command(['apt', 'list', '--upgradable']))),
        },
        'packages': {name: attempt(lambda name=name: package_version(run_command, name)) for name in PACKAGES},
    }


def read_previous(out_dir):
    try:
        return json.loads(Path(out_dir, SUMMARY).read_text())
    except Exception:
        return None


def prepare_directory(out_dir):
    try:
        info = os.lstat(out_dir)
    except FileNotFoundError:
        os.mkdir(out_dir, 0o755)
        info = os.lstat(out_dir)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise RuntimeError(f'{out_dir} is not a directory owned by this user')
    os.chmod(out_dir, 0o755)


def write_summary(out_dir, summary):
    prepare_directory(out_dir)
    fd, temporary = tempfile.mkstemp(dir=out_dir, prefix='.summary-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(summary, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, os.path.join(out_dir, SUMMARY))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', default=OUT_DIR)
    parser.add_argument('--root', default='/', help=argparse.SUPPRESS)  # tests only
    args = parser.parse_args(argv)
    prepare_directory(args.out_dir)  # root reads nothing from a directory it has not verified
    summary = collect(run, Path(args.root), int(time.time()), read_previous(args.out_dir))
    write_summary(args.out_dir, summary)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
