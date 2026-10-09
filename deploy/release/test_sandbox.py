import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sandbox as sb  # noqa: E402
from safe_tar import Refused  # noqa: E402

SHA = 'e58da52c0e62d17929d3f199f36462cc0c4ba0bc'
RELEASE = f'/opt/warsaw-beer-bot/releases/{SHA}'
SCRATCH = '/var/lib/wbb-trial/run-1'
PROBE = '/usr/local/lib/wbb-deploy/payload-probe.cjs'
UNIT = f'wbb-trial-probe-{SHA[:12]}-0123abcd'


class Argv(unittest.TestCase):
    def test_exact_probe_argv(self):
        self.assertEqual(sb.sandbox_argv('probe', SHA, RELEASE, SCRATCH, PROBE, ['native'], UNIT), [
            '/usr/bin/systemd-run', '--wait', '--pipe', '--collect', f'--unit={UNIT}',
            '-p', 'User=wbb-trial', '-p', 'Group=wbb-trial',
            '-p', 'PrivateNetwork=yes', '-p', 'ProtectHome=yes', '-p', 'NoNewPrivileges=yes',
            '-p', 'ProtectSystem=strict', '-p', 'PrivateTmp=yes', '-p', 'PrivateDevices=yes',
            '-p', 'ProtectProc=invisible',
            '-p', 'InaccessiblePaths=-/etc/warsaw-beer-bot', '-p', 'InaccessiblePaths=-/etc/wbb-deploy',
            '-p', 'InaccessiblePaths=-/var/lib/warsaw-beer-bot', '-p', 'InaccessiblePaths=-/var/lib/wbb-deploy',
            '-p', f'ReadWritePaths={SCRATCH}', '-p', f'WorkingDirectory={SCRATCH}',
            '-p', 'CapabilityBoundingSet=', '-p', 'AmbientCapabilities=',
            '-p', 'MemoryMax=768M', '-p', 'CPUQuota=100%', '-p', 'TasksMax=64',
            '-p', 'RuntimeMaxSec=30', '-p', 'TimeoutStopSec=10s', '-p', 'KillMode=control-group',
            '-p', 'Environment=PATH=/usr/bin:/bin', '-p', f'Environment=HOME={SCRATCH}',
            '-p', f'Environment=TMPDIR={SCRATCH}/tmp', '-p', f'Environment=WBB_PAYLOAD={RELEASE}',
            '-p', 'Environment=DOTENV_CONFIG_PATH=/dev/null',
            '/usr/bin/node', PROBE, 'native'])

    def test_trial_gets_the_longer_limit(self):
        argv = sb.sandbox_argv('trial', SHA, RELEASE, SCRATCH, PROBE, ['migrate', f'{SCRATCH}/trial.db'], UNIT)
        self.assertEqual((argv[argv.index('RuntimeMaxSec=120')], argv[-3:]),
                         ('RuntimeMaxSec=120', [PROBE, 'migrate', f'{SCRATCH}/trial.db']))

    def test_unknown_kind(self):
        with self.assertRaisesRegex(Refused, "unknown sandbox kind 'shell'"):
            sb.sandbox_argv('shell', SHA, RELEASE, SCRATCH, PROBE, [], UNIT)

    def test_release_must_be_the_sha_directory(self):
        with self.assertRaisesRegex(Refused, 'is not releases/<'):
            sb.sandbox_argv('probe', SHA, '/opt/warsaw-beer-bot/current', SCRATCH, PROBE, [], UNIT)

    def test_scratch_under_tmp_is_refused(self):
        # Gate G2: PrivateTmp=yes hid it and the unit died with 226/NAMESPACE.
        for scratch in ('/tmp/wbb-trial/run-1', '/var/tmp/run-1', '/tmp'):
            with self.subTest(scratch=scratch), self.assertRaisesRegex(Refused, 'which PrivateTmp hides from the unit$'):
                sb.sandbox_argv('probe', SHA, RELEASE, scratch, PROBE, ['native'], UNIT)

    def test_values_systemd_would_rewrite_are_refused(self):
        # Gate G2: systemd-run 255 expanded ${name} in a node -e argument to an empty string.
        for arg in ('${HOME}/x', '$HOME', '100%', 'a b', 'a\nb'):
            with self.subTest(arg=arg), self.assertRaisesRegex(Refused, 'has a character systemd would rewrite$'):
                sb.sandbox_argv('trial', SHA, RELEASE, SCRATCH, PROBE, ['migrate', arg], UNIT)

    def test_relative_path_is_refused(self):
        with self.assertRaisesRegex(Refused, "^'run-1' is not an absolute path$"):
            sb.sandbox_argv('probe', SHA, RELEASE, 'run-1', PROBE, ['native'], UNIT)

    def test_unit_name(self):
        self.assertRegex(sb.unit_name('trial', SHA), rf'^wbb-trial-trial-{SHA[:12]}-[0-9a-f]{{8}}$')


FINISHED_OK = 'Running as unit: x.service\nFinished with result: success\nMain processes terminated with: code=exited/status=0\n'
GONE = 'LoadState=not-found\nActiveState=inactive\n'


class FakeSystemd:
    """systemd-run, systemctl stop and systemctl show, each answer configurable, every call recorded."""

    def __init__(self, run=(0, 'PROBE OK native: sqlite 3\n', FINISHED_OK), run_raises=None, show=(0, GONE),
                 stop_raises=None):
        self.run, self.run_raises, self.show, self.stop_raises, self.calls = run, run_raises, show, stop_raises, []

    def __call__(self, argv, **kw):
        self.calls.append((argv, kw))
        if argv[0] == sb.SYSTEMD_RUN:
            if self.run_raises:
                raise self.run_raises
            code, out, err = self.run
            return subprocess.CompletedProcess(argv, code, out, err)
        if argv[1] == 'stop':
            if self.stop_raises:
                raise self.stop_raises
            return subprocess.CompletedProcess(argv, 5, '', 'Unit not loaded.')
        code, out = self.show
        return subprocess.CompletedProcess(argv, code, out, '')


class Run(unittest.TestCase):
    def run_probe(self, fake):
        return sb.run_sandboxed('probe', SHA, RELEASE, SCRATCH, PROBE, ['native'], runner=fake)

    def test_a_unit_that_ran(self):
        fake = FakeSystemd(run=(1, 'PROBE FAILED native: x\n', 'Finished with result: exit-code\n'))
        self.assertEqual(self.run_probe(fake), sb.Ran('exit-code', 1, 'PROBE FAILED native: x\n'))
        unit = fake.calls[0][0][4].split('=', 1)[1]
        self.assertEqual([c[0] for c in fake.calls[1:]], [
            [sb.SYSTEMCTL, 'stop', unit], [sb.SYSTEMCTL, 'show', '--property=LoadState,ActiveState', unit]])
        self.assertEqual(fake.calls[0][1]['timeout'], 30 + 10 + 30)

    def test_systemd_never_ran_the_unit_is_transient(self):
        # #817 review: exit 1, empty stdout, a bus error on stderr — the candidate never ran.
        fake = FakeSystemd(run=(1, '', 'Failed to connect to bus: No such file or directory\n'))
        with self.assertRaisesRegex(sb.Transient, "^systemd-run did not run the unit \\(exit 1\\): 'Failed to connect to bus"):
            self.run_probe(fake)

    def test_a_lingering_unit_is_unconfirmed(self):
        fake = FakeSystemd(show=(0, 'LoadState=loaded\nActiveState=deactivating\n'))
        with self.assertRaisesRegex(sb.Unconfirmed, 'could not be confirmed stopped$'):
            self.run_probe(fake)

    def test_failed_show_is_unconfirmed_not_gone(self):
        # #817 review: an empty answer from a systemctl that failed proves nothing.
        fake = FakeSystemd(show=(1, ''))
        with self.assertRaisesRegex(sb.Unconfirmed, 'could not be confirmed stopped$'):
            self.run_probe(fake)

    def test_failed_unit_counts_as_stopped(self):
        self.assertEqual(self.run_probe(FakeSystemd(show=(0, 'LoadState=loaded\nActiveState=failed\n'))).result, 'success')

    def test_no_systemd_binary_is_transient_with_nothing_to_stop(self):
        fake = FakeSystemd(run_raises=FileNotFoundError(2, 'No such file or directory'))
        with self.assertRaisesRegex(sb.Transient, '^systemd-run could not start \\(No such file or directory\\)$'):
            self.run_probe(fake)
        self.assertEqual(len(fake.calls), 1)

    def test_any_exec_failure_is_transient(self):
        # #817 AI review: not only a missing binary — EPERM, EIO, EAGAIN at exec never start a unit either.
        fake = FakeSystemd(run_raises=PermissionError(13, 'Permission denied'))
        with self.assertRaisesRegex(sb.Transient, '^systemd-run could not start \\(Permission denied\\)$'):
            self.run_probe(fake)
        self.assertEqual(len(fake.calls), 1)

    def test_systemd_run_hanging_stops_the_unit_then_is_transient(self):
        fake = FakeSystemd(run_raises=subprocess.TimeoutExpired('systemd-run', 70))
        with self.assertRaisesRegex(sb.Transient, '^systemd-run did not return within 70 s$'):
            self.run_probe(fake)
        self.assertEqual(fake.calls[1][0][1], 'stop')


class Identity(unittest.TestCase):
    def test_identity_of_this_python_as_a_stand_in_binary(self):
        def runner(argv, **kw):
            return subprocess.CompletedProcess(argv, 0, 'v24.21.0 137\n', '')
        ident = sb.node_identity(sys.executable, runner)
        self.assertEqual((ident.realpath, ident.version, ident.modules, len(ident.sha256)),
                         (os.path.realpath(sys.executable), '24.21.0', '137', 64))


if __name__ == '__main__':
    unittest.main()
