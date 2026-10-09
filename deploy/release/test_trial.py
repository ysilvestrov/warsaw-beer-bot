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
NODE_REAL = os.path.realpath(sys.executable)
RAN = ['node -p', 'systemctl list-units', 'systemd-run', 'systemctl stop', 'systemctl show']


class Fake:
    """systemd-run / systemctl / node -p, recording each call and what the scratch held."""

    def __init__(self, sandbox_out='PROBE OK native: sqlite 3.53.4\n', sandbox_exit=0, node_out='v24.1.0 137\n',
                 sandbox_raises=None, result='success', stderr=None, show=(0, 'LoadState=not-found\nActiveState=inactive\n'),
                 on_run=None):
        self.sandbox_out, self.sandbox_exit, self.node_out, self.sandbox_raises = sandbox_out, sandbox_exit, node_out, sandbox_raises
        self.stderr = stderr if stderr is not None else f'Finished with result: {result}\n'
        self.show = show
        self.on_run = on_run
        self.calls = []

    def __call__(self, argv, **kw):
        if argv[0] == sb.SYSTEMD_RUN:
            scratch = next(p.split('=', 1)[1] for p in argv if p.startswith('WorkingDirectory='))
            db = os.path.join(scratch, 'trial.db')
            self.calls.append(('systemd-run', argv[-3:], sorted(os.listdir(scratch)),
                               (open(db, 'rb').read(), stat.S_IMODE(os.stat(db).st_mode)) if os.path.exists(db) else None))
            if self.on_run:
                self.on_run()
            if self.sandbox_raises:
                raise self.sandbox_raises
            return subprocess.CompletedProcess(argv, self.sandbox_exit, self.sandbox_out, self.stderr)
        if argv[0] == sb.SYSTEMCTL and argv[1] == 'list-units':
            self.calls.append(('systemctl list-units',))
            return subprocess.CompletedProcess(argv, 0, '', '')
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
        self.snaps = os.path.join(base, 'snaps')
        self.snapshot = os.path.join(self.snaps, 'x-pre.db')
        write(self.snaps, 'x-pre.db', b'SQLite pretend bytes')
        with open(self.snapshot + '.sha256', 'w') as f:
            f.write(hashlib.sha256(b'SQLite pretend bytes').hexdigest() + '\n')

    def tearDown(self):
        self._tmp.cleanup()

    def probe(self, fake, **kw):
        return tr.probe(SHA, self.roots, self.trial_root, runner=fake, node=sys.executable, ids=lambda: IDS,
                        glibc=lambda: '2.39', **kw)

    def trial(self, fake, free=1 << 40, glibc='2.39', name='x-pre.db', ids=lambda: IDS):
        return tr.trial(SHA, name, self.roots, self.trial_root, self.snaps, runner=fake, node=sys.executable, ids=ids,
                        glibc=lambda: glibc, free=lambda path: free)


class Probe(Tmp):
    def test_ok(self):
        fake = Fake()
        step = self.probe(fake)
        self.assertEqual((step.kind, step.detail, step.node.modules), ('ok', 'native: sqlite 3.53.4', '137'))
        self.assertEqual([c[0] for c in fake.calls], RAN)
        self.assertEqual(fake.calls[2][1], [NODE_REAL, tr.PROBE_FILE, 'native'])
        self.assertEqual(fake.calls[2][2], ['tmp'])
        self.assertEqual(os.listdir(self.trial_root), [])

    def test_runs_the_binary_whose_identity_it_took(self):
        # 2b review N9: a node path that is a symlink is run by its target, the file that was hashed.
        link = os.path.join(self._tmp.name, 'node-link')
        os.symlink(sys.executable, link)
        fake = Fake()
        step = tr.probe(SHA, self.roots, self.trial_root, runner=fake, node=link, ids=lambda: IDS, glibc=lambda: '2.39')
        self.assertEqual((step.node.realpath, fake.calls[2][1][0]), (NODE_REAL, NODE_REAL))

    def test_unit_systemd_did_not_start_is_transient(self):
        # 2b review B2: 226/NAMESPACE is what gate G2's first run saw — a host setup failure, not the candidate.
        step = self.probe(Fake(sandbox_out='', sandbox_exit=226, result='exit-code'))
        self.assertEqual((step.kind, step.detail), (
            'transient', "native: the sandbox unit did not start the probe (exit-code, exit 226): ''"))
        self.assertEqual(os.listdir(self.trial_root), [])

    def test_systemd_exec_statuses_end_at_243(self):
        kinds = [(code, self.probe(Fake(sandbox_out='', sandbox_exit=code, result='exit-code')).kind)
                 for code in (199, 200, 243, 244)]
        self.assertEqual(kinds, [(199, 'failed'), (200, 'transient'), (243, 'transient'), (244, 'failed')])

    def test_unit_out_of_resources_is_transient(self):
        step = self.probe(Fake(sandbox_out='', sandbox_exit=1, result='resources'))
        self.assertEqual(step.kind, 'transient')

    def test_node_that_started_and_died_fails_the_candidate(self):
        step = self.probe(Fake(sandbox_out='', sandbox_exit=1, result='exit-code'))
        self.assertEqual((step.kind, step.detail), ('failed', "native: no result line from the probe (exit-code, exit 1): ''"))

    def test_a_result_line_decides_even_with_a_systemd_status(self):
        step = self.probe(Fake(sandbox_out='PROBE FAILED native: x\n', sandbox_exit=226, result='exit-code'))
        self.assertEqual((step.kind, step.detail), ('failed', 'native: x'))

    def test_missing_trial_user_is_transient(self):
        # 2b review B1: forgetting to create wbb-trial was a traceback, which exited like a bad candidate.
        def no_user():
            raise KeyError('getpwnam(): name not found: wbb-trial')
        fake = Fake()
        step = tr.probe(SHA, self.roots, self.trial_root, runner=fake, node=sys.executable, ids=no_user,
                        glibc=lambda: '2.39')
        self.assertEqual((step, [c[0] for c in fake.calls]),
                         (tr.Step('transient', 'no wbb-trial user on this host'), ['node -p']))

    def test_missing_scratch_root_is_transient(self):
        fake = Fake()
        step = tr.probe(SHA, self.roots, os.path.join(self.trial_root, 'gone'), runner=fake, node=sys.executable,
                        ids=lambda: IDS, glibc=lambda: '2.39')
        self.assertEqual((step, [c[0] for c in fake.calls]), (
            tr.Step('transient', 'cannot prepare the sandbox scratch: No such file or directory'), ['node -p']))

    def test_scratch_that_cannot_be_chowned_is_transient_and_removed(self):
        def deny(*a):
            raise PermissionError(1, 'Operation not permitted')
        with mock.patch.object(tr.os, 'chown', deny):
            step = self.probe(Fake())
        self.assertEqual((step, os.listdir(self.trial_root)), (
            tr.Step('transient', 'cannot prepare the sandbox scratch: Operation not permitted'), []))

    def test_interrupt_with_the_unit_unconfirmed_keeps_the_scratch(self):
        # 2b review N2: the finally no longer removes the scratch of a unit that may be alive.
        step = self.probe(Fake(sandbox_raises=KeyboardInterrupt(), show=(0, 'LoadState=loaded\nActiveState=active\n')))
        self.assertEqual((step.kind, len(os.listdir(self.trial_root))), ('transient', 1))

    def test_interrupt_with_the_unit_stopped_removes_the_scratch(self):
        with self.assertRaises(KeyboardInterrupt):
            self.probe(Fake(sandbox_raises=KeyboardInterrupt()))
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
        fake = Fake(sandbox_out='PROBE OK migrate: schema 40 -> 45 (knows 45)\n')
        step = self.trial(fake)
        self.assertEqual((step.kind, step.detail), ('ok', 'migrate: schema 40 -> 45 (knows 45)'))
        self.assertEqual([c[0] for c in fake.calls], RAN)
        name, args, listing, db = fake.calls[2]
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
        self.assertEqual(fake.calls, [('node -p',)])
        self.assertEqual(os.listdir(self.trial_root), [])

    def test_snapshot_is_a_name_never_a_path(self):
        # 2b review S2: root reads only <name>-pre.db in the one snapshot directory.
        for name in ('../snaps/x-pre.db', self.snapshot, 'x.db', '.x-pre.db', '-pre.db', 'x-pre.db.sha256',
                     'x-pre.db/', 'a b-pre.db', ''):
            with self.subTest(name=name):
                fake = Fake()
                with self.assertRaisesRegex(Refused, '^not a pre snapshot name: '):
                    self.trial(fake, name=name)
                self.assertEqual(fake.calls, [])

    def test_shortest_snapshot_name(self):
        write(self.snaps, 'a-pre.db', b'SQLite pretend bytes')
        os.link(self.snapshot + '.sha256', os.path.join(self.snaps, 'a-pre.db.sha256'))
        self.assertEqual(self.trial(Fake(sandbox_out='PROBE OK migrate: schema 1 -> 1 (knows 1)\n'), name='a-pre.db').kind, 'ok')

    def test_symlinked_snapshot_directory_runs_nothing(self):
        real = self.snaps + '-real'
        os.rename(self.snaps, real)
        os.symlink(real, self.snaps)
        fake = Fake()
        step = self.trial(fake)
        self.assertEqual(step, tr.Step('transient', f'snapshot unusable: {self.snaps}: cannot open the snapshot directory '
                                                    '(Not a directory)'))
        self.assertEqual(fake.calls, [('node -p',)])

    def test_symlinked_checksum_runs_nothing(self):
        # The .sha256 is opened like the snapshot: relative to the directory handle, never through a link.
        os.rename(self.snapshot + '.sha256', self.snapshot + '.sum')
        os.symlink(self.snapshot + '.sum', self.snapshot + '.sha256')
        fake = Fake()
        step = self.trial(fake)
        self.assertEqual(step, tr.Step('transient', f'snapshot unusable: {self.snapshot}.sha256: Too many levels of symbolic links'))
        self.assertEqual(fake.calls, [('node -p',)])

    def test_missing_snapshot(self):
        step = self.trial(Fake(), name='y-pre.db')
        self.assertEqual(step, tr.Step('transient', f'snapshot unusable: {self.snaps}/y-pre.db.sha256: No such file or directory'))

    def test_tree_changed_after_the_copy_runs_nothing(self):
        # 2b review N4: the trial checks the tree again after the copy, right before the run.
        real_copy = tr.copy_snapshot

        def copy_then_change(*a, **kw):
            real_copy(*a, **kw)
            write(os.path.join(self.roots.releases, SHA), 'dist/index.js', b'console.log(5);\n')
        fake = Fake()
        with mock.patch.object(tr, 'copy_snapshot', copy_then_change):
            with self.assertRaisesRegex(Refused, 'release tree changed'):
                self.trial(fake)
        self.assertEqual(([c[0] for c in fake.calls], os.listdir(self.trial_root)), (['node -p'], []))

    def test_copy_that_cannot_be_chowned_is_transient(self):
        # 2b review B1: the chown after the copy was outside every handler.
        real_chown = os.chown

        def deny_db(path, *a):
            if str(path).endswith('trial.db'):
                raise PermissionError(1, 'Operation not permitted')
            return real_chown(path, *a)
        fake = Fake()
        with mock.patch.object(tr.os, 'chown', deny_db):
            step = self.trial(fake)
        self.assertEqual(step, tr.Step('transient', f'snapshot unusable: {self.snapshot}: copy failed (Operation not permitted)'))
        self.assertEqual((os.listdir(self.trial_root), [c[0] for c in fake.calls]), ([], ['node -p']))

    def test_symlinked_snapshot_runs_nothing(self):
        link = self.snapshot.replace('x-pre', 'y-pre')
        os.symlink(self.snapshot, link)
        os.link(self.snapshot + '.sha256', link + '.sha256')
        fake = Fake()
        step = self.trial(fake, name='y-pre.db')
        self.assertEqual(step, tr.Step('transient', f'snapshot unusable: {link}: cannot open (Too many levels of symbolic links)'))
        self.assertEqual(fake.calls, [('node -p',)])

    def test_migration_failure_fails_the_candidate(self):
        step = self.trial(Fake(sandbox_out='PROBE FAILED migrate: integrity_check: [...]\n', sandbox_exit=1))
        self.assertEqual((step.kind, step.detail), ('failed', 'migrate: integrity_check: [...]'))

    def test_incompatible_release_is_refused_before_the_trial_runs(self):
        # #817 AI review: the trial applies the probe's ABI/glibc gate too.
        fake = Fake(node_out='v24.1.0 141\n')
        step = self.trial(fake)
        self.assertEqual((step.kind, [c[0] for c in fake.calls]), ('failed', ['node -p']))

    def test_unanswering_node_is_transient(self):
        fake = Fake(node_out='garbage\n')
        step = self.trial(fake)
        self.assertEqual((step, [c[0] for c in fake.calls]), (tr.Step(
            'transient', 'host Node/glibc identity unavailable: ValueError: not enough values to unpack (expected 2, got 1)'),
            ['node -p']))

    def test_unreadable_host_glibc_is_transient(self):
        # #817 AI review: a host that cannot say its glibc says nothing about the candidate.
        def broken():
            raise OSError(22, 'Invalid argument')
        fake = Fake()
        step = tr.trial(SHA, 'x-pre.db', self.roots, self.trial_root, self.snaps, runner=fake, node=sys.executable,
                        ids=lambda: IDS, glibc=broken, free=lambda path: 1 << 40)
        self.assertEqual((step, [c[0] for c in fake.calls]), (tr.Step(
            'transient', 'host Node/glibc identity unavailable: OSError: [Errno 22] Invalid argument'), ['node -p']))

    def test_trial_reports_the_node_it_ran_on(self):
        step = self.trial(Fake(sandbox_out='PROBE OK migrate: schema 1 -> 1 (knows 1)\n'))
        self.assertEqual((step.node.realpath, step.node.modules), (NODE_REAL, '137'))

    def test_snapshot_growing_during_the_copy_is_refused(self):
        # #817 AI review: copy exactly the size the free-space check counted.
        real_fstat = os.fstat
        grown = []

        def fstat_then_grow(fd):
            st = real_fstat(fd)
            if not grown:
                grown.append(True)
                with open(self.snapshot, 'ab') as more:
                    more.write(b'+appended after fstat')
            return st
        fake = Fake()
        with mock.patch.object(tr.os, 'fstat', fstat_then_grow):
            step = self.trial(fake)
        self.assertEqual(step, tr.Step('transient', f'snapshot unusable: {self.snapshot}: grew while being copied'))
        self.assertEqual(os.listdir(self.trial_root), [])

    def test_copy_that_would_eat_the_disk_reserve_is_refused(self):
        # #817 AI review: never let the trial copy take the host under its free-space reserve.
        fake = Fake()
        size = len(b'SQLite pretend bytes')
        step = self.trial(fake, free=tr.MIN_FREE_AFTER_COPY + size - 1)
        self.assertEqual(step, tr.Step('transient', f'snapshot unusable: {self.snapshot}: copying {size} bytes would leave '
                                                    f'{tr.MIN_FREE_AFTER_COPY - 1} free, under the {tr.MIN_FREE_AFTER_COPY} '
                                                    'the host must keep'))
        self.assertEqual((os.listdir(self.trial_root), [c[0] for c in fake.calls]), ([], ['node -p']))

    def test_reserve_exactly_kept_is_fine(self):
        step = self.trial(Fake(sandbox_out='PROBE OK migrate: schema 1 -> 1 (knows 1)\n'),
                          free=tr.MIN_FREE_AFTER_COPY + len(b'SQLite pretend bytes'))
        self.assertEqual(step.kind, 'ok')

    def test_disk_full_during_the_copy_is_transient_and_leaves_nothing(self):
        real_open = os.open

        def full(path, flags, *a, **kw):
            if str(path).endswith('trial.db'):
                raise OSError(28, 'No space left on device')
            return real_open(path, flags, *a, **kw)
        with mock.patch.object(tr.os, 'open', full):
            step = self.trial(Fake())
        self.assertEqual(step, tr.Step('transient', f'snapshot unusable: {self.snapshot}: copy failed (No space left on device)'))
        self.assertEqual(os.listdir(self.trial_root), [])

    def test_killed_at_the_time_limit_fails_the_candidate(self):
        step = self.trial(Fake(sandbox_out='', sandbox_exit=1, result='timeout'))
        self.assertEqual((step.kind, step.detail), ('failed', 'migrate: killed by the sandbox (timeout)'))
        self.assertEqual(os.listdir(self.trial_root), [])

    def test_unconfirmed_stop_keeps_the_trial_scratch(self):
        step = self.trial(Fake(sandbox_out='PROBE OK migrate: schema 1 -> 1 (knows 1)\n', show=(1, '')))
        self.assertEqual((step.kind, len(os.listdir(self.trial_root))), ('transient', 1))

    def test_wrong_mode_line_is_not_a_pass(self):
        step = self.trial(Fake(sandbox_out='PROBE OK native: sqlite\n'))
        self.assertEqual(step.kind, 'failed')

    def test_only_a_sound_schema_move_passes(self):
        # 2b review N5: an OK line is not enough — no version after, a move backwards, or a
        # database newer than the release is a failed candidate.
        cases = {
            'schema none -> 46 (knows 46)': ('ok', 'migrate: schema none -> 46 (knows 46)'),
            'schema 46 -> 46 (knows 46)': ('ok', 'migrate: schema 46 -> 46 (knows 46)'),
            'schema 40 -> null (knows 46)': ('failed', 'migrate: no schema version after migrate (schema 40 -> null (knows 46))'),
            'schema none -> null (knows 46)': ('failed', 'migrate: no schema version after migrate (schema none -> null (knows 46))'),
            'schema 46 -> 45 (knows 46)': ('failed', 'migrate: schema moved backwards (schema 46 -> 45 (knows 46))'),
            'schema 47 -> 47 (knows 46)': ('failed', 'migrate: the database is newer than this release (schema 47 -> 47 (knows 46))'),
            'schema 40 -> 45': ('failed', "migrate: unexpected migrate result 'schema 40 -> 45'"),
        }
        got = {line: (lambda s: (s.kind, s.detail))(self.trial(Fake(sandbox_out=f'PROBE OK migrate: {line}\n')))
               for line in cases}
        self.assertEqual(got, cases)


if __name__ == '__main__':
    unittest.main()
