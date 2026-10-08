# #469 Stage 2 core — host-patch collector, reader, rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mechanism of stage 2. A root collector writes the host's patch facts to a summary file. A hardened reader turns that file into typed facts. Pure rules turn the facts into 🟡/🔴 findings.

**Architecture:** The collector is Python, run as root, local facts only. It follows the `scripts/ops/resource_monitor.py` precedent: unittest tests run by `scripts/ops.test.ts`. The reader reuses the hardened read of `readTestDiagnostics`, extracted into one shared function, with uid 0 as the trusted owner. The rules are a pure function `hostPatchFindings(Avail<HostPatchFacts>, now)`.

**This plan deliberately does not wire anything into the live report.** The summary will not exist on the host until the periphery installs the collector's unit. Wiring the reader into `collectStatusInputs` now would turn the daily status 🟡 `нема даних` from the moment this merges. Wiring, the systemd unit/timer, the installer, the upstream facts (Node security release, Node EOL, litestream) and `spec.md` belong to the periphery plan, written after this core's end-to-end review (CLAUDE.md, staged plans).

**Tech Stack:** Python 3 (stdlib only), TypeScript, zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md` — Stage 2, and the claims table C3–C5, C12, C15–C18.

## Global Constraints

- Summary path `/var/tmp/wbb-host-patch/summary.json`. Directory `0755` owned by root, file `0644` owned by root, written atomically (temp file in the same directory + `os.replace`).
- Summary schema `version: 1`. Keys, exactly: `version`, `timestamp`, `kernel{running,newest_installed}`, `reboot_required{since,packages}`, `livepatch{state,upgrade_required_date}`, `stale_services[{unit,since}]`, `unattended{last_run,security_pending}`, `packages{nodejs,cloudflared,litestream}`. All times are unix seconds (integers).
- A fact the collector cannot read is `null`, never guessed. The one exception is `reboot_required`, where `null` means "no reboot pending". A `stat` failure other than "file not found" aborts the run without writing (ruling below).
- needrestart is called exactly as `needrestart -b -r l`. Never without `-r l`.
- Livepatch states, exactly: `applied`, `nothing-to-apply`, `unsupported-kernel`, `unknown`.
- Watched units, exactly: `warsaw-beer-bot.service`, `cloudflared.service`, `litestream.service`, `ssh.service`.
- The reader treats data older than 3 h (10 800 s) as stale; the trusted owner is uid 0.
- Thresholds (spec rules table):
  - reboot: 🟡 > 3 days, 🔴 > 14 days;
  - a stale watched unit: 🟡 > 1 day;
  - `security_pending > 0`: 🟡 only when u-u last ran > 2 days ago (or never);
  - Livepatch `state` not in {`applied`, `nothing-to-apply`}: 🟡;
  - Livepatch `upgrade_required_date`: 🟡 < 30 days, 🔴 when past;
  - Ubuntu 24.04 standard support ends `2029-05-31`: 🟡 < 180 days, 🔴 < 30 days.
- Tests run via `npm test -- <args>`; full gate per task is `npm test && npm run typecheck`. Never set `WBB_TEST_TMPDIR`.
- CLAUDE.md test rules: exact asserts, no conditionals in tests, no tautologies, boundaries covered, expected values written out rather than recomputed by the code under test.

Fixtures (committed with this plan, `scripts/ops/fixtures/host-patch/`, provenance in its `README.md`):
- real captures from 2026-10-08: `needrestart-b.txt`, `livepatch-status.json` (Machine-Id zeroed), `apt-list-upgradable.txt`;
- composed by hand: `needrestart-b-stale.txt`, `apt-list-upgradable-security.txt`.

**Ruling (plan author):** a `reboot_required` `stat` error other than ENOENT raises and the run writes nothing. `null` already means "no reboot pending", so it cannot also mean "could not read". A silent run ages into 🟡 `нема даних` after 3 h, which is honest. If this is wrong, the cost is one stale-data line on a host whose `/var/run` is unreadable to root, which has never happened.

---

### Task 1: The collector

**Files:**
- Create: `scripts/ops/host_patch_collect.py`
- Create: `scripts/ops/test_host_patch_collect.py`

**Interfaces:**
- Consumes: the fixtures above.
- Produces: the summary file format (Global Constraints). The periphery installs this script as `/usr/local/libexec/wbb-host-patch-collect` and runs it from `wbb-host-patch.service`. The spec requires its own unit, because of claim C15.

- [ ] **Step 1: Write the failing tests**

`scripts/ops/test_host_patch_collect.py`:

```python
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import host_patch_collect as hp

FIX = Path(__file__).parent / 'fixtures' / 'host-patch'
NOW = 1_791_440_000
STAMP = 1_791_439_429


def fixture(name):
    return (FIX / name).read_text()


def runner(overrides=None):
    """A fake `run`: each argv tuple maps to stdout text, or to an exception to raise."""
    table = {
        ('needrestart', '-b', '-r', 'l'): fixture('needrestart-b.txt'),
        ('canonical-livepatch', 'status', '--format', 'json'): fixture('livepatch-status.json'),
        ('apt', 'list', '--upgradable'): fixture('apt-list-upgradable.txt'),
        ('dpkg-query', '-W', '-f=${Version}', 'nodejs'): '24.21.0-1nodesource1',
        ('dpkg-query', '-W', '-f=${Version}', 'cloudflared'): '2026.10.0',
        ('dpkg-query', '-W', '-f=${Version}', 'litestream'): '0.5.11',
    }
    table.update(overrides or {})

    def run(argv):
        out = table[tuple(argv)]
        if isinstance(out, Exception):
            raise out
        return out
    return run


class Host(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'root'
        periodic = self.root / 'var/lib/apt/periodic'
        periodic.mkdir(parents=True)
        (self.root / 'var/run').mkdir(parents=True)
        stamp = periodic / 'unattended-upgrades-stamp'
        stamp.write_text('')
        os.utime(stamp, (STAMP, STAMP))
        self.out = Path(self.tmp.name) / 'out'

    def tearDown(self):
        self.tmp.cleanup()

    def collect(self, overrides=None, previous=None, now=NOW):
        return hp.collect(runner(overrides), self.root, now, previous)


class TestCollect(Host):
    def test_the_real_host_on_2026_10_08(self):
        self.assertEqual(self.collect(), {
            'version': 1,
            'timestamp': NOW,
            'kernel': {'running': '6.8.0-142-generic', 'newest_installed': '6.8.0-142-generic'},
            'reboot_required': None,
            'livepatch': {'state': 'nothing-to-apply', 'upgrade_required_date': '2027-10-02'},
            'stale_services': [{'unit': 'code-server@ysi.service', 'since': NOW}],
            'unattended': {'last_run': STAMP, 'security_pending': 0},
            'packages': {'nodejs': '24.21.0-1nodesource1', 'cloudflared': '2026.10.0', 'litestream': '0.5.11'},
        })

    def test_reboot_required_carries_its_mtime_and_unique_packages_in_order(self):
        flag = self.root / 'var/run/reboot-required'
        flag.write_text('*** System restart required ***\n')
        os.utime(flag, (1_790_500_000, 1_790_500_000))
        (self.root / 'var/run/reboot-required.pkgs').write_text(
            'linux-image-6.8.0-145-generic\nlibc6\n\nlibc6\n')
        self.assertEqual(self.collect()['reboot_required'],
                         {'since': 1_790_500_000, 'packages': ['linux-image-6.8.0-145-generic', 'libc6']})

    def test_reboot_required_without_a_package_list(self):
        flag = self.root / 'var/run/reboot-required'
        flag.write_text('')
        os.utime(flag, (1_790_500_000, 1_790_500_000))
        self.assertEqual(self.collect()['reboot_required'], {'since': 1_790_500_000, 'packages': []})

    def test_a_failing_needrestart_nulls_kernel_and_stale_services_only(self):
        s = self.collect({('needrestart', '-b', '-r', 'l'): RuntimeError('needrestart exited 1')})
        self.assertEqual((s['kernel'], s['stale_services'], s['livepatch']['state']),
                         (None, None, 'nothing-to-apply'))

    def test_needrestart_output_without_kernel_lines_is_unreadable(self):
        s = self.collect({('needrestart', '-b', '-r', 'l'): 'NEEDRESTART-VER: 3.6\n'})
        self.assertEqual((s['kernel'], s['stale_services']), (None, None))

    def test_a_newer_installed_kernel_is_reported_as_is(self):
        s = self.collect({('needrestart', '-b', '-r', 'l'): fixture('needrestart-b-stale.txt')})
        self.assertEqual(s['kernel'], {'running': '6.8.0-142-generic', 'newest_installed': '6.8.0-145-generic'})

    def test_security_candidates_are_counted_by_their_archive(self):
        s = self.collect({('apt', 'list', '--upgradable'): fixture('apt-list-upgradable-security.txt')})
        self.assertEqual(s['unattended']['security_pending'], 2)

    def test_a_failing_apt_nulls_only_security_pending(self):
        s = self.collect({('apt', 'list', '--upgradable'): RuntimeError('apt exited 100')})
        self.assertEqual(s['unattended'], {'last_run': STAMP, 'security_pending': None})

    def test_a_missing_stamp_means_unattended_upgrades_never_ran(self):
        (self.root / 'var/lib/apt/periodic/unattended-upgrades-stamp').unlink()
        self.assertEqual(self.collect()['unattended']['last_run'], None)

    def test_a_package_dpkg_cannot_name_is_null(self):
        s = self.collect({
            ('dpkg-query', '-W', '-f=${Version}', 'litestream'): RuntimeError('dpkg-query exited 1'),
            ('dpkg-query', '-W', '-f=${Version}', 'cloudflared'): '',
        })
        self.assertEqual(s['packages'], {'nodejs': '24.21.0-1nodesource1', 'cloudflared': None, 'litestream': None})


def livepatch(supported='supported', state='applied', running=True, date='2027-10-02'):
    return json.dumps({'Status': [
        {'Kernel': '6.8.0-90-generic', 'Running': False, 'Supported': 'supported',
         'Livepatch': {'State': 'applied'}, 'UpgradeRequiredDate': '2026-01-01'},
        {'Kernel': '6.8.0-142.142-generic', 'Running': running, 'Supported': supported,
         'Livepatch': {'State': state}, 'UpgradeRequiredDate': date},
    ]})


class TestLivepatch(Host):
    def lp(self, text):
        return self.collect({('canonical-livepatch', 'status', '--format', 'json'): text})['livepatch']

    def test_the_running_kernel_entry_is_the_one_read(self):
        self.assertEqual(self.lp(livepatch()), {'state': 'applied', 'upgrade_required_date': '2027-10-02'})

    def test_an_unsupported_kernel_wins_over_its_state(self):
        self.assertEqual(self.lp(livepatch(supported='unsupported'))['state'], 'unsupported-kernel')

    def test_an_unseen_state_is_unknown_never_healthy(self):
        self.assertEqual(self.lp(livepatch(state='apply-failed'))['state'], 'unknown')

    def test_a_missing_date_is_null(self):
        self.assertEqual(self.lp(livepatch(date=None))['upgrade_required_date'], None)

    def test_no_running_entry_is_unreadable(self):
        self.assertEqual(self.lp(livepatch(running=False)), None)

    def test_invalid_json_is_unreadable(self):
        self.assertEqual(self.lp('{'), None)

    def test_a_failing_command_is_unreadable(self):
        self.assertEqual(self.lp(RuntimeError('not a snap cgroup')), None)


class TestStaleSince(Host):
    STALE = {('needrestart', '-b', '-r', 'l'): fixture('needrestart-b-stale.txt')}

    def test_since_survives_from_the_previous_summary_and_gone_units_drop(self):
        previous = {'stale_services': [{'unit': 'litestream.service', 'since': 100},
                                       {'unit': 'gone.service', 'since': 50}]}
        self.assertEqual(self.collect(self.STALE, previous, now=500)['stale_services'],
                         [{'unit': 'code-server@ysi.service', 'since': 500},
                          {'unit': 'litestream.service', 'since': 100}])

    def test_a_since_from_the_future_is_clamped_to_now(self):
        previous = {'stale_services': [{'unit': 'litestream.service', 'since': 900}]}
        self.assertEqual(self.collect(self.STALE, previous, now=500)['stale_services'][1],
                         {'unit': 'litestream.service', 'since': 500})

    def test_a_malformed_previous_summary_restarts_every_since(self):
        previous = {'stale_services': [{'unit': 'litestream.service', 'since': '100'}]}
        self.assertEqual(self.collect(self.STALE, previous, now=500)['stale_services'],
                         [{'unit': 'code-server@ysi.service', 'since': 500},
                          {'unit': 'litestream.service', 'since': 500}])


class TestWrite(Host):
    def test_writes_0644_json_into_a_0755_directory(self):
        hp.write_summary(str(self.out), {'version': 1})
        info = os.stat(self.out / 'summary.json')
        self.assertEqual((stat.S_IMODE(os.stat(self.out).st_mode), stat.S_IMODE(info.st_mode), info.st_nlink),
                         (0o755, 0o644, 1))
        self.assertEqual(json.loads((self.out / 'summary.json').read_text()), {'version': 1})
        self.assertEqual(sorted(os.listdir(self.out)), ['summary.json'])

    def test_refuses_a_symlinked_output_directory_and_writes_nothing(self):
        target = Path(self.tmp.name) / 'elsewhere'
        target.mkdir()
        self.out.symlink_to(target)
        with self.assertRaises(RuntimeError):
            hp.write_summary(str(self.out), {'version': 1})
        self.assertEqual(os.listdir(target), [])

    def test_main_twice_keeps_the_first_since_across_runs(self):
        argv = ['--out-dir', str(self.out), '--root', str(self.root)]
        with patch.object(hp, 'run', runner()), patch.object(hp.time, 'time', return_value=1_000.4):
            self.assertEqual(hp.main(argv), 0)
        with patch.object(hp, 'run', runner()), patch.object(hp.time, 'time', return_value=5_000.9):
            self.assertEqual(hp.main(argv), 0)
        summary = json.loads((self.out / 'summary.json').read_text())
        self.assertEqual((summary['timestamp'], summary['stale_services']),
                         (5_000, [{'unit': 'code-server@ysi.service', 'since': 1_000}]))

    def test_an_unreadable_previous_summary_is_ignored(self):
        self.out.mkdir(mode=0o755)
        (self.out / 'summary.json').write_text('{')
        argv = ['--out-dir', str(self.out), '--root', str(self.root)]
        with patch.object(hp, 'run', runner()), patch.object(hp.time, 'time', return_value=7_000):
            self.assertEqual(hp.main(argv), 0)
        self.assertEqual(json.loads((self.out / 'summary.json').read_text())['stale_services'],
                         [{'unit': 'code-server@ysi.service', 'since': 7_000}])


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -B -m unittest discover -s scripts/ops -p 'test_host_patch_collect.py' -v`
Expected: ERROR — `ModuleNotFoundError: No module named 'host_patch_collect'`.

- [ ] **Step 3: Write the collector**

`scripts/ops/host_patch_collect.py`:

```python
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
        raise ValueError('needrestart printed no kernel lines')
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


def reboot_required(root):
    """None means no reboot is pending. Any stat error other than ENOENT propagates (no write)."""
    try:
        since = int((root / 'var/run/reboot-required').stat().st_mtime)
    except FileNotFoundError:
        return None
    try:
        lines = (root / 'var/run/reboot-required.pkgs').read_text().splitlines()
    except FileNotFoundError:
        lines = []
    return {'since': since, 'packages': list(dict.fromkeys(l.strip() for l in lines if l.strip()))}


def last_run(root):
    try:
        return int((root / 'var/lib/apt/periodic/unattended-upgrades-stamp').stat().st_mtime)
    except FileNotFoundError:
        return None


def merge_stale(services, previous, now):
    """A unit keeps the `since` of the first run that saw it stale; a unit no longer listed drops."""
    seen = {}
    entries = previous.get('stale_services') if isinstance(previous, dict) else None
    for entry in entries if isinstance(entries, list) else []:
        if isinstance(entry, dict) and isinstance(entry.get('unit'), str) and type(entry.get('since')) is int:
            seen[entry['unit']] = entry['since']
    return [{'unit': unit, 'since': min(seen.get(unit, now), now)} for unit in dict.fromkeys(services)]


def package_version(run_command, name):
    return run_command(['dpkg-query', '-W', '-f=${Version}', name]).strip() or None


def collect(run_command, root, now, previous):
    needrestart = attempt(lambda: parse_needrestart(run_command(['needrestart', '-b', '-r', 'l'])))
    return {
        'version': 1,
        'timestamp': now,
        'kernel': needrestart[0] if needrestart else None,
        'reboot_required': reboot_required(root),
        'livepatch': attempt(lambda: map_livepatch(
            run_command(['canonical-livepatch', 'status', '--format', 'json']))),
        'stale_services': merge_stale(needrestart[1], previous, now) if needrestart else None,
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
    summary = collect(run, Path(args.root), int(time.time()), read_previous(args.out_dir))
    write_summary(args.out_dir, summary)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -B -m unittest discover -s scripts/ops -p 'test_host_patch_collect.py' -v`
Expected: OK, 24 tests.

Mutation checks. For each one, make the change, see the named test fail, then revert:
- drop `'-r', 'l'` from the needrestart argv → `test_the_real_host_on_2026_10_08` (the fake runner has no such key, so kernel and stale_services become null) — the list-only argv is pinned;
- replace `min(seen.get(unit, now), now)` with `seen.get(unit, now)` → `test_a_since_from_the_future_is_clamped_to_now`;
- replace `raw if raw in LIVEPATCH_OK else 'unknown'` with `raw` → `test_an_unseen_state_is_unknown_never_healthy`;
- delete the `stat.S_ISLNK(...)` clause → `test_refuses_a_symlinked_output_directory_and_writes_nothing`;
- remove `dict.fromkeys` in `reboot_required` → `test_reboot_required_carries_its_mtime_and_unique_packages_in_order`.

- [ ] **Step 5: Full gate and commit**

Run: `npm test && npm run typecheck`. `scripts/ops.test.ts` runs every `scripts/ops/test_*.py`, so the new tests are part of the gate.

```bash
git add scripts/ops/host_patch_collect.py scripts/ops/test_host_patch_collect.py
git commit -m "feat(ops): host-patch collector — kernel, reboot, Livepatch, stale units, security backlog (#469)"
```

---

### Task 2: The shared hardened read and the host-patch reader

**Files:**
- Create: `src/jobs/hardened-json.ts`
- Modify: `src/jobs/test-diagnostics.ts` (move the read into the helper; behaviour unchanged)
- Modify: `src/domain/status/types.ts` (add `HostPatchFacts`)
- Create: `src/jobs/host-patch.ts`
- Create: `src/jobs/host-patch.test.ts`

**Interfaces:**
- Consumes: the summary format from Task 1.
- Produces:
  - `readHardenedJson(path: string, trustedUid: () => number, maxBytes: number): unknown` — `undefined` means unavailable;
  - `HostPatchFacts` (in `src/domain/status/types.ts`);
  - `readHostPatch(now: Date, path?: string, trustedUid?: number): HostPatchRead`, where `HostPatchRead = { kind: 'ok'; facts: HostPatchFacts } | { kind: 'stale' } | { kind: 'unavailable' }`.

- [ ] **Step 1: Extract the helper (refactor under the existing tests)**

`src/jobs/hardened-json.ts`:

```ts
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

// Linux operator telemetry written atomically by another account. Pin the opened directory while
// reading its replaced file, and treat every missing or suspicious input as unknown (undefined):
// the directory must be mode 0755 and owned by trustedUid(), the file a regular 0644 file with one
// link, the same owner and at most maxBytes. trustedUid is called only once the file is open.
export function readHardenedJson(path: string, trustedUid: () => number, maxBytes: number): unknown {
  let directory: number | undefined;
  let file: number | undefined;
  try {
    const parent = dirname(resolve(path));
    if (realpathSync(parent) !== parent) return undefined;
    directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const dirInfo = fstatSync(directory);
    if ((dirInfo.mode & 0o777) !== 0o755) return undefined;
    file = openSync(`/proc/self/fd/${directory}/${basename(path)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(file);
    const owner = trustedUid();
    if (!Number.isSafeInteger(owner) || owner < 0 || dirInfo.uid !== owner) return undefined;
    if (!info.isFile() || info.uid !== dirInfo.uid || info.nlink !== 1
      || (info.mode & 0o777) !== 0o644 || info.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(maxBytes);
    const count = readSync(file, buffer, 0, maxBytes, 0);
    if (count !== info.size || fstatSync(file).size !== info.size) return undefined;
    return JSON.parse(buffer.toString('utf8', 0, count)) as unknown;
  } catch {
    return undefined;
  } finally {
    let closeFailed = false;
    for (const fd of [file, directory]) {
      if (fd !== undefined) {
        try { closeSync(fd); }
        catch { closeFailed = true; }
      }
    }
    // A return in finally overrides the try's value: a failed close makes the read unknown.
    if (closeFailed) return undefined;
  }
}
```

Replace the body of `readTestDiagnostics` in `src/jobs/test-diagnostics.ts` with the following. Keep the schema, `pendingWords`, `formatTestDiagnostics` and `readTestDiagnosticsLine` as they are. Drop the now-unused `node:fs` and `node:path` imports, and keep `execFileSync`:

```ts
// Linux operator telemetry only; the hardened read lives in ./hardened-json.
export function readTestDiagnostics(now: Date, path = SUMMARY_PATH, trustedUid?: number): TestDiagnostics {
  // The operator account is the same ysi account pinned in deploy/sudoers.d.
  // Resolve its UID through the system account database, never from the export.
  const operatorUid = (): number => trustedUid ?? Number(execFileSync('/usr/bin/id', ['-u', 'ysi'], {
    encoding: 'utf8', timeout: 1_000, maxBuffer: 64, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim());
  const parsed = summarySchema.safeParse(readHardenedJson(path, operatorUid, MAX_BYTES));
  if (!parsed.success) return UNAVAILABLE_D;
  const summary = parsed.data;
  const age = now.getTime() / 1000 - summary.timestamp;
  if (!Number.isFinite(age) || age < 0) return UNAVAILABLE_D;
  if (age > 900) return { kind: 'stale' };
  return {
    kind: 'ok', bytesAvailable: summary.bytes_available,
    inodesFree: summary.inodes_free, pendingRuns: summary.pending_runs,
  };
}
```

`safeParse(undefined)` fails the object schema, so an unavailable read stays `UNAVAILABLE_D`.

Run: `npm test -- src/jobs/test-diagnostics.test.ts`
Expected: PASS, every existing test unchanged. This is the refactor's only proof, so no test file may be edited in this step.

- [ ] **Step 2: Write the failing reader tests**

Add to `src/domain/status/types.ts` (after `SnapshotRecord`):

```ts
// What the root host-patch collector reports (#469 stage 2). Times are unix seconds.
// rebootRequired null = no reboot pending; every other null = the collector could not read it.
export interface HostPatchFacts {
  timestamp: number;
  kernel: { running: string; newestInstalled: string } | null;
  rebootRequired: { since: number; packages: string[] } | null;
  livepatch: { state: 'applied' | 'nothing-to-apply' | 'unsupported-kernel' | 'unknown'; upgradeRequiredDate: string | null } | null;
  staleServices: { unit: string; since: number }[] | null;
  unattended: { lastRun: number | null; securityPending: number | null };
  packages: { nodejs: string | null; cloudflared: string | null; litestream: string | null };
}
```

`src/jobs/host-patch.test.ts`:

```ts
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHostPatch } from './host-patch';

/** #469 stage 2 — the summary written by scripts/ops/host_patch_collect.py. */
let directory: string;
let path: string;
const owner = (): number => process.getuid!();
const now = new Date(1_791_440_000_000);

const summary = {
  version: 1,
  timestamp: 1_791_439_000,
  kernel: { running: '6.8.0-142-generic', newest_installed: '6.8.0-145-generic' },
  reboot_required: { since: 1_790_500_000, packages: ['linux-image-6.8.0-145-generic', 'libc6'] },
  livepatch: { state: 'nothing-to-apply', upgrade_required_date: '2027-10-02' },
  stale_services: [{ unit: 'litestream.service', since: 1_791_000_000 }],
  unattended: { last_run: 1_791_439_429, security_pending: 2 },
  packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: null },
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'wbb-host-patch-reader-'));
  chmodSync(directory, 0o755);
  path = join(directory, 'summary.json');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function write(value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o644 });
  chmodSync(path, 0o644);
}

describe('readHostPatch', () => {
  it('maps every field of a fresh summary', () => {
    write(summary);
    expect(readHostPatch(now, path, owner())).toEqual({
      kind: 'ok',
      facts: {
        timestamp: 1_791_439_000,
        kernel: { running: '6.8.0-142-generic', newestInstalled: '6.8.0-145-generic' },
        rebootRequired: { since: 1_790_500_000, packages: ['linux-image-6.8.0-145-generic', 'libc6'] },
        livepatch: { state: 'nothing-to-apply', upgradeRequiredDate: '2027-10-02' },
        staleServices: [{ unit: 'litestream.service', since: 1_791_000_000 }],
        unattended: { lastRun: 1_791_439_429, securityPending: 2 },
        packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: null },
      },
    });
  });

  it('keeps every nullable fact null', () => {
    write({
      ...summary, kernel: null, reboot_required: null, livepatch: null, stale_services: null,
      unattended: { last_run: null, security_pending: null },
    });
    expect(readHostPatch(now, path, owner())).toEqual({
      kind: 'ok',
      facts: {
        timestamp: 1_791_439_000, kernel: null, rebootRequired: null, livepatch: null, staleServices: null,
        unattended: { lastRun: null, securityPending: null },
        packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: null },
      },
    });
  });

  it('accepts a summary exactly three hours old and calls one second older stale', () => {
    write({ ...summary, timestamp: 1_791_440_000 - 10_800 });
    expect(readHostPatch(now, path, owner()).kind).toBe('ok');
    write({ ...summary, timestamp: 1_791_440_000 - 10_801 });
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'stale' });
  });

  it('refuses a summary from the future', () => {
    write({ ...summary, timestamp: 1_791_440_001 });
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['version 2', { version: 2 }],
    ['fractional timestamp', { timestamp: 1.5 }],
    ['unknown livepatch state', { livepatch: { state: 'disabled', upgrade_required_date: null } }],
    ['malformed date', { livepatch: { state: 'applied', upgrade_required_date: '02.10.2027' } }],
    ['negative security count', { unattended: { last_run: null, security_pending: -1 } }],
    ['string since', { stale_services: [{ unit: 'ssh.service', since: '1' }] }],
    ['extra top-level key', { surprise: true }],
    ['missing packages', { packages: undefined }],
    ['empty unit name', { stale_services: [{ unit: '', since: 1 }] }],
  ])('refuses a summary with %s', (_what, patch) => {
    write({ ...summary, ...patch });
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });

  it('is unavailable when the file is missing', () => {
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });

  it('trusts only root by default — a summary owned by the test user is refused', () => {
    write(summary);
    expect(readHostPatch(now, path)).toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['a 0600 file', () => chmodSync(path, 0o600)],
    ['a 0777 directory', () => chmodSync(directory, 0o777)],
    ['a hard-linked file', () => linkSync(path, join(directory, 'second'))],
  ])('refuses %s', (_what, spoil) => {
    write(summary);
    spoil();
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });

  it('refuses a symlinked summary', () => {
    const real = join(directory, 'real.json');
    writeFileSync(real, JSON.stringify(summary), { mode: 0o644 });
    chmodSync(real, 0o644);
    symlinkSync(real, path);
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });

  it('refuses a summary over 16 KiB', () => {
    write({ ...summary, stale_services: Array.from({ length: 200 }, (_, k) => ({ unit: `u${k}`.padEnd(90, 'x'), since: 1 })) });
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });
});
```

Run: `npm test -- src/jobs/host-patch.test.ts`
Expected: FAIL — `Cannot find module './host-patch'`.

- [ ] **Step 3: Write the reader**

`src/jobs/host-patch.ts`:

```ts
import { z } from 'zod';
import type { HostPatchFacts } from '../domain/status/types';
import { readHardenedJson } from './hardened-json';

// The root collector's summary (#469 stage 2, scripts/ops/host_patch_collect.py).
const HOST_PATCH_PATH = '/var/tmp/wbb-host-patch/summary.json';
const MAX_BYTES = 16_384;
// The collector runs hourly: three missed runs mean it has stopped.
const STALE_SECONDS = 3 * 3600;
const ROOT_UID = 0;

const seconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(200);
const summarySchema = z.object({
  version: z.literal(1),
  timestamp: seconds,
  kernel: z.object({ running: text, newest_installed: text }).strict().nullable(),
  reboot_required: z.object({ since: seconds, packages: z.array(text).max(100) }).strict().nullable(),
  livepatch: z.object({
    state: z.enum(['applied', 'nothing-to-apply', 'unsupported-kernel', 'unknown']),
    upgrade_required_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  }).strict().nullable(),
  stale_services: z.array(z.object({ unit: text, since: seconds }).strict()).max(200).nullable(),
  unattended: z.object({
    last_run: seconds.nullable(),
    security_pending: z.number().int().min(0).max(100_000).nullable(),
  }).strict(),
  packages: z.object({ nodejs: text.nullable(), cloudflared: text.nullable(), litestream: text.nullable() }).strict(),
}).strict();

export type HostPatchRead = { kind: 'ok'; facts: HostPatchFacts } | { kind: 'stale' } | { kind: 'unavailable' };

export function readHostPatch(now: Date, path = HOST_PATCH_PATH, trustedUid = ROOT_UID): HostPatchRead {
  const parsed = summarySchema.safeParse(readHardenedJson(path, () => trustedUid, MAX_BYTES));
  if (!parsed.success) return { kind: 'unavailable' };
  const s = parsed.data;
  const age = now.getTime() / 1000 - s.timestamp;
  if (!Number.isFinite(age) || age < 0) return { kind: 'unavailable' };
  if (age > STALE_SECONDS) return { kind: 'stale' };
  return {
    kind: 'ok',
    facts: {
      timestamp: s.timestamp,
      kernel: s.kernel && { running: s.kernel.running, newestInstalled: s.kernel.newest_installed },
      rebootRequired: s.reboot_required,
      livepatch: s.livepatch && { state: s.livepatch.state, upgradeRequiredDate: s.livepatch.upgrade_required_date },
      staleServices: s.stale_services,
      unattended: { lastRun: s.unattended.last_run, securityPending: s.unattended.security_pending },
      packages: s.packages,
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/jobs/host-patch.test.ts src/jobs/test-diagnostics.test.ts`
Expected: PASS (host-patch: 20 tests; test-diagnostics unchanged).

Mutation checks:
- `STALE_SECONDS = 3 * 3600 + 1` → the three-hour boundary test fails;
- remove `.strict()` from the top-level object → "extra top-level key";
- `ROOT_UID = process.getuid!()` → "trusts only root by default".

- [ ] **Step 5: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/jobs/hardened-json.ts src/jobs/test-diagnostics.ts src/jobs/host-patch.ts src/jobs/host-patch.test.ts src/domain/status/types.ts
git commit -m "feat(status): read the root host-patch summary through the shared hardened read (#469)"
```

---

### Task 3: The host-patch rules

**Files:**
- Modify: `src/domain/status/rules.ts` (thresholds)
- Modify: `src/domain/status/helpers.ts` + `src/domain/status/helpers.test.ts` (`ukDays`)
- Create: `src/domain/status/host-patch.ts`
- Create: `src/domain/status/host-patch.test.ts`

**Interfaces:**
- Consumes: `HostPatchFacts`, `Avail` (`src/domain/status/types.ts`).
- Produces: `hostPatchFindings(hp: Avail<HostPatchFacts>, now: Date): HostFinding[]` with `HostFinding = { colour: 'yellow' | 'red'; reason: string }`, and `WATCHED_UNITS`. The periphery merges the findings into `evaluateInfra`.

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/status/helpers.test.ts` (and add `ukDays` to its import from `./helpers`):

```ts
describe('ukDays', () => {
  it.each([
    [0, '0 днів'], [1, '1 день'], [2, '2 дні'], [4, '4 дні'], [5, '5 днів'],
    [11, '11 днів'], [14, '14 днів'], [21, '21 день'], [22, '22 дні'], [111, '111 днів'],
  ])('%i → %s', (n, words) => {
    expect(ukDays(n)).toBe(words);
  });
});
```

That file uses Vitest globals (it has no `vitest` import); keep it that way.

`src/domain/status/host-patch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Avail, HostPatchFacts } from './types';
import { hostPatchFindings } from './host-patch';
import { NOW } from './test-inputs';

/** #469 stage 2 — spec rules table. NOW = 2026-10-06T07:00:00Z. */
const DAY = 86_400;
const T = NOW.getTime() / 1000;

const FACTS: HostPatchFacts = {
  timestamp: T - 600,
  kernel: { running: '6.8.0-142-generic', newestInstalled: '6.8.0-142-generic' },
  rebootRequired: null,
  livepatch: { state: 'nothing-to-apply', upgradeRequiredDate: '2027-10-02' },
  // code-server is not watched: 30 days stale must stay silent.
  staleServices: [{ unit: 'code-server@ysi.service', since: T - 30 * DAY }],
  unattended: { lastRun: T - 3600, securityPending: 0 },
  packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: '0.5.11' },
};
const ok = (patch: Partial<HostPatchFacts> = {}): Avail<HostPatchFacts> => ({ ok: true, value: { ...FACTS, ...patch } });
const at = (iso: string) => new Date(iso);

describe('hostPatchFindings', () => {
  it('is silent on the real host of 2026-10-08', () => {
    expect(hostPatchFindings(ok(), NOW)).toEqual([]);
  });

  it('says "нема даних" for an unreadable summary', () => {
    expect(hostPatchFindings({ ok: false, reason: 'збирач патчів мовчить' }, NOW))
      .toEqual([{ colour: 'yellow', reason: 'нема даних: збирач патчів мовчить' }]);
  });

  describe('reboot pending', () => {
    const reboot = (since: number, packages = ['libc6', 'linux-image-6.8.0-145-generic']) =>
      hostPatchFindings(ok({ rebootRequired: { since, packages } }), NOW);

    it('is silent at exactly 3 days', () => {
      expect(reboot(T - 3 * DAY)).toEqual([]);
    });
    it('is yellow one second past 3 days', () => {
      expect(reboot(T - 3 * DAY - 1)).toEqual([
        { colour: 'yellow', reason: 'ядро: перезавантаження чекає 3 дні (libc6, linux-image-6.8.0-145-generic)' }]);
    });
    it('is still yellow at exactly 14 days', () => {
      expect(reboot(T - 14 * DAY)[0].colour).toBe('yellow');
    });
    it('is red one second past 14 days', () => {
      expect(reboot(T - 14 * DAY - 1)).toEqual([
        { colour: 'red', reason: 'ядро: перезавантаження чекає 14 днів (libc6, linux-image-6.8.0-145-generic)' }]);
    });
    it('shows at most three packages', () => {
      expect(reboot(T - 5 * DAY, ['a', 'b', 'c', 'd'])).toEqual([
        { colour: 'yellow', reason: 'ядро: перезавантаження чекає 5 днів (a, b, c, …)' }]);
    });
    it('drops the parentheses without a package list', () => {
      expect(reboot(T - 5 * DAY, [])).toEqual([{ colour: 'yellow', reason: 'ядро: перезавантаження чекає 5 днів' }]);
    });
  });

  describe('Livepatch', () => {
    const lp = (livepatch: HostPatchFacts['livepatch']) => hostPatchFindings(ok({ livepatch }), NOW);

    it('applied is silent', () => {
      expect(lp({ state: 'applied', upgradeRequiredDate: '2027-10-02' })).toEqual([]);
    });
    it.each(['unknown', 'unsupported-kernel'] as const)('%s is yellow', (state) => {
      expect(lp({ state, upgradeRequiredDate: null })).toEqual([{ colour: 'yellow', reason: `Livepatch: ${state}` }]);
    });
    it('unreadable is "нема даних"', () => {
      expect(lp(null)).toEqual([{ colour: 'yellow', reason: 'нема даних: стан Livepatch' }]);
    });
    it('a support end 30 days away is silent', () => {
      expect(lp({ state: 'applied', upgradeRequiredDate: '2026-11-06' })).toEqual([]);
    });
    it('a support end 29 days away is yellow', () => {
      expect(lp({ state: 'applied', upgradeRequiredDate: '2026-11-05' })).toEqual([
        { colour: 'yellow', reason: 'Livepatch покриває ядро лише до 2026-11-05' }]);
    });
    it('a support end of today is red', () => {
      expect(lp({ state: 'applied', upgradeRequiredDate: '2026-10-06' })).toEqual([
        { colour: 'red', reason: 'Livepatch більше не покриває ядро (з 2026-10-06)' }]);
    });
    it('an impossible date is "нема даних"', () => {
      expect(lp({ state: 'applied', upgradeRequiredDate: '2027-02-30' })).toEqual([
        { colour: 'yellow', reason: 'нема даних: дата підтримки ядра в Livepatch' }]);
    });
  });

  describe('stale watched units', () => {
    const stale = (unit: string, since: number) =>
      hostPatchFindings(ok({ staleServices: [...FACTS.staleServices!, { unit, since }] }), NOW);

    it.each(['warsaw-beer-bot.service', 'cloudflared.service', 'litestream.service', 'ssh.service'])(
      '%s one second past a day is yellow', (unit) => {
        expect(stale(unit, T - DAY - 1)).toEqual([
          { colour: 'yellow', reason: `${unit} не перезапущено після оновлення бібліотек: 1 день` }]);
      });
    it('exactly a day is silent', () => {
      expect(stale('litestream.service', T - DAY)).toEqual([]);
    });
    it('an unwatched unit is silent however old', () => {
      expect(stale('dbus.service', T - 90 * DAY)).toEqual([]);
    });
    it('unreadable is "нема даних"', () => {
      expect(hostPatchFindings(ok({ staleServices: null }), NOW))
        .toEqual([{ colour: 'yellow', reason: 'нема даних: needrestart' }]);
    });
  });

  describe('security backlog', () => {
    const backlog = (securityPending: number | null, lastRun: number | null) =>
      hostPatchFindings(ok({ unattended: { securityPending, lastRun } }), NOW);

    it('pending with a run exactly 2 days ago is silent', () => {
      expect(backlog(2, T - 2 * DAY)).toEqual([]);
    });
    it('pending with the last run one second past 2 days is yellow', () => {
      expect(backlog(2, T - 2 * DAY - 1)).toEqual([
        { colour: 'yellow', reason: 'безпекових оновлень чекає 2, unattended-upgrades не запускався 2 дні' }]);
    });
    it('pending and never run is yellow', () => {
      expect(backlog(1, null)).toEqual([
        { colour: 'yellow', reason: 'безпекових оновлень чекає 1, unattended-upgrades ще не запускався' }]);
    });
    it('nothing pending is silent however old the last run', () => {
      expect(backlog(0, T - 60 * DAY)).toEqual([]);
    });
    it('unreadable is "нема даних"', () => {
      expect(backlog(null, T)).toEqual([{ colour: 'yellow', reason: 'нема даних: безпекові оновлення' }]);
    });
  });

  describe('Ubuntu 24.04 end of standard support (2029-05-31)', () => {
    const quiet = ok({ livepatch: { state: 'applied', upgradeRequiredDate: null }, staleServices: [] });

    it('180 days before is silent', () => {
      expect(hostPatchFindings(quiet, at('2028-12-02T00:00:00Z'))).toEqual([]);
    });
    it('179 days before is yellow', () => {
      expect(hostPatchFindings(quiet, at('2028-12-03T00:00:00Z'))).toEqual([
        { colour: 'yellow', reason: 'Ubuntu 24.04: стандартна підтримка до 2029-05-31 — лишилось 179 днів' }]);
    });
    it('29 days before is red', () => {
      expect(hostPatchFindings(quiet, at('2029-05-02T00:00:00Z'))).toEqual([
        { colour: 'red', reason: 'Ubuntu 24.04: стандартна підтримка до 2029-05-31 — лишилось 29 днів' }]);
    });
    it('after the end it is red and still reported when the summary is unreadable', () => {
      expect(hostPatchFindings({ ok: false, reason: 'збирач патчів мовчить' }, at('2029-06-01T00:00:00Z'))).toEqual([
        { colour: 'red', reason: 'Ubuntu 24.04: стандартна підтримка до 2029-05-31 — уже минула' },
        { colour: 'yellow', reason: 'нема даних: збирач патчів мовчить' },
      ]);
    });
  });
});
```

Run: `npm test -- src/domain/status/host-patch.test.ts src/domain/status/helpers.test.ts`
Expected: FAIL — `Cannot find module './host-patch'` and `ukDays` is not exported.

- [ ] **Step 2: Implement**

Append to `STATUS_RULES` in `src/domain/status/rules.ts`, before `snapshotRetentionDays`:

```ts
  // Хост-патчі (#469 stage 2, spec rules table). Ages compare in seconds: "> 3 days" is strict.
  rebootYellowDays: 3,
  rebootRedDays: 14,
  staleServiceYellowDays: 1,
  unattendedStaleYellowDays: 2,
  livepatchSupportYellowDays: 30,
  eolYellowDays: 180,
  eolRedDays: 30,
  // No machine-readable source is worth a fetch for a date that does not move.
  ubuntuStandardSupportEnd: '2029-05-31',
```

Append to `src/domain/status/helpers.ts`:

```ts
// "N днів" with the Ukrainian plural: 1 день, 2–4 дні, 5–20 днів, 21 день, 111 днів.
export function ukDays(n: number): string {
  const tail = n % 100;
  if (tail < 11 || tail > 14) {
    if (n % 10 === 1) return `${n} день`;
    if (n % 10 >= 2 && n % 10 <= 4) return `${n} дні`;
  }
  return `${n} днів`;
}
```

`src/domain/status/host-patch.ts`:

```ts
import type { Avail, HostPatchFacts } from './types';
import { STATUS_RULES as R } from './rules';
import { ukDays } from './helpers';

// Host-patch findings for the Інфраструктура row (#469 stage 2). Independent of the disk monitor:
// the periphery merges them into evaluateInfra so an unreadable disk summary cannot hide them.
export type HostFinding = { colour: 'yellow' | 'red'; reason: string };
const red = (reason: string): HostFinding => ({ colour: 'red', reason });
const yellow = (reason: string): HostFinding => ({ colour: 'yellow', reason });

const DAY = 86_400;
const LIVEPATCH_OK: readonly string[] = ['applied', 'nothing-to-apply'];
// needrestart defers everything else on purpose (code-server, dbus, logind, getty…); those
// refresh only on reboot, which the reboot rule already covers.
export const WATCHED_UNITS: readonly string[] = [
  'warsaw-beer-bot.service', 'cloudflared.service', 'litestream.service', 'ssh.service',
];

// Whole days from now to the start of `date` (UTC), or null for anything that is not a real date.
function daysUntil(date: string, nowSeconds: number): number | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(t)
    || new Date(t).toISOString().slice(0, 10) !== date) return null;
  return Math.floor((t / 1000 - nowSeconds) / DAY);
}

function ubuntuSupport(nowSeconds: number): HostFinding[] {
  const left = daysUntil(R.ubuntuStandardSupportEnd, nowSeconds)!;
  const text = `Ubuntu 24.04: стандартна підтримка до ${R.ubuntuStandardSupportEnd} — ${
    left < 0 ? 'уже минула' : `лишилось ${ukDays(left)}`}`;
  if (left < R.eolRedDays) return [red(text)];
  if (left < R.eolYellowDays) return [yellow(text)];
  return [];
}

export function hostPatchFindings(hp: Avail<HostPatchFacts>, now: Date): HostFinding[] {
  const t = Math.floor(now.getTime() / 1000);
  const f: HostFinding[] = ubuntuSupport(t);
  if (!hp.ok) return [...f, yellow(`нема даних: ${hp.reason}`)];
  const h = hp.value;

  if (h.rebootRequired !== null) {
    const age = t - h.rebootRequired.since;
    const pk = h.rebootRequired.packages;
    const list = pk.length === 0 ? '' : ` (${pk.slice(0, 3).join(', ')}${pk.length > 3 ? ', …' : ''})`;
    const text = `ядро: перезавантаження чекає ${ukDays(Math.floor(age / DAY))}${list}`;
    if (age > R.rebootRedDays * DAY) f.push(red(text));
    else if (age > R.rebootYellowDays * DAY) f.push(yellow(text));
  }

  if (h.livepatch === null) f.push(yellow('нема даних: стан Livepatch'));
  else {
    if (!LIVEPATCH_OK.includes(h.livepatch.state)) f.push(yellow(`Livepatch: ${h.livepatch.state}`));
    const end = h.livepatch.upgradeRequiredDate;
    if (end !== null) {
      const left = daysUntil(end, t);
      if (left === null) f.push(yellow('нема даних: дата підтримки ядра в Livepatch'));
      else if (left < 0) f.push(red(`Livepatch більше не покриває ядро (з ${end})`));
      else if (left < R.livepatchSupportYellowDays) f.push(yellow(`Livepatch покриває ядро лише до ${end}`));
    }
  }

  if (h.staleServices === null) f.push(yellow('нема даних: needrestart'));
  else {
    for (const s of h.staleServices.filter((x) => WATCHED_UNITS.includes(x.unit))) {
      const age = t - s.since;
      if (age > R.staleServiceYellowDays * DAY) {
        f.push(yellow(`${s.unit} не перезапущено після оновлення бібліотек: ${ukDays(Math.floor(age / DAY))}`));
      }
    }
  }

  const u = h.unattended;
  if (u.securityPending === null) f.push(yellow('нема даних: безпекові оновлення'));
  else if (u.securityPending > 0) {
    if (u.lastRun === null) {
      f.push(yellow(`безпекових оновлень чекає ${u.securityPending}, unattended-upgrades ще не запускався`));
    } else if (t - u.lastRun > R.unattendedStaleYellowDays * DAY) {
      f.push(yellow(`безпекових оновлень чекає ${u.securityPending}, unattended-upgrades не запускався ${
        ukDays(Math.floor((t - u.lastRun) / DAY))}`));
    }
  }
  return f;
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npm test -- src/domain/status/host-patch.test.ts src/domain/status/helpers.test.ts`
Expected: PASS.

Mutation checks:
- `age > R.rebootYellowDays * DAY` → `>=` → "is silent at exactly 3 days";
- drop the `WATCHED_UNITS` filter → "is silent on the real host" (code-server, 30 days);
- `left < 0` → `left < -1` → "a support end of today is red" fails (today is −1 whole days away at 07:00 UTC);
- move `ubuntuSupport(t)` after the `!hp.ok` return → "after the end it is red and still reported…".

- [ ] **Step 4: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/domain/status/rules.ts src/domain/status/helpers.ts src/domain/status/helpers.test.ts src/domain/status/host-patch.ts src/domain/status/host-patch.test.ts
git commit -m "feat(status): host-patch rules — reboot, Livepatch, stale units, security backlog, Ubuntu EOL (#469)"
```

---

## After the core: end-to-end review, then the periphery plan

The periphery plan is written only after this core's whole-branch review. Its scope:

1. **Wiring:** `StatusInputs.hostPatch: Avail<HostPatchFacts>` and `collectStatusInputs` reading `readHostPatch`. `evaluateInfra` merges `hostPatchFindings` and loses its early return on an unreadable disk summary (spec).
2. **Host install** (`[deploy:hold]`):
   - the collector installed to `/usr/local/libexec/wbb-host-patch-collect`;
   - `wbb-host-patch.service` + `.timer` (hourly; `OnActiveSec`, not `OnBootSec` — #798);
   - an installer script;
   - the first summary must exist before the wiring deploys, so the order of host steps matters.
3. **Upstream facts** (bot side, once a day):
   - nodejs.org `index.json`: newest `v24.*` with `security: true`, then installed `packages.nodejs` < it → 🔴 > 3 days;
   - `schedule.json`: `v24.end` → 🟡 < 180 / 🔴 < 30;
   - GitHub `releases/latest` for litestream → 🟡 > 30 days.
4. **`spec.md`** §5.9 and the `dailyStatus` row. README host-patching section.
