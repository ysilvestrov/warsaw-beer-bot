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
            '/usr/bin/systemd-run', '--wait', '--pipe', '--collect', '--quiet', f'--unit={UNIT}',
            '-p', 'User=wbb-trial', '-p', 'Group=wbb-trial',
            '-p', 'PrivateNetwork=yes', '-p', 'ProtectHome=yes', '-p', 'NoNewPrivileges=yes',
            '-p', 'ProtectSystem=strict', '-p', 'PrivateTmp=yes', '-p', 'PrivateDevices=yes',
            '-p', 'InaccessiblePaths=-/etc/warsaw-beer-bot', '-p', 'InaccessiblePaths=-/etc/wbb-deploy',
            '-p', 'InaccessiblePaths=-/var/lib/warsaw-beer-bot', '-p', 'InaccessiblePaths=-/var/lib/wbb-deploy',
            '-p', f'ReadWritePaths={SCRATCH}', '-p', f'WorkingDirectory={SCRATCH}',
            '-p', 'CapabilityBoundingSet=', '-p', 'AmbientCapabilities=',
            '-p', 'MemoryMax=768M', '-p', 'CPUQuota=100%', '-p', 'TasksMax=64',
            '-p', 'RuntimeMaxSec=30', '-p', 'KillMode=control-group',
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

    def test_unit_name(self):
        self.assertRegex(sb.unit_name('trial', SHA), rf'^wbb-trial-trial-{SHA[:12]}-[0-9a-f]{{8}}$')


class FakeSystemd:
    def __init__(self, run_result=None, run_raises=None, show='ActiveState=inactive\nSubState=dead\n'):
        self.run_result, self.run_raises, self.show, self.calls = run_result, run_raises, show, []

    def __call__(self, argv, **kw):
        self.calls.append((argv, kw))
        if argv[0] == sb.SYSTEMD_RUN:
            if self.run_raises:
                raise self.run_raises
            return self.run_result
        return subprocess.CompletedProcess(argv, 0, self.show, '')


class Run(unittest.TestCase):
    def run_probe(self, fake):
        return sb.run_sandboxed('probe', SHA, RELEASE, SCRATCH, PROBE, ['native'], runner=fake)

    def test_exit_and_stdout_of_the_probe(self):
        fake = FakeSystemd(subprocess.CompletedProcess([], 1, 'PROBE FAILED native: x\n', ''))
        self.assertEqual(self.run_probe(fake), (1, 'PROBE FAILED native: x\n'))
        run_argv, run_kw = fake.calls[0]
        show_argv, _ = fake.calls[1]
        unit = run_argv[5].split('=', 1)[1]
        self.assertEqual((run_kw['timeout'], show_argv), (60, [sb.SYSTEMCTL, 'show', '--property=ActiveState,SubState', unit]))

    def test_collected_unit_is_fine(self):
        fake = FakeSystemd(subprocess.CompletedProcess([], 0, 'PROBE OK native: sqlite 3\n', ''), show='')
        self.assertEqual(self.run_probe(fake), (0, 'PROBE OK native: sqlite 3\n'))

    def test_unit_still_running_is_refused(self):
        fake = FakeSystemd(subprocess.CompletedProcess([], 0, '', ''), show='ActiveState=deactivating\nSubState=stop-sigterm\n')
        with self.assertRaisesRegex(Refused, r"is still \['ActiveState=deactivating', 'SubState=stop-sigterm'\] — its cgroup is not empty"):
            self.run_probe(fake)

    def test_no_systemd_is_transient(self):
        with self.assertRaisesRegex(sb.Transient, '^systemd-run is not available$'):
            self.run_probe(FakeSystemd(run_raises=FileNotFoundError()))

    def test_systemd_run_hanging_is_transient(self):
        with self.assertRaisesRegex(sb.Transient, '^systemd-run did not return within 60 s$'):
            self.run_probe(FakeSystemd(run_raises=subprocess.TimeoutExpired('systemd-run', 60)))


class Identity(unittest.TestCase):
    def test_identity_of_this_python_as_a_stand_in_binary(self):
        def runner(argv, **kw):
            return subprocess.CompletedProcess(argv, 0, 'v24.21.0 137\n', '')
        ident = sb.node_identity(sys.executable, runner)
        self.assertEqual((ident.realpath, ident.version, ident.modules, len(ident.sha256)),
                         (os.path.realpath(sys.executable), '24.21.0', '137', 64))


if __name__ == '__main__':
    unittest.main()
