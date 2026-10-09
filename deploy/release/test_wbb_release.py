import contextlib
import io
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish as pub  # noqa: E402
import wbb_release as cli  # noqa: E402
from release_testkit import SHA, packed  # noqa: E402
from zip_admission import sha256_file  # noqa: E402

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
        self.assertEqual((code, err), (1, f"REFUSED: release.json does not match the trusted run: repo='o/r'\n"))
        self.assertEqual(self.tokens_seen, ['tok'])

    def test_verify_without_receipt(self):
        code, _, err = self.run_cli(['verify', '--sha', SHA])
        self.assertEqual((code, err), (1, f'REFUSED: {SHA}: no receipt — not an accepted release\n'))

    def test_usage(self):
        code, _, _ = self.run_cli(['publish', '--sha', SHA])
        self.assertEqual(code, 64)

    def test_token_file_readable_by_others(self):
        os.chmod(self.token, 0o640)
        code, _, err = self.run_cli(['publish', '--sha', SHA, '--archive', self.zip])
        self.assertEqual((code, err), (1, f'REFUSED: {self.token}: must be a regular file owned by this user, not readable by others\n'))
        self.assertEqual(self.tokens_seen, [])

    def test_token_file_without_the_key(self):
        with open(self.token, 'w') as f:
            f.write('OTHER=x\n')
        code, _, err = self.run_cli(['publish', '--sha', SHA, '--archive', self.zip])
        self.assertEqual((code, err), (1, f'REFUSED: {self.token}: expected exactly one non-empty WBB_GITHUB_TOKEN=\n'))

    def test_production_releases_are_root_owned(self):
        self.assertEqual(cli.PRODUCTION_ROOTS.owner, (0, 0))

    def test_production_roots_share_one_filesystem_tree(self):
        # releases and staging under one directory, so publish's single rename can work.
        self.assertEqual((os.path.dirname(cli.PRODUCTION_ROOTS.releases), os.path.dirname(cli.PRODUCTION_ROOTS.scratch)),
                         ('/opt/warsaw-beer-bot', '/opt/warsaw-beer-bot'))


if __name__ == '__main__':
    unittest.main()
