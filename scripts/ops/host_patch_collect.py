#!/usr/bin/env python3
"""#469 stage 2: root host-patch collector. Local facts only, never the network.

Writes /var/tmp/wbb-host-patch/summary.json atomically: directory 0755 and file 0644,
both owned by the user running it (root in production). A fact it cannot read is
written as null, never guessed. Next to it, image.json (spec 2026-10-11 §10) with the
same discipline: its own file, so summary.json keeps the shape every bot release reads
(its reader refuses an unknown key). Spec:
docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md (Stage 2).
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

OUT_DIR = '/var/tmp/wbb-host-patch'
SUMMARY = 'summary.json'
IMAGE = 'image.json'
PACKAGES = ('nodejs', 'cloudflared', 'litestream')
LIVEPATCH_OK = ('applied', 'nothing-to-apply')
TIMEOUT_SECONDS = 120
# /snap/bin: canonical-livepatch is a snap. It only starts in its own unit's cgroup (spec C15).
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin', 'LC_ALL': 'C'}
# The bot's unit and container (spec 2026-10-11 §10). The same names and the same rule as the image helper's
# unit_type (deploy/image/helper/wbb_image.py), which this collector does not import: it is installed on its
# own, without the helper next to it. test_host_patch_collect.py runs both over the same cases.
UNIT = 'warsaw-beer-bot.service'
CONTAINER = 'warsaw-beer-bot'
QUADLET_PATH = '/etc/containers/systemd/warsaw-beer-bot.container'
GENERATOR_DIR = '/run/systemd/generator/'
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
# image-state.env is a few dozen short lines (deploy/autodeploy.sh STATE_KEYS); anything larger is not it.
STATE_CAP = 65_536


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


def unit_type(run_command):
    """'quadlet' when the bot's unit is generated from our Quadlet file, 'absent' when systemd knows no such
    unit, 'foreign' otherwise (the flat unit in /etc/systemd/system, a masked unit, …) — the helper's rule."""
    props = {}
    for line in run_command(['systemctl', 'show', UNIT, '-p', 'LoadState,SourcePath,FragmentPath']).splitlines():
        key, sep, value = line.partition('=')
        if sep:
            props[key] = value
    if 'LoadState' not in props:
        raise ValueError('systemctl show printed no LoadState')
    if props['LoadState'] == 'not-found':
        return 'absent'
    if props.get('SourcePath') == QUADLET_PATH and props.get('FragmentPath', '').startswith(GENERATOR_DIR):
        return 'quadlet'
    return 'foreign'


def running_digest(run_command):
    """The registry digest of the image the bot's container runs (`.ImageDigest`, as the helper reads it)."""
    out = run_command(['podman', 'container', 'inspect', CONTAINER, '--format', '{{.ImageDigest}}']).strip()
    if not DIGEST.fullmatch(out):
        raise ValueError('podman container inspect printed no digest')
    return out


def deployed_digest(path):
    """DEPLOYED_DIGEST of the operator's image-state.env, parsed line by line and never sourced.

    Root reads a file in the operator's home: a symlink, a FIFO or anything but a small regular file is not
    followed or waited on. A key that is missing, repeated or not a digest is unreadable."""
    if not path:
        raise ValueError('no image-state.env path')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError(f'{path} is not a regular file')
        data = stream.read(STATE_CAP + 1)
    if len(data) > STATE_CAP:
        raise ValueError(f'{path} is larger than {STATE_CAP} bytes')
    values = [line[len('DEPLOYED_DIGEST='):] for line in data.decode('utf-8').split('\n')
              if line.startswith('DEPLOYED_DIGEST=')]
    if len(values) != 1 or not DIGEST.fullmatch(values[0]):
        raise ValueError(f'{path} names no single DEPLOYED_DIGEST')
    return values[0]


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


def collect_image(run_command, now, image_state):
    """Spec 2026-10-11 §10: what runs, and under which unit, next to what the controller deployed."""
    return {
        'version': 1,
        'timestamp': now,
        'unit': attempt(lambda: unit_type(run_command)),
        'running_digest': attempt(lambda: running_digest(run_command)),
        'deployed_digest': attempt(lambda: deployed_digest(image_state)),
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


def write_summary(out_dir, summary, name=SUMMARY):
    prepare_directory(out_dir)
    fd, temporary = tempfile.mkstemp(dir=out_dir, prefix=f'.{name.split(".")[0]}-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(summary, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, os.path.join(out_dir, name))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', default=OUT_DIR)
    # The operator's ~/.local/state/wbb-autodeploy/image-state.env: install-host-patch-collector.sh knows the
    # operator (SUDO_USER) and names it in the unit's drop-in. Empty: not known, deployed_digest is null.
    parser.add_argument('--image-state', default='')
    parser.add_argument('--root', default='/', help=argparse.SUPPRESS)  # tests only
    args = parser.parse_args(argv)
    prepare_directory(args.out_dir)  # root reads nothing from a directory it has not verified
    now = int(time.time())
    write_summary(args.out_dir, collect(run, Path(args.root), now, read_previous(args.out_dir)))
    # After the summary: whatever happens here, the summary of this run is already written.
    write_summary(args.out_dir, collect_image(run, now, args.image_state), IMAGE)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
