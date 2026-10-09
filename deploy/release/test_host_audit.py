import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import host_audit as ha  # noqa: E402
import publish as pub  # noqa: E402
import tree_manifest as tm  # noqa: E402
from audit_verdict import Verdict  # noqa: E402
from release_testkit import SHA, packed, write  # noqa: E402
from safe_tar import Refused  # noqa: E402
from test_publish import trusted_for, zip_up  # noqa: E402

CLEAN = b'{"auditReportVersion": 2, "vulnerabilities": {}}'


def operator():
    return 1000


class Runner:
    """Records the call and what the audit directory held at that moment."""

    def __init__(self, stdout=CLEAN, raises=None, stderr=b''):
        self.stdout, self.raises, self.stderr, self.calls = stdout, raises, stderr, []

    def __call__(self, argv, cwd, env, capture_output, timeout, check):
        base = os.path.dirname(cwd)
        self.calls.append({
            'argv': argv, 'cwd': cwd, 'env': env, 'timeout': timeout,
            'project': sorted(os.listdir(cwd)), 'base': sorted(os.listdir(base)),
            'configs': [os.path.getsize(os.path.join(base, n)) for n in ('user.npmrc', 'global.npmrc')],
        })
        if self.raises:
            raise self.raises
        return subprocess.CompletedProcess(argv, 1, self.stdout, self.stderr)


IDS = (os.geteuid(), os.getegid())


class Audit(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = self._tmp.name
        self.roots = pub.Roots(*(os.path.join(base, d) for d in ('releases', 'receipts', 'scratch')), IDS)
        for d in (self.roots.releases, self.roots.receipts, self.roots.scratch):
            os.makedirs(d)
        # As the installer will make it, whatever this test process's umask is.
        os.chmod(self.roots.releases, 0o755)
        archive, self.manifest = packed(os.path.join(base, 'src'))
        z = zip_up(archive, os.path.join(base, 'a.zip'))
        pub.publish(trusted_for(z), z, self.roots, lambda: 'now')
        self.release = os.path.join(self.roots.releases, SHA)
        self.work = os.path.join(base, 'work')
        os.makedirs(self.work)

    def tearDown(self):
        self._tmp.cleanup()

    def audit(self, runner, **kw):
        return ha.audit_release(self.release, self.work, IDS, runner=runner, euid=operator, **kw)

    def test_exact_command_environment_and_directory(self):
        # A stray .npmrc next to the release's lockfile never reaches the audit.
        write(self.release, '.npmrc', b'registry=https://evil.invalid/\n')
        runner = Runner()
        self.assertEqual(self.audit(runner), ha.AuditResult(Verdict('clean'), tm.tree_digest(self.manifest)))
        call = runner.calls[0]
        base = os.path.dirname(call['cwd'])
        self.assertEqual(call['argv'], [
            '/usr/bin/npm', 'audit', '--omit=dev', '--package-lock-only', '--json',
            '--userconfig', os.path.join(base, 'user.npmrc'), '--globalconfig', os.path.join(base, 'global.npmrc'),
            '--registry', 'https://registry.npmjs.org/', '--ignore-scripts'])
        self.assertEqual(call['env'], {'PATH': '/usr/bin:/bin', 'HOME': os.path.join(base, 'home')})
        self.assertEqual(call['timeout'], 120)
        self.assertEqual(call['project'], ['package-lock.json', 'package.json'])
        self.assertEqual(call['base'], ['global.npmrc', 'home', 'project', 'user.npmrc'])
        self.assertEqual(call['configs'], [0, 0])

    def test_directory_is_removed_after_the_run(self):
        self.audit(Runner())
        self.assertEqual(os.listdir(self.work), [])

    def test_lockfile_changed_in_place(self):
        os.chmod(os.path.join(self.release, 'package-lock.json'), 0o644)
        write(self.release, 'package-lock.json', b'{"x":1}')
        runner = Runner()
        with self.assertRaisesRegex(Refused, f'^{self.release}/package-lock.json: does not match the release manifest$'):
            self.audit(runner)
        self.assertEqual((runner.calls, os.listdir(self.work)), ([], []))

    def test_group_writable_lockfile(self):
        os.chmod(os.path.join(self.release, 'package-lock.json'), 0o664)
        with self.assertRaisesRegex(Refused, 'package-lock.json: owner \\d+:\\d+ mode 0664 — not a file of an accepted release$'):
            self.audit(Runner())

    def test_releases_directory_writable_by_others(self):
        os.chmod(self.roots.releases, 0o777)
        with self.assertRaisesRegex(Refused, 'mode 0777 — not a directory only the release owner can change$'):
            self.audit(Runner())

    def test_release_of_another_owner(self):
        with self.assertRaisesRegex(Refused, 'not a directory only the release owner can change$'):
            ha.audit_release(self.release, self.work, (IDS[0] + 1, IDS[1]), runner=Runner(), euid=operator)

    def test_symlinked_lockfile(self):
        target = os.path.join(self.release, 'package-lock.json')
        os.rename(target, target + '.real')
        os.symlink(target + '.real', target)
        with self.assertRaisesRegex(Refused, 'package-lock.json: cannot open'):
            self.audit(Runner())

    @unittest.skipIf(os.geteuid() == 0, 'root reads a 0000 directory anyway')
    def test_does_not_need_the_receipt(self):
        # #817 review P1: the operator cannot read the root-only receipt; the audit must not try.
        os.chmod(self.roots.receipts, 0o000)
        try:
            self.assertEqual(self.audit(Runner()).verdict, Verdict('clean'))
        finally:
            os.chmod(self.roots.receipts, 0o755)

    def test_advisory_comes_from_the_json_not_the_exit_code(self):
        runner = Runner(b'{"vulnerabilities": {"a": {"severity": "high", "via": []}}}')
        self.assertEqual(self.audit(runner).verdict.kind, 'advisory')

    def test_registry_down_is_unrunnable(self):
        runner = Runner(b'{"message": "request failed", "error": {"summary": "", "detail": ""}}')
        self.assertEqual(self.audit(runner).verdict, Verdict('unrunnable', reason='reports an error, not an audit: request failed'))

    def test_empty_report_carries_the_stderr_tail(self):
        runner = Runner(b'', stderr=b"/usr/bin/env: 'node': No such file or directory\n")
        self.assertEqual(self.audit(runner).verdict.reason, "is empty — npm audit did not produce a report "
                                                            "(npm stderr: /usr/bin/env: 'node': No such file or directory)")

    def test_stderr_is_not_attached_to_a_verdict(self):
        self.assertEqual(self.audit(Runner(stderr=b'npm warn something')).verdict, Verdict('clean'))

    def test_timeout_is_unrunnable(self):
        runner = Runner(raises=subprocess.TimeoutExpired(['npm'], 120))
        self.assertEqual(self.audit(runner).verdict, Verdict('unrunnable', reason='never arrived — npm audit timed out after 120 s'))

    def test_missing_npm_is_unrunnable(self):
        runner = Runner(raises=FileNotFoundError(2, 'No such file or directory'))
        self.assertEqual(self.audit(runner).verdict,
                         Verdict('unrunnable', reason='never arrived — npm could not start (No such file or directory)'))

    def test_oversized_report_is_unrunnable(self):
        runner = Runner(b' ' * (ha.MAX_REPORT_BYTES + 1))
        self.assertEqual(self.audit(runner).verdict.reason, f'is over {ha.MAX_REPORT_BYTES} bytes — not a report we read')

    def test_refuses_to_run_as_root(self):
        runner = Runner()
        with self.assertRaisesRegex(Refused, '^the host audit must not run as root$'):
            ha.audit_release(self.release, self.work, IDS, runner=runner, euid=lambda: 0)
        self.assertEqual(runner.calls, [])


@unittest.skipUnless(os.geteuid() == 0, 'needs root to publish as root and audit as another user')
class RootPublisherOperatorAuditor(unittest.TestCase):
    """#817 review P1, end to end: published by uid 0 with a 0600 receipt, audited by uid 65534."""

    def test_operator_audit_reaches_npm(self):
        with tempfile.TemporaryDirectory() as base:
            os.chmod(base, 0o755)
            roots = pub.Roots(*(os.path.join(base, d) for d in ('releases', 'receipts', 'scratch')), (0, 0))
            for d in (roots.releases, roots.receipts, roots.scratch):
                os.makedirs(d)
            archive, _ = packed(os.path.join(base, 'src'))
            z = zip_up(archive, os.path.join(base, 'a.zip'))
            pub.publish(trusted_for(z), z, roots, lambda: 'now')
            code = (
                'import sys; sys.path.insert(0, %r); import host_audit as ha, tempfile;'
                'r = ha.audit_release(%r, tempfile.mkdtemp(), (0, 0), npm="/nonexistent/npm");'
                'print(r.verdict.kind, r.verdict.reason)'
            ) % (os.path.dirname(os.path.abspath(__file__)), os.path.join(roots.releases, SHA))

            def drop():
                os.setgid(65534)
                os.setuid(65534)
            r = subprocess.run([sys.executable, '-B', '-c', code], capture_output=True, text=True,
                               preexec_fn=drop, env={'PATH': '/usr/bin:/bin', 'TMPDIR': '/tmp'})
            self.assertEqual((r.returncode, r.stdout, r.stderr),
                             (0, 'unrunnable never arrived — npm could not start (No such file or directory)\n', ''))


if __name__ == '__main__':
    unittest.main()
