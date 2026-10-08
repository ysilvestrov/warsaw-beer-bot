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
BTIME = 1_789_000_000
DPKG = ('dpkg-query', '-W', '-f=${db:Status-Abbrev}\t${Version}')


def fixture(name):
    return (FIX / name).read_text()


def runner(overrides=None):
    """A fake `run`: each argv tuple maps to stdout text, or to an exception to raise."""
    table = {
        ('needrestart', '-b', '-r', 'l'): fixture('needrestart-b.txt'),
        ('canonical-livepatch', 'status', '--format', 'json'): fixture('livepatch-status.json'),
        ('apt', 'list', '--upgradable'): fixture('apt-list-upgradable.txt'),
        (*DPKG, 'nodejs'): 'ii \t24.21.0-1nodesource1',
        (*DPKG, 'cloudflared'): 'ii \t2026.10.0',
        (*DPKG, 'litestream'): 'ii \t0.5.11',
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
        (self.root / 'proc').mkdir()
        (self.root / 'proc/stat').write_text(f'cpu  1 2 3\nbtime {BTIME}\nprocesses 9\n')
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

    def reboot_flag(self, mtime=1_790_500_000):
        flag = self.root / 'var/run/reboot-required'
        flag.write_text('')
        os.utime(flag, (mtime, mtime))

    def since(self, previous):
        return self.collect(previous=previous)['reboot_required']['since']

    def test_reboot_since_carries_forward_the_first_request(self):
        self.reboot_flag()
        self.assertEqual(self.since({'reboot_required': {'since': 1_790_000_000, 'packages': []}}), 1_790_000_000)

    def test_reboot_since_older_than_boot_is_dropped(self):
        self.reboot_flag()
        self.assertEqual(self.since({'reboot_required': {'since': 1_788_000_000, 'packages': []}}), 1_790_500_000)

    def test_reboot_since_without_a_previous_summary_is_the_mtime(self):
        self.reboot_flag()
        self.assertEqual(self.since(None), 1_790_500_000)

    def test_reboot_since_later_than_the_mtime_is_the_mtime(self):
        self.reboot_flag()
        self.assertEqual(self.since({'reboot_required': {'since': 1_791_000_000, 'packages': []}}), 1_790_500_000)

    def test_reboot_since_without_boot_time_is_the_mtime(self):
        self.reboot_flag()
        (self.root / 'proc/stat').unlink()
        self.assertEqual(self.since({'reboot_required': {'since': 1_790_000_000, 'packages': []}}), 1_790_500_000)

    def test_a_failing_needrestart_nulls_kernel_and_stale_services_only(self):
        s = self.collect({('needrestart', '-b', '-r', 'l'): RuntimeError('needrestart exited 1')})
        self.assertEqual((s['kernel'], s['stale_services'], s['livepatch']['state']),
                         (None, None, 'nothing-to-apply'))

    def test_needrestart_output_without_kernel_lines_is_unreadable(self):
        s = self.collect({('needrestart', '-b', '-r', 'l'): 'NEEDRESTART-VER: 3.6\n'})
        self.assertEqual((s['kernel'], s['stale_services']), (None, []))

    def test_service_lines_survive_missing_kernel_lines(self):
        s = self.collect({('needrestart', '-b', '-r', 'l'): 'NEEDRESTART-VER: 3.6\nNEEDRESTART-SVC: ssh.service\n'})
        self.assertEqual((s['kernel'], s['stale_services']), (None, [{'unit': 'ssh.service', 'since': NOW}]))

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
            (*DPKG, 'litestream'): RuntimeError('dpkg-query exited 1'),
            (*DPKG, 'cloudflared'): '',
        })
        self.assertEqual(s['packages'], {'nodejs': '24.21.0-1nodesource1', 'cloudflared': None, 'litestream': None})

    def test_a_removed_package_with_kept_config_is_null(self):
        s = self.collect({(*DPKG, 'litestream'): 'rc \t0.5.11'})
        self.assertEqual(s['packages']['litestream'], None)

    def test_a_held_package_still_reports_its_version(self):
        s = self.collect({(*DPKG, 'nodejs'): 'hi \t24.21.0-1nodesource1'})
        self.assertEqual(s['packages']['nodejs'], '24.21.0-1nodesource1')


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
        previous = {'stale_services': [{'unit': 'litestream.service', 'since': BTIME + 100},
                                       {'unit': 'gone.service', 'since': BTIME + 50}]}
        self.assertEqual(self.collect(self.STALE, previous, now=BTIME + 500)['stale_services'],
                         [{'unit': 'code-server@ysi.service', 'since': BTIME + 500},
                          {'unit': 'litestream.service', 'since': BTIME + 100}])

    def test_a_since_from_the_future_is_clamped_to_now(self):
        previous = {'stale_services': [{'unit': 'litestream.service', 'since': BTIME + 900}]}
        self.assertEqual(self.collect(self.STALE, previous, now=BTIME + 500)['stale_services'][1],
                         {'unit': 'litestream.service', 'since': BTIME + 500})

    def test_a_malformed_previous_summary_restarts_every_since(self):
        previous = {'stale_services': [{'unit': 'litestream.service', 'since': '100'}]}
        self.assertEqual(self.collect(self.STALE, previous, now=BTIME + 500)['stale_services'],
                         [{'unit': 'code-server@ysi.service', 'since': BTIME + 500},
                          {'unit': 'litestream.service', 'since': BTIME + 500}])

    def test_a_since_from_before_the_last_boot_restarts_at_now(self):
        # /var/tmp survives a reboot; the reboot proves every process is fresh.
        previous = {'stale_services': [{'unit': 'litestream.service', 'since': BTIME - 1}]}
        self.assertEqual(self.collect(self.STALE, previous, now=BTIME + 500)['stale_services'][1],
                         {'unit': 'litestream.service', 'since': BTIME + 500})

    def test_a_since_from_exactly_boot_time_is_kept(self):
        previous = {'stale_services': [{'unit': 'litestream.service', 'since': BTIME}]}
        self.assertEqual(self.collect(self.STALE, previous, now=BTIME + 500)['stale_services'][1],
                         {'unit': 'litestream.service', 'since': BTIME})

    def test_an_unknown_boot_time_carries_nothing_forward(self):
        (self.root / 'proc/stat').unlink()
        previous = {'stale_services': [{'unit': 'litestream.service', 'since': BTIME + 100}]}
        self.assertEqual(self.collect(self.STALE, previous, now=BTIME + 500)['stale_services'][1],
                         {'unit': 'litestream.service', 'since': BTIME + 500})


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

    def test_main_refuses_a_symlinked_out_dir_before_reading_anything_in_it(self):
        target = Path(self.tmp.name) / 'elsewhere'
        target.mkdir()
        (target / 'summary.json').write_text('{"reboot_required": {"since": 1}}')
        self.out.symlink_to(target)
        argv = ['--out-dir', str(self.out), '--root', str(self.root)]
        with patch.object(hp, 'run', runner()), patch.object(hp, 'read_previous', side_effect=AssertionError('read before verify')):
            with self.assertRaises(RuntimeError):
                hp.main(argv)
        self.assertEqual(os.listdir(target), ['summary.json'])

    def test_main_twice_keeps_the_first_since_across_runs(self):
        argv = ['--out-dir', str(self.out), '--root', str(self.root)]
        with patch.object(hp, 'run', runner()), patch.object(hp.time, 'time', return_value=BTIME + 1_000.4):
            self.assertEqual(hp.main(argv), 0)
        with patch.object(hp, 'run', runner()), patch.object(hp.time, 'time', return_value=BTIME + 5_000.9):
            self.assertEqual(hp.main(argv), 0)
        summary = json.loads((self.out / 'summary.json').read_text())
        self.assertEqual((summary['timestamp'], summary['stale_services']),
                         (BTIME + 5_000, [{'unit': 'code-server@ysi.service', 'since': BTIME + 1_000}]))

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
