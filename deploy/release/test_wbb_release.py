import contextlib
import hashlib
import io
import os
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish as pub  # noqa: E402
import sandbox as sb  # noqa: E402
import wbb_release as cli  # noqa: E402
from release_testkit import SHA, packed  # noqa: E402
from zip_admission import sha256_file  # noqa: E402
from audit_verdict import Finding, Verdict  # noqa: E402
from host_audit import AuditResult  # noqa: E402
from test_trial import Fake  # noqa: E402

REPO = 'ysilvestrov/warsaw-beer-bot'


class Cli(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = self._tmp.name
        self.roots = pub.Roots(*(os.path.join(base, d) for d in ('releases', 'receipts', 'scratch')),
                               (os.geteuid(), os.getegid()))
        for d in (self.roots.releases, self.roots.receipts, self.roots.scratch):
            os.makedirs(d)
        self.base = base
        self.zip = self.artifact('src', REPO)
        self.token = os.path.join(base, 'github.env')
        fd = os.open(self.token, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write('# token for the release verifier\nWBB_GITHUB_TOKEN=tok\n')
        self.tokens_seen = []

    def tearDown(self):
        self._tmp.cleanup()

    def artifact(self, name, repo):
        archive, _ = packed(os.path.join(self.base, name), repo=repo)
        path = os.path.join(self.base, f'{name}.zip')
        with zipfile.ZipFile(path, 'w') as z:
            z.write(archive, 'runtime.tar.gz')
            z.write(archive + '.sha256', 'runtime.tar.gz.sha256')
        return path

    def api_factory(self):
        """A fake API: this repository's run 7 attempt 2 for SHA, whose artifact is self.zip."""
        def factory(token):
            self.tokens_seen.append(token)

            def api(path):
                if '/runs?' in path:
                    return {'total_count': 1, 'workflow_runs': [{
                        'id': 7, 'run_attempt': 2, 'path': '.github/workflows/ci.yml', 'event': 'push',
                        'head_branch': 'main', 'head_sha': SHA, 'status': 'completed', 'conclusion': 'success',
                        'repository': {'full_name': REPO}, 'head_repository': {'full_name': REPO}}]}
                if '/jobs' in path:
                    return {'total_count': 2, 'jobs': [
                        {'name': n, 'run_id': 7, 'run_attempt': 2, 'status': 'completed', 'conclusion': 'success'}
                        for n in ('package', 'ci')]}
                return {'total_count': 1, 'artifacts': [{
                    'id': 99, 'name': f'wbb-release-{SHA}-7-2', 'expired': False,
                    'digest': f'sha256:{sha256_file(self.zip)}', 'workflow_run': {'id': 7, 'head_sha': SHA}}]}
            return api
        return factory

    def run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(argv, self.roots, self.token, self.api_factory())
        return code, out.getvalue(), err.getvalue()

    def test_publish_then_verify(self):
        code, out, err = self.run_cli(['publish', '--sha', SHA, '--archive', self.zip])
        self.assertEqual((code, out, err), (0, f'ACCEPTED {SHA}: run 7 attempt 2, artifact 99\n', ''))
        self.assertEqual(self.tokens_seen, ['tok'])
        code, out, _ = self.run_cli(['verify', '--sha', SHA])
        receipt = pub.read_receipt(os.path.join(self.roots.receipts, f'{SHA}.json'))
        self.assertEqual((code, out), (0, f'VERIFIED {SHA}: tree {receipt["treeSha256"]} (run 7 attempt 2)\n'))

    def test_publish_refuses_a_release_for_another_repository(self):
        self.zip = self.artifact('fork', 'o/r')
        code, _, err = self.run_cli(['publish', '--sha', SHA, '--archive', self.zip])
        self.assertEqual((code, err), (2, f"REFUSED: release.json does not match the trusted run: repo='o/r'\n"))
        self.assertEqual(self.tokens_seen, ['tok'])

    def test_verify_without_receipt(self):
        code, _, err = self.run_cli(['verify', '--sha', SHA])
        self.assertEqual((code, err), (2, f'REFUSED: {SHA}: no receipt — not an accepted release\n'))

    def test_usage(self):
        code, _, _ = self.run_cli(['publish', '--sha', SHA])
        self.assertEqual(code, 64)

    def test_token_file_readable_by_others(self):
        os.chmod(self.token, 0o640)
        code, _, err = self.run_cli(['publish', '--sha', SHA, '--archive', self.zip])
        self.assertEqual((code, err), (2, f'REFUSED: {self.token}: must be a regular file owned by this user, not readable by others\n'))
        self.assertEqual(self.tokens_seen, [])

    def test_token_file_without_the_key(self):
        with open(self.token, 'w') as f:
            f.write('OTHER=x\n')
        code, _, err = self.run_cli(['publish', '--sha', SHA, '--archive', self.zip])
        self.assertEqual((code, err), (2, f'REFUSED: {self.token}: expected exactly one non-empty WBB_GITHUB_TOKEN=\n'))

    def published(self):
        self.assertEqual(self.run_cli(['publish', '--sha', SHA, '--archive', self.zip])[0], 0)

    def run_step(self, argv, **kw):
        code, out, _ = self.run_step_err(argv, **kw)
        return code, out

    def run_step_err(self, argv, **kw):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(argv, self.roots, self.token, self.api_factory(), **kw)
        return code, out.getvalue(), err.getvalue()

    def test_audit_exit_codes(self):
        self.published()
        cases = [(Verdict('clean'), 0), (Verdict('advisory', findings=(Finding('a', 'high'),)), 1),
                 (Verdict('unrunnable', reason='is empty — x'), 75)]
        seen = [self.run_step(['audit', '--sha', SHA],
                              audit=lambda release, work, owner, v=v: AuditResult(v, 'd' * 64))[0] for v, _ in cases]
        self.assertEqual(seen, [code for _, code in cases])

    def test_audit_names_the_tree_it_checked(self):
        self.published()
        got = []
        code, out = self.run_step(['audit', '--sha', SHA], audit=lambda release, work, owner: got.append(
            (release, owner)) or AuditResult(Verdict('clean'), 'd' * 64))
        self.assertEqual((code, got, out), (0, [(os.path.join(self.roots.releases, SHA), self.roots.owner)],
                         f'AUDIT CLEAN {SHA} tree {"d" * 64}\n'
                         'npm audit: no high or critical advisory in production dependencies\n'))

    def test_audit_details_never_share_the_first_line(self):
        # 2b review S3: the controller reads one fixed first line; the findings follow it.
        v = Verdict('advisory', findings=(Finding('a', 'high', (('T', 'https://u'),)), Finding('b', 'critical')))
        code, out = self.run_step(['audit', '--sha', SHA], audit=lambda *a: AuditResult(v, 'd' * 64))
        self.assertEqual((code, out), (1, f'AUDIT ADVISORY {SHA} tree {"d" * 64}\na high — T https://u\nb critical\n'))

    def test_audit_of_a_bad_sha(self):
        code, _ = self.run_step(['audit', '--sha', '../x'], audit=lambda *a: self.fail('audit ran'))
        self.assertEqual(code, 2)

    def test_internal_error_is_70_with_a_traceback(self):
        # 2b review B1: an unexpected exception exited 1, the code of a bad candidate.
        def broken(*a):
            raise RuntimeError('bug')
        code, out, err = self.run_step_err(['audit', '--sha', SHA], audit=broken)
        self.assertEqual((code, out, err.splitlines()[0], err.splitlines()[-1]),
                         (70, '', 'Traceback (most recent call last):', 'RuntimeError: bug'))

    def sandboxed(self, argv, fake, **kw):
        patcher = mock.patch.object(sb, 'HIDDEN_BY_PRIVATE_TMP', ())  # this test's scratch is under /tmp
        patcher.start()
        self.addCleanup(patcher.stop)
        trial_root = os.path.join(self.base, 'trial')
        os.makedirs(trial_root, exist_ok=True)
        snaps = os.path.join(self.base, 'snaps')
        os.makedirs(snaps, exist_ok=True)
        with open(os.path.join(snaps, 'x-pre.db'), 'wb') as f:
            f.write(b'db')
        with open(os.path.join(snaps, 'x-pre.db.sha256'), 'w') as f:
            f.write(hashlib.sha256(b'db').hexdigest() + '\n')
        args = dict(trial_root=trial_root, snapshot_root=snaps, runner=fake, node=sys.executable,
                    ids=lambda: (os.geteuid(), os.getegid()), glibc=lambda: '2.39')
        return self.run_step_err(argv, **{**args, **kw})

    def node_line(self):
        real = os.path.realpath(sys.executable)
        with open(real, 'rb') as f:
            return f'NODE {real} {hashlib.sha256(f.read()).hexdigest()} 24.1.0 137\n'

    def test_probe_and_trial_verdicts_and_their_exit_codes(self):
        # 2b review N4: ok -> 0 and failed -> 1, with the verdict line and the Node it ran on (B3).
        self.published()
        cases = [
            (['probe', '--sha', SHA], Fake(), 0, f'PROBE OK {SHA}: native: sqlite 3.53.4\n'),
            (['probe', '--sha', SHA], Fake(sandbox_out='PROBE FAILED native: x\n', sandbox_exit=1, result='exit-code'), 1,
             f'PROBE FAILED {SHA}: native: x\n'),
            (['trial', '--sha', SHA, '--snapshot', 'x-pre.db'], Fake(sandbox_out='PROBE OK migrate: schema 1 -> 2 (knows 2)\n'),
             0, f'TRIAL OK {SHA}: migrate: schema 1 -> 2 (knows 2)\n'),
            (['trial', '--sha', SHA, '--snapshot', 'x-pre.db'],
             Fake(sandbox_out='PROBE FAILED migrate: boom\n', sandbox_exit=1, result='exit-code'), 1,
             f'TRIAL FAILED {SHA}: migrate: boom\n'),
        ]
        got = [self.sandboxed(argv, fake)[:2] for argv, fake, _, _ in cases]
        self.assertEqual(got, [(code, line + self.node_line()) for _, _, code, line in cases])

    def test_missing_trial_user_is_75_without_a_node_line(self):
        def no_user():
            raise KeyError('wbb-trial')
        self.published()
        code, out, err = self.sandboxed(['probe', '--sha', SHA], Fake(), ids=no_user)
        self.assertEqual((code, out, err), (75, f'PROBE TRANSIENT {SHA}: no wbb-trial user on this host\n', ''))

    def test_trial_of_an_unaccepted_release_is_refused(self):
        code, out, err = self.sandboxed(['trial', '--sha', SHA, '--snapshot', 'x-pre.db'], Fake())
        self.assertEqual((code, out, err), (2, '', f'REFUSED: {SHA}: no receipt — not an accepted release\n'))

    def test_trial_takes_a_snapshot_name_not_a_path(self):
        self.published()
        fake = Fake()
        code, out, err = self.sandboxed(['trial', '--sha', SHA, '--snapshot', '/etc/shadow'], fake)
        self.assertEqual((code, out, err, fake.calls), (2, '', "REFUSED: not a pre snapshot name: '/etc/shadow'\n", []))

    def test_production_snapshot_root(self):
        self.assertEqual(cli.SNAPSHOT_ROOT, '/var/lib/warsaw-beer-bot/deploy-snapshots')

    def test_probe_transient_is_75(self):
        self.published()
        code, out, _ = self.sandboxed(['probe', '--sha', SHA], Fake(sandbox_raises=FileNotFoundError()))
        self.assertEqual((code, out), (75, f'PROBE TRANSIENT {SHA}: systemd-run could not start (FileNotFoundError)\n'
                                           + self.node_line()))

    def test_switch_then_again(self):
        self.published()
        got = [self.run_cli(['switch', '--sha', SHA]), self.run_cli(['switch', '--sha', SHA])]
        tree = pub.read_receipt(os.path.join(self.roots.receipts, f'{SHA}.json'))['treeSha256']
        self.assertEqual(got, [(0, f'SWITCHED {SHA} tree {tree}\n', ''), (0, f'CURRENT {SHA} tree {tree}\n', '')])
        self.assertEqual(os.readlink(os.path.join(self.base, 'current')), f'releases/{SHA}')

    def test_switch_to_an_unaccepted_release_is_refused(self):
        code, out, err = self.run_cli(['switch', '--sha', SHA])
        self.assertEqual((code, out, err, os.path.lexists(os.path.join(self.base, 'current'))),
                         (2, '', f'REFUSED: {SHA}: no receipt — not an accepted release\n', False))

    def test_switch_usage(self):
        self.assertEqual([self.run_cli(argv)[0] for argv in (['switch'], ['switch', '--sha'])], [64, 64])

    def test_production_releases_are_root_owned(self):
        self.assertEqual(cli.PRODUCTION_ROOTS.owner, (0, 0))

    def test_production_trial_root(self):
        # Outside /tmp and /var/tmp, which PrivateTmp hides from the unit (gate G2).
        self.assertEqual(cli.TRIAL_ROOT, '/var/lib/wbb-trial')

    def test_production_roots_share_one_filesystem_tree(self):
        # releases and staging under one directory, so publish's single rename can work.
        self.assertEqual((os.path.dirname(cli.PRODUCTION_ROOTS.releases), os.path.dirname(cli.PRODUCTION_ROOTS.scratch)),
                         ('/opt/warsaw-beer-bot', '/opt/warsaw-beer-bot'))


if __name__ == '__main__':
    unittest.main()
