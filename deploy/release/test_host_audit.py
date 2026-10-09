import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import host_audit as ha  # noqa: E402
from audit_verdict import Verdict  # noqa: E402
from release_testkit import write  # noqa: E402
from safe_tar import Refused  # noqa: E402

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


class Audit(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.release = os.path.join(self._tmp.name, 'release')
        self.work = os.path.join(self._tmp.name, 'work')
        os.makedirs(self.work)
        write(self.release, 'package.json', b'{"name":"x"}')
        write(self.release, 'package-lock.json', b'{"lockfileVersion":3}')
        write(self.release, '.npmrc', b'registry=https://evil.invalid/\n')

    def tearDown(self):
        self._tmp.cleanup()

    def audit(self, runner, **kw):
        return ha.audit_release(self.release, self.work, runner=runner, euid=operator, **kw)

    def test_exact_command_environment_and_directory(self):
        runner = Runner()
        self.assertEqual(self.audit(runner), Verdict('clean'))
        call = runner.calls[0]
        base = os.path.dirname(call['cwd'])
        self.assertEqual(call['argv'], [
            '/usr/bin/npm', 'audit', '--omit=dev', '--package-lock-only', '--json',
            '--userconfig', os.path.join(base, 'user.npmrc'), '--globalconfig', os.path.join(base, 'global.npmrc'),
            '--registry', 'https://registry.npmjs.org/', '--ignore-scripts'])
        self.assertEqual(call['env'], {'PATH': '/usr/bin:/bin', 'HOME': os.path.join(base, 'home')})
        self.assertEqual(call['timeout'], 120)
        # Only the two files npm needs: the release's .npmrc never reaches the audit.
        self.assertEqual(call['project'], ['package-lock.json', 'package.json'])
        self.assertEqual(call['base'], ['global.npmrc', 'home', 'project', 'user.npmrc'])
        self.assertEqual(call['configs'], [0, 0])

    def test_directory_is_removed_after_the_run(self):
        self.audit(Runner())
        self.assertEqual(os.listdir(self.work), [])

    def test_directory_is_removed_after_a_refusal(self):
        os.remove(os.path.join(self.release, 'package-lock.json'))
        os.symlink('/etc/passwd', os.path.join(self.release, 'package-lock.json'))
        with self.assertRaisesRegex(Refused, 'package-lock.json: cannot open'):
            self.audit(Runner())
        self.assertEqual(os.listdir(self.work), [])

    def test_oversized_lockfile(self):
        write(self.release, 'package-lock.json', b'x' * (ha.MAX_FILE_BYTES + 1))
        with self.assertRaisesRegex(Refused, f'package-lock.json: {ha.MAX_FILE_BYTES + 1} bytes, over {ha.MAX_FILE_BYTES}$'):
            self.audit(Runner())

    def test_advisory_comes_from_the_json_not_the_exit_code(self):
        runner = Runner(b'{"vulnerabilities": {"a": {"severity": "high", "via": []}}}')
        self.assertEqual(self.audit(runner).kind, 'advisory')

    def test_registry_down_is_unrunnable(self):
        runner = Runner(b'{"message": "request failed", "error": {"summary": "", "detail": ""}}')
        self.assertEqual(self.audit(runner), Verdict('unrunnable', reason='reports an error, not an audit: request failed'))

    def test_empty_report_carries_the_stderr_tail(self):
        runner = Runner(b'', stderr=b'/usr/bin/env: \'node\': No such file or directory\n')
        self.assertEqual(self.audit(runner).reason, "is empty — npm audit did not produce a report "
                                                    "(npm stderr: /usr/bin/env: 'node': No such file or directory)")

    def test_stderr_is_not_attached_to_a_verdict(self):
        self.assertEqual(self.audit(Runner(stderr=b'npm warn something')), Verdict('clean'))

    def test_timeout_is_unrunnable(self):
        runner = Runner(raises=subprocess.TimeoutExpired(['npm'], 120))
        self.assertEqual(self.audit(runner), Verdict('unrunnable', reason='never arrived — npm audit timed out after 120 s'))

    def test_missing_npm_is_unrunnable(self):
        runner = Runner(raises=FileNotFoundError(2, 'No such file or directory'))
        self.assertEqual(self.audit(runner), Verdict('unrunnable', reason='never arrived — npm could not start (No such file or directory)'))

    def test_oversized_report_is_unrunnable(self):
        runner = Runner(b' ' * (ha.MAX_REPORT_BYTES + 1))
        self.assertEqual(self.audit(runner).reason, f'is over {ha.MAX_REPORT_BYTES} bytes — not a report we read')

    def test_refuses_to_run_as_root(self):
        runner = Runner()
        with self.assertRaisesRegex(Refused, '^the host audit must not run as root$'):
            ha.audit_release(self.release, self.work, runner=runner, euid=lambda: 0)
        self.assertEqual(runner.calls, [])


if __name__ == '__main__':
    unittest.main()
