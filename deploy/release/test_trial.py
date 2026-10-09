import hashlib
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish as pub  # noqa: E402
import sandbox as sb  # noqa: E402
import trial as tr  # noqa: E402
from release_testkit import SHA, packed, write  # noqa: E402
from safe_tar import Refused  # noqa: E402
from test_publish import trusted_for, zip_up  # noqa: E402

IDS = (os.geteuid(), os.getegid())


class Fake:
    """systemd-run / systemctl / node -p, recording each call and what the scratch held."""

    def __init__(self, sandbox_out='PROBE OK native: sqlite 3.53.4\n', sandbox_exit=0, node_out='v24.1.0 137\n',
                 sandbox_raises=None, result='success', stderr=None, show=(0, 'LoadState=not-found\nActiveState=inactive\n')):
        self.sandbox_out, self.sandbox_exit, self.node_out, self.sandbox_raises = sandbox_out, sandbox_exit, node_out, sandbox_raises
        self.stderr = stderr if stderr is not None else f'Finished with result: {result}\n'
        self.show = show
        self.calls = []

    def __call__(self, argv, **kw):
        if argv[0] == sb.SYSTEMD_RUN:
            scratch = next(p.split('=', 1)[1] for p in argv if p.startswith('WorkingDirectory='))
            db = os.path.join(scratch, 'trial.db')
            self.calls.append(('systemd-run', argv[-3:], sorted(os.listdir(scratch)),
                               (open(db, 'rb').read(), stat.S_IMODE(os.stat(db).st_mode)) if os.path.exists(db) else None))
            if self.sandbox_raises:
                raise self.sandbox_raises
            return subprocess.CompletedProcess(argv, self.sandbox_exit, self.sandbox_out, self.stderr)
        if argv[0] == sb.SYSTEMCTL:
            self.calls.append(('systemctl ' + argv[1],))
            return subprocess.CompletedProcess(argv, self.show[0] if argv[1] == 'show' else 0,
                                               self.show[1] if argv[1] == 'show' else '', '')
        self.calls.append(('node -p',))
        return subprocess.CompletedProcess(argv, 0, self.node_out, '')


class Tmp(unittest.TestCase):
    def setUp(self):
        # These tests keep their scratch under the test temp dir, which lives in /tmp. A real
        # unit could not see it (gate G2); that refusal is test_sandbox's to prove, not these.
        patcher = mock.patch.object(sb, 'HIDDEN_BY_PRIVATE_TMP', ())
        patcher.start()
        self.addCleanup(patcher.stop)
        self._tmp = tempfile.TemporaryDirectory()
        base = self._tmp.name
        self.roots = pub.Roots(*(os.path.join(base, d) for d in ('releases', 'receipts', 'scratch')), IDS)
        for d in (self.roots.releases, self.roots.receipts, self.roots.scratch):
            os.makedirs(d)
        archive, _ = packed(os.path.join(base, 'src'))
        z = zip_up(archive, os.path.join(base, 'a.zip'))
        pub.publish(trusted_for(z), z, self.roots, lambda: 'now')
        self.trial_root = os.path.join(base, 'trial')
        os.makedirs(self.trial_root)
        self.snapshot = os.path.join(base, 'snaps', 'x-pre.db')
        write(os.path.dirname(self.snapshot), 'x-pre.db', b'SQLite pretend bytes')
        with open(self.snapshot + '.sha256', 'w') as f:
            f.write(hashlib.sha256(b'SQLite pretend bytes').hexdigest() + '\n')

    def tearDown(self):
        self._tmp.cleanup()

    def probe(self, fake, **kw):
        return tr.probe(SHA, self.roots, self.trial_root, runner=fake, node=sys.executable, ids=lambda: IDS,
                        glibc=lambda: '2.39', **kw)

    def trial(self, fake):
        return tr.trial(SHA, self.snapshot, self.roots, self.trial_root, runner=fake, node=sys.executable, ids=lambda: IDS)


class Probe(Tmp):
    def test_ok(self):
        fake = Fake()
        step = self.probe(fake)
        self.assertEqual((step.kind, step.detail, step.node.modules), ('ok', 'native: sqlite 3.53.4', '137'))
        self.assertEqual([c[0] for c in fake.calls], ['node -p', 'systemd-run', 'systemctl stop', 'systemctl show'])
        self.assertEqual(fake.calls[1][1], [sys.executable, tr.PROBE_FILE, 'native'])
        self.assertEqual(fake.calls[1][2], ['tmp'])
        self.assertEqual(os.listdir(self.trial_root), [])

    def test_changed_tree_runs_nothing(self):
        write(os.path.join(self.roots.releases, SHA), 'dist/index.js', b'console.log(5);\n')
        fake = Fake()
        with self.assertRaisesRegex(Refused, 'release tree changed'):
            self.probe(fake)
        self.assertEqual(fake.calls, [])

    def test_other_abi_fails_without_running(self):
        fake = Fake(node_out='v24.1.0 141\n')
        step = self.probe(fake)
        self.assertEqual((step.kind, step.detail), ('failed', "incompatible with this host: release.json: node 24/ABI '137', "
                                                              'this machine runs 24/ABI 141'))
        self.assertEqual([c[0] for c in fake.calls], ['node -p'])

    def test_older_host_glibc_fails_without_running(self):
        fake = Fake()
        step = tr.probe(SHA, self.roots, self.trial_root, runner=fake, node=sys.executable, ids=lambda: IDS,
                        glibc=lambda: '2.35')
        self.assertEqual((step.kind, step.detail),
                         ('failed', "incompatible with this host: release.json: glibc '2.39' is newer than this machine's 2.35"))
        self.assertEqual([c[0] for c in fake.calls], ['node -p'])

    def test_probe_failure(self):
        step = self.probe(Fake(sandbox_out='PROBE FAILED native: Cannot find module\n', sandbox_exit=1))
        self.assertEqual((step.kind, step.detail), ('failed', 'native: Cannot find module'))

    def test_no_result_line(self):
        step = self.probe(Fake(sandbox_out='Segmentation fault\n', sandbox_exit=139, result='core-dump'))
        self.assertEqual((step.kind, step.detail),
                         ('failed', "native: no result line from the probe (core-dump, exit 139): 'Segmentation fault'"))

    def test_systemd_never_running_the_unit_is_transient(self):
        # #817 review P2: a bus failure must not become a failed candidate.
        step = self.probe(Fake(sandbox_out='', sandbox_exit=1, stderr='Failed to connect to bus: No such file or directory\n'))
        self.assertEqual((step.kind, step.detail), ('transient', "systemd-run did not run the unit (exit 1): "
                                                                 "'Failed to connect to bus: No such file or directory'"))
        self.assertEqual(os.listdir(self.trial_root), [])

    def test_unconfirmed_stop_keeps_the_scratch(self):
        # #817 review P2: no removal while the unit may still be alive.
        step = self.probe(Fake(show=(0, 'LoadState=loaded\nActiveState=deactivating\n')))
        kept = os.listdir(self.trial_root)
        self.assertEqual((step.kind, len(kept)), ('transient', 1))
        self.assertRegex(step.detail, rf'^sandbox unit wbb-trial-probe-{SHA[:12]}-[0-9a-f]{{8}} could not be confirmed stopped; '
                                      rf'scratch kept at {re.escape(os.path.join(self.trial_root, kept[0]))} for inspection$')


class Trial(Tmp):
    def test_ok_on_a_private_copy(self):
        fake = Fake(sandbox_out='PROBE OK migrate: schema 40 -> 45\n')
        step = self.trial(fake)
        self.assertEqual((step.kind, step.detail), ('ok', 'migrate: schema 40 -> 45'))
        name, args, listing, db = fake.calls[0]
        self.assertEqual((name, args[:2], os.path.basename(args[2]), listing, db),
                         ('systemd-run', [tr.PROBE_FILE, 'migrate'], 'trial.db', ['tmp', 'trial.db'],
                          (b'SQLite pretend bytes', 0o600)))
        self.assertEqual(os.listdir(self.trial_root), [])

    def test_snapshot_checksum_mismatch_runs_nothing(self):
        with open(self.snapshot, 'ab') as f:
            f.write(b'!')
        fake = Fake()
        step = self.trial(fake)
        got, want = hashlib.sha256(b'SQLite pretend bytes!').hexdigest(), hashlib.sha256(b'SQLite pretend bytes').hexdigest()
        self.assertEqual(step, tr.Step('transient', f'snapshot unusable: {self.snapshot}: sha256 {got} != {want}'))
        self.assertEqual(fake.calls, [])
        self.assertEqual(os.listdir(self.trial_root), [])

    def test_symlinked_snapshot_runs_nothing(self):
        link = self.snapshot.replace('x-pre', 'y-pre')
        os.symlink(self.snapshot, link)
        os.symlink(self.snapshot + '.sha256', link + '.sha256')
        fake = Fake()
        step = tr.trial(SHA, link, self.roots, self.trial_root, runner=fake, node=sys.executable, ids=lambda: IDS)
        self.assertEqual(step, tr.Step('transient', f'snapshot unusable: {link}: cannot open (Too many levels of symbolic links)'))
        self.assertEqual(fake.calls, [])

    def test_relative_snapshot_path(self):
        step = tr.trial(SHA, 'x-pre.db', self.roots, self.trial_root, runner=Fake(), node=sys.executable, ids=lambda: IDS)
        self.assertEqual(step, tr.Step('transient', "snapshot unusable: snapshot path must be absolute: 'x-pre.db'"))

    def test_migration_failure_fails_the_candidate(self):
        step = self.trial(Fake(sandbox_out='PROBE FAILED migrate: integrity_check: [...]\n', sandbox_exit=1))
        self.assertEqual((step.kind, step.detail), ('failed', 'migrate: integrity_check: [...]'))

    def test_killed_at_the_time_limit_fails_the_candidate(self):
        step = self.trial(Fake(sandbox_out='', sandbox_exit=1, result='timeout'))
        self.assertEqual(step, tr.Step('failed', 'migrate: killed by the sandbox (timeout)'))
        self.assertEqual(os.listdir(self.trial_root), [])

    def test_unconfirmed_stop_keeps_the_trial_scratch(self):
        step = self.trial(Fake(sandbox_out='PROBE OK migrate: schema 1 -> 1\n', show=(1, '')))
        self.assertEqual((step.kind, len(os.listdir(self.trial_root))), ('transient', 1))

    def test_wrong_mode_line_is_not_a_pass(self):
        step = self.trial(Fake(sandbox_out='PROBE OK native: sqlite\n'))
        self.assertEqual(step.kind, 'failed')


if __name__ == '__main__':
    unittest.main()
