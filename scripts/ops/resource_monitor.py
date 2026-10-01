#!/usr/bin/env python3
"""Root statvfs monitor: bounded evidence and acknowledged transition alerts."""
import argparse
import fcntl
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
from pathlib import Path
import stat
import subprocess
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import uuid

from test_run import SafetyError, default_base, inventory, private_directory

GIB = 1024**3
HISTORY_LIMIT = 864
GAP_LIMIT = 450
LEVELS = ('normal', 'warning', 'critical')


def validate_sample(value):
    for key in ('timestamp', 'device', 'inodes_total', 'inodes_free',
                'bytes_total', 'bytes_available'):
        number = value.get(key)
        if type(number) not in (int, float) or not math.isfinite(number) or number < 0:
            raise ValueError('invalid filesystem sample')
        if key != 'timestamp' and type(number) is not int:
            raise ValueError('filesystem counters must be integers')
    if (value['inodes_total'] == 0 or value['bytes_total'] == 0
            or value['inodes_free'] > value['inodes_total']
            or value['bytes_available'] > value['bytes_total']):
        raise ValueError('filesystem sample out of range')


def warning(sample, resource):
    if resource == 'inode':
        return (sample['inodes_total'] - sample['inodes_free']) * 100 >= sample['inodes_total'] * 80
    return sample['bytes_available'] <= 10*GIB


def critical(sample, resource):
    if resource == 'inode':
        return ((sample['inodes_total'] - sample['inodes_free']) * 100 >= sample['inodes_total'] * 90
                or sample['inodes_free'] < 100_000)
    return sample['bytes_available'] <= 5*GIB


def contiguous(history):
    tail = [history[-1]]
    for earlier in reversed(history[:-1]):
        later = tail[-1]
        if not 0 < later['timestamp'] - earlier['timestamp'] <= GAP_LIMIT:
            break
        tail.append(earlier)
    return list(reversed(tail))


def forecast(history, key):
    window = contiguous(history)
    # Pick the shortest tail with an hour of evidence and at least 13 samples.
    # Actual cron ticks have startup/scan jitter, so 13 points may span <1 hour.
    for start in range(len(window) - 13, -1, -1):
        if window[-1]['timestamp'] - window[start]['timestamp'] >= 3600:
            window = window[start:]
            break
    else:
        return None
    span = window[-1]['timestamp'] - window[0]['timestamp']
    if any(later[key] > earlier[key] for earlier, later in zip(window, window[1:])):
        return None  # Cleanup invalidates a consumption-only extrapolation.
    consumption = window[0][key] - window[-1][key]
    return round(window[-1][key] * span / consumption) if consumption > 0 else None


def evaluate(state, sample):
    validate_sample(sample)
    state = state or {'version': 1, 'history': [],
                      'levels': {'inode': 'normal', 'disk': 'normal'},
                      'announced': {'inode': 'normal', 'disk': 'normal', 'runs': []}}
    history = list(state['history'])
    if history:
        last = history[-1]
        if (sample['timestamp'] <= last['timestamp'] or
                any(sample[key] != last[key] for key in ('device', 'inodes_total', 'bytes_total'))):
            history = []
    history = (history + [sample])[-HISTORY_LIMIT:]
    result = dict(state, history=history, levels=dict(state['levels']))
    for resource in ('inode', 'disk'):
        streak = []
        for point in reversed(contiguous(history)):
            if not warning(point, resource):
                break
            streak.append(point)
        if critical(sample, resource):
            result['levels'][resource] = 'critical'
        elif not warning(sample, resource):
            result['levels'][resource] = 'normal'
        elif sample['timestamp'] - streak[-1]['timestamp'] >= 900:
            result['levels'][resource] = 'warning'
        # During warning pending, retain prior alert level until raw recovery.
    result['forecast'] = {'inode_seconds': forecast(history, 'inodes_free'),
                          'disk_seconds': forecast(history, 'bytes_available')}
    return result


def atomic_state(fd, state, filename='state.json', mode=0o600):
    name = '.state-' + uuid.uuid4().hex
    handle = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=fd)
    try:
        with os.fdopen(handle, 'w') as stream:
            json.dump(state, stream, allow_nan=False)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        os.replace(name, filename, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass


def inventory_available(runs):
    return runs is not None and all(
        row['name'] != '(inventory truncated)' and not row.get('audit_errors', 0)
        for row in runs)


def publish_summary(directory, sample, runs):
    validate_sample(sample)
    available = inventory_available(runs)
    summary = {'version': 1, 'timestamp': sample['timestamp'],
               'inodes_free': sample['inodes_free'], 'bytes_available': sample['bytes_available'],
               'runs_inventory_available': available,
               'pending_runs': sum(row['status'] != 'active' for row in runs) if available else None}
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in Path(directory).absolute().parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o755:
            raise ValueError('unsafe summary directory')
        atomic_state(fd, summary, 'summary.json', 0o644)
    finally:
        os.close(fd)


def read_state(fd):
    try:
        handle = os.open('state.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return None
    with os.fdopen(handle) as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_size > 1024*1024):
            raise ValueError('unsafe or oversize monitor state')
        state = json.load(stream)
    if state['version'] != 1 or not 1 <= len(state['history']) <= HISTORY_LIMIT:
        raise ValueError('invalid monitor state')
    for point in state['history']:
        validate_sample(point)
    for resource in ('inode', 'disk'):
        if state['levels'][resource] not in LEVELS or state['announced'][resource] not in LEVELS:
            raise ValueError('invalid monitor level')
    if not isinstance(state['announced']['runs'], list) or len(state['announced']['runs']) > 257:
        raise ValueError('invalid run inventory state')
    return state


def tick(state_dir, sample, notify, runs, summary_dir=None):
    _, fd = private_directory(state_dir)
    lock = None
    try:
        lock = os.open('monitor.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError('unsafe monitor lock')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'skipped': 'already running'}
        state = evaluate(read_state(fd), sample)
        state['runs_inventory_available'] = inventory_available(runs)
        wanted = dict(state['levels'], runs=[])
        atomic_state(fd, state)  # Evidence survives a failed external delivery.
        if summary_dir is not None:
            try:
                publish_summary(summary_dir, sample, runs)
            except (OSError, ValueError):
                logging.getLogger('resource-monitor').error('diagnostic summary publication failed')
        announced = state['announced']
        changes = [f'{key}: {announced[key]} → {wanted[key]}' for key in ('inode', 'disk')
                   if wanted[key] != announced[key]]
        if changes and notify is not None:
            message = ('wbb root filesystem\n' + '\n'.join(changes) +
                       f"\nfree inodes: {sample['inodes_free']:,}; disk: {sample['bytes_available']/GIB:.2f} GiB")
            if state['forecast']['inode_seconds'] is not None:
                message += f"\ninode exhaustion estimate: {state['forecast']['inode_seconds']/3600:.1f} hours"
            if state['forecast']['disk_seconds'] is not None:
                message += f"\ndisk exhaustion estimate: {state['forecast']['disk_seconds']/3600:.1f} hours"
            notify(message)
            state['announced'] = wanted
            atomic_state(fd, state)
        return state
    finally:
        if lock is not None:
            os.close(lock)
        os.close(fd)


def collect():
    values = os.statvfs('/')
    return {'timestamp': time.time(), 'device': os.stat('/').st_dev,
            'inodes_total': values.f_files, 'inodes_free': values.f_ffree,
            'bytes_total': values.f_blocks * values.f_frsize,
            'bytes_available': values.f_bavail * values.f_frsize}


def telegram(message):
    def credential(key):
        result = subprocess.run(
            ['sudo', '-n', '-u', 'warsaw-beer-bot', '/usr/bin/bash', '-lc',
             '"/usr/local/bin/wbb-read-env" /etc/warsaw-beer-bot/.env "$1"', 'wbb-monitor', key],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0 or not result.stdout.strip():
            raise RuntimeError('existing operational channel credentials unavailable')
        return result.stdout.strip()
    token, chat = credential('TELEGRAM_BOT_TOKEN'), credential('ADMIN_TELEGRAM_ID')
    request = Request(f'https://api.telegram.org/bot{token}/sendMessage', method='POST',
                      data=urlencode({'chat_id': chat, 'text': message}).encode())
    try:
        with urlopen(request, timeout=10) as response:
            accepted = json.loads(response.read(65536)).get('ok') is True
        if not accepted:
            raise RuntimeError('notification was not accepted')
    except Exception as error:
        # HTTP errors contain the token URL; never propagate their text or body.
        raise RuntimeError('operational notification delivery failed') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path,
                        default=Path.home() / '.local/state/wbb-resource-monitor')
    parser.add_argument('--runs-dir', type=Path, default=default_base())
    parser.add_argument('--summary-dir', type=Path)
    parser.add_argument('--notify', choices=('telegram', 'none'), default='none')
    args = parser.parse_args()
    _, fd = private_directory(args.state_dir)
    handle = os.open('monitor.log', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
    log_stat = os.fstat(handle)
    if not stat.S_ISREG(log_stat.st_mode) or log_stat.st_uid != os.getuid() or log_stat.st_nlink != 1:
        raise ValueError('unsafe monitor log')
    os.close(handle)
    os.close(fd)
    log = logging.getLogger('resource-monitor')
    log.setLevel(logging.INFO)
    log.addHandler(RotatingFileHandler(args.state_dir / 'monitor.log', maxBytes=65536, backupCount=1))

    def notify(message):
        telegram(message)
        log.info('transition delivered (telegram)')
    try:
        try:
            runs = inventory(args.runs_dir)
        except BlockingIOError:
            runs = None  # No false recovery from an incomplete concurrent snapshot.
        except (OSError, ValueError, SafetyError):
            runs = None
        result = tick(args.state_dir, collect(), notify if args.notify == 'telegram' else None,
                      runs, args.summary_dir)
        print(json.dumps({key: result[key] for key in ('levels', 'forecast', 'runs_inventory_available', 'skipped') if key in result}))
        return 0
    except Exception as error:
        log.error('monitor failed (%s)', type(error).__name__)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
