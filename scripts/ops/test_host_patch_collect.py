import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import host_patch_collect as hp

# The image helper, only to run its unit_type over the same cases as the collector's (they are installed apart).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'deploy/image/helper'))
import wbb_image as wi  # noqa: E402

FIX = Path(__file__).parent / 'fixtures' / 'host-patch'
NOW = 1_791_440_000
STAMP = 1_791_439_429
BTIME = 1_789_000_000
DPKG = ('dpkg-query', '-W', '-f=${db:Status-Abbrev}\t${Version}')
SHOW = ('systemctl', 'show', 'warsaw-beer-bot.service', '-p', 'LoadState,SourcePath,FragmentPath')
INSPECT = ('podman', 'container', 'inspect', 'warsaw-beer-bot', '--format', '{{.ImageDigest}}')
D1 = 'sha256:' + '1' * 64
D2 = 'sha256:' + '2' * 64
# systemctl prints the properties in its own order, not the one asked for.
QUADLET_SHOW = ('FragmentPath=/run/systemd/generator/warsaw-beer-bot.service\nLoadState=loaded\n'
                'SourcePath=/etc/containers/systemd/warsaw-beer-bot.container\n')
FLAT_SHOW = 'FragmentPath=/etc/systemd/system/warsaw-beer-bot.service\nLoadState=loaded\nSourcePath=\n'
ABSENT_SHOW = 'FragmentPath=\nLoadState=not-found\nSourcePath=\n'
NO_WINDOW = {'window_digest': None, 'window_prev_digest': None}
FIXTURE_STATE = f'DEPLOYED_DIGEST={D1}\nWINDOW_DIGEST={D2}\nWINDOW_PREV_DIGEST={D1}\nWINDOW_PHASE=activating\n'


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
        SHOW: FLAT_SHOW,
        INSPECT: RuntimeError('podman exited 125'),
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


class TestImage(Host):
    """Spec 2026-10-11 §10: the unit, the running image and the deployed one; what cannot be read is null."""

    def state(self, text):
        path = Path(self.tmp.name) / 'image-state.env'
        path.write_text(text)
        return str(path)

    def image(self, overrides=None, image_state=None):
        image = hp.collect_image(runner(overrides), NOW, image_state)
        self.assertEqual((image.pop('version'), image.pop('timestamp')), (2, NOW))
        return image

    def test_after_the_switchover_quadlet_with_both_digests(self):
        state = self.state(f'DEPLOYED_SHA={"a" * 40}\nDEPLOYED_DIGEST={D1}\nDEPLOYED_ID={"b" * 64}\nSETTLED_DIGEST={D2}\n')
        self.assertEqual(self.image({SHOW: QUADLET_SHOW, INSPECT: f'{D2}\n'}, state),
                         {'unit': 'quadlet', 'running_digest': D2, 'deployed_digest': D1, **NO_WINDOW})

    def test_inside_a_deploy_window_the_window_s_digests_are_reported(self):
        # Activating: the candidate D2 may already run while DEPLOYED_DIGEST still names the settled D1.
        state = self.state(f'DEPLOYED_DIGEST={D1}\nDEPLOYED_ID={"b" * 64}\nWINDOW_SHA={"a" * 40}\n'
                           f'WINDOW_DIGEST={D2}\nWINDOW_PREV_DIGEST={D1}\nWINDOW_PHASE=activating\n')
        self.assertEqual(self.image({SHOW: QUADLET_SHOW, INSPECT: D2}, state),
                         {'unit': 'quadlet', 'running_digest': D2, 'deployed_digest': D1,
                          'window_digest': D2, 'window_prev_digest': D1})

    def test_each_digest_of_the_state_is_judged_on_its_own(self):
        state = self.state(f'DEPLOYED_DIGEST={D1}\nWINDOW_DIGEST={D2[:-1]}\nWINDOW_PREV_DIGEST={D1}\nWINDOW_PREV_DIGEST={D2}\n')
        self.assertEqual(self.image(image_state=state),
                         {'unit': 'foreign', 'running_digest': None, 'deployed_digest': D1,
                          'window_digest': None, 'window_prev_digest': None})

    def test_before_the_switchover_the_flat_unit_is_foreign_and_no_container_runs(self):
        self.assertEqual(self.image({SHOW: FLAT_SHOW, INSPECT: RuntimeError('podman exited 125')}),
                         {'unit': 'foreign', 'running_digest': None, 'deployed_digest': None, **NO_WINDOW})

    def test_no_unit_at_all_is_absent(self):
        self.assertEqual(self.image({SHOW: ABSENT_SHOW}),
                         {'unit': 'absent', 'running_digest': None, 'deployed_digest': None, **NO_WINDOW})

    def test_the_inspect_and_show_argv(self):
        asked = []
        table = runner({SHOW: QUADLET_SHOW, INSPECT: D1})

        def run(argv):
            asked.append(tuple(argv))
            return table(argv)
        hp.collect_image(run, NOW, None)
        self.assertEqual(asked, [SHOW, INSPECT])

    def test_unreadable_podman_and_systemctl_are_null(self):
        self.assertEqual(self.image({SHOW: RuntimeError('systemctl exited 1'), INSPECT: FileNotFoundError('podman')}),
                         {'unit': None, 'running_digest': None, 'deployed_digest': None, **NO_WINDOW})

    def test_systemctl_output_without_a_load_state_is_null(self):
        self.assertEqual(self.image({SHOW: 'SourcePath=\n'})['unit'], None)

    def test_an_inspect_that_is_not_a_digest_is_null(self):
        for out in ('', '<no value>\n', D1[:-1], f'{D1} {D2}', 'a' * 64):
            with self.subTest(out=out):
                self.assertEqual(self.image({SHOW: QUADLET_SHOW, INSPECT: out})['running_digest'], None)

    def test_a_missing_image_state_is_a_null_deployed_digest(self):
        self.assertEqual(self.image(image_state=str(Path(self.tmp.name) / 'nowhere.env'))['deployed_digest'], None)

    def test_no_image_state_path_is_a_null_deployed_digest(self):
        self.assertEqual(self.image(image_state='')['deployed_digest'], None)

    def test_an_image_state_without_a_single_valid_deployed_digest_is_null(self):
        for text in (
            f'DEPLOYED_SHA={"a" * 40}\n',                       # migrated, not yet bootstrapped
            f'DEPLOYED_DIGEST={D1}\nDEPLOYED_DIGEST={D2}\n',     # ambiguous
            f'DEPLOYED_DIGEST={D1[:-1]}\n',
            f'DEPLOYED_DIGEST="{D1}"\n',                        # never unquoted: not the writer's format
            f'export DEPLOYED_DIGEST={D1}\n',
            f' DEPLOYED_DIGEST={D1}\n',
            f'DEPLOYED_DIGEST={D1} \n',
        ):
            with self.subTest(text=text):
                self.assertEqual(self.image(image_state=self.state(text))['deployed_digest'], None)

    def test_an_image_state_without_a_final_newline_still_names_its_digest(self):
        self.assertEqual(self.image(image_state=self.state(f'DEPLOYED_DIGEST={D1}'))['deployed_digest'], D1)

    def test_an_image_state_is_never_sourced(self):
        # Sourced, this line would run touch; parsed, it is a value that is not a digest.
        marker = Path(self.tmp.name) / 'ran'
        state = self.state(f'DEPLOYED_DIGEST=$(touch {marker})\n')
        self.assertEqual((self.image(image_state=state)['deployed_digest'], marker.exists()), (None, False))

    def test_a_symlinked_image_state_is_not_followed(self):
        target = self.state(f'DEPLOYED_DIGEST={D1}\n')
        link = Path(self.tmp.name) / 'link.env'
        link.symlink_to(target)
        self.assertEqual(self.image(image_state=str(link))['deployed_digest'], None)

    def test_a_fifo_image_state_is_neither_read_nor_waited_on(self):
        fifo = Path(self.tmp.name) / 'fifo.env'
        os.mkfifo(fifo)
        self.assertEqual(self.image(image_state=str(fifo))['deployed_digest'], None)

    def test_a_directory_image_state_is_null(self):
        self.assertEqual(self.image(image_state=self.tmp.name)['deployed_digest'], None)

    def test_an_image_state_over_the_cap_is_null_and_at_the_cap_is_read(self):
        line = f'DEPLOYED_DIGEST={D1}\n'
        at_cap = line + 'X' * (hp.STATE_CAP - len(line) - 1) + '\n'
        self.assertEqual(len(at_cap), hp.STATE_CAP)
        self.assertEqual((self.image(image_state=self.state(at_cap))['deployed_digest'],
                          self.image(image_state=self.state(at_cap + 'Y'))['deployed_digest']), (D1, None))

    def main(self, *extra, overrides=None):
        argv = ['--out-dir', str(self.out), '--root', str(self.root), *extra]
        with patch.object(hp, 'run', runner(overrides)), patch.object(hp.time, 'time', return_value=NOW + 0.7):
            self.assertEqual(hp.main(argv), 0)
        return json.loads((self.out / 'summary.json').read_text()), json.loads((self.out / 'image.json').read_text())

    def test_main_writes_image_json_next_to_the_summary_with_the_image_state_argument(self):
        state = self.state(f'DEPLOYED_DIGEST={D1}\n')
        _summary, image = self.main(f'--image-state={state}')
        self.assertEqual(image, {'version': 2, 'timestamp': NOW, 'unit': 'foreign', 'running_digest': None,
                                 'deployed_digest': D1, **NO_WINDOW})

    def test_image_json_is_written_like_the_summary_0644_into_the_0755_directory(self):
        self.main()
        files = [os.stat(self.out / name) for name in ('summary.json', 'image.json')]
        self.assertEqual([(stat.S_IMODE(f.st_mode), f.st_uid, f.st_nlink) for f in files],
                         [(0o644, os.geteuid(), 1), (0o644, os.geteuid(), 1)])
        self.assertEqual(sorted(os.listdir(self.out)), ['image.json', 'summary.json'])

    def test_main_with_the_unit_s_empty_default_reports_deployed_as_null(self):
        _summary, image = self.main('--image-state=')
        self.assertEqual(image['deployed_digest'], None)

    def test_the_summary_keeps_exactly_the_keys_it_had_before_image_json(self):
        # Every bot release reads summary.json with a reader that refuses an unknown key: rollback safety.
        summary, _image = self.main(overrides={SHOW: QUADLET_SHOW, INSPECT: D1})
        self.assertEqual(sorted(summary), ['kernel', 'livepatch', 'packages', 'reboot_required', 'stale_services',
                                           'timestamp', 'unattended', 'version'])

    def test_the_written_files_are_the_fixtures_the_bot_s_readers_are_tested_on(self):
        # src/jobs/host-patch.test.ts reads these two fixtures with the bot's readers (the summary one with the
        # reader every release since #469 has): byte equality ties what the collector writes to what they accept.
        # A deploy window activating D2 (FIXTURE_STATE): every image.json field is set.
        state = self.state(FIXTURE_STATE)
        self.main(f'--image-state={state}', overrides={SHOW: QUADLET_SHOW, INSPECT: D2})
        self.assertEqual([(self.out / name).read_text() for name in ('summary.json', 'image.json')],
                         [fixture('collector-summary.json'), fixture('collector-image.json')])


class TestUnitRuleIsTheHelpers(unittest.TestCase):
    """The collector reimplements the helper's unit_type (it is installed without it): the same names, and the
    same answer on every case — each case's answer is written out, so neither side is the other's oracle."""

    CASES = (
        ('generated from our Quadlet file', QUADLET_SHOW, 'quadlet'),
        ('the flat unit in /etc', FLAT_SHOW, 'foreign'),
        ('no such unit', ABSENT_SHOW, 'absent'),
        ('a unit in /etc shadows the generated one',
         'FragmentPath=/etc/systemd/system/x.service\nLoadState=loaded\n'
         'SourcePath=/etc/containers/systemd/warsaw-beer-bot.container\n', 'foreign'),
        ('generated from another file',
         'FragmentPath=/run/systemd/generator/warsaw-beer-bot.service\nLoadState=loaded\n'
         'SourcePath=/etc/containers/systemd/other.container\n', 'foreign'),
        ('the generator path only as a prefix of a name',
         'FragmentPath=/run/systemd/generator.x/w\nLoadState=loaded\n'
         'SourcePath=/etc/containers/systemd/warsaw-beer-bot.container\n', 'foreign'),
        ('masked', 'FragmentPath=/dev/null\nLoadState=masked\nSourcePath=\n', 'foreign'),
    )

    def helper(self, stdout):
        def run(argv, *, timeout, text=False):
            return subprocess.CompletedProcess(argv, 0, stdout, '')
        host = wi.Host(podman='/unused', systemctl='/usr/bin/systemctl', run=run,
                       quadlet_path=wi.PRODUCTION.quadlet_path, template_path='/unused', snapshot_root='/unused',
                       scratch_root='/unused', containers_root='/unused', free_bytes=None, bot_ids=None,
                       fchown=None, scratch_owner=0, pid=None)
        return wi.unit_type(host)

    def test_the_same_unit_quadlet_file_and_generator_directory(self):
        self.assertEqual((hp.UNIT, hp.CONTAINER, hp.QUADLET_PATH, hp.GENERATOR_DIR),
                         (wi.UNIT, wi.CONTAINER, wi.PRODUCTION.quadlet_path, wi.GENERATOR_DIR))

    def test_the_same_answer_on_every_case(self):
        for name, stdout, expected in self.CASES:
            with self.subTest(name):
                self.assertEqual((hp.unit_type(lambda argv, out=stdout: out), self.helper(stdout)),
                                 (expected, expected))


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
