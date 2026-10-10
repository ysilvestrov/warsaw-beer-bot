"""host_adapter.RealHost over a scripted `run` and a local /health: argv, exit codes, /health bodies.

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-b-core.md, Task 1.
Nothing here runs sudo, systemctl or touches the network beyond 127.0.0.1.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import host_adapter as ha  # noqa: E402
import publish as pub  # noqa: E402
from activate import Health, HostError  # noqa: E402
from fake_run import FakeRun, Server, done  # noqa: E402
from safe_tar import Refused  # noqa: E402

SHA = 'c' * 40
OTHER = 'd' * 40
TREE = '1' * 64
BOOT = '0f0e0d0c-0b0a-4908-8706-050403020100'
AS_BOT = ['sudo', '-n', '-u', 'warsaw-beer-bot', 'bash', '-lc', '"$0" "$@"']
PORT_ARGV = AS_BOT + ['/usr/local/bin/wbb-read-env', '/etc/warsaw-beer-bot/.env', 'API_PORT']
DBSNAP = AS_BOT + ['/usr/bin/python3', '-I', '-B', '/usr/local/lib/wbb-release/dbsnap.py']
DB = '/var/lib/warsaw-beer-bot/bot.db'
PRE = '/var/lib/warsaw-beer-bot/deploy-snapshots/20261010T080000Z-ccccccc-pre.db'
POST = '/var/lib/warsaw-beer-bot/deploy-snapshots/20261010T080000Z-ccccccc-rollback-post'
SUDO_FAILED = done(1, b'', b'sudo: a password is required\n')


def host(answers=None, **kw):
    run = FakeRun(answers)
    return ha.RealHost(run=run, **kw), run


class Units(unittest.TestCase):
    def test_states_are_read_without_sudo(self):
        h, run = host({
            ('systemctl', 'show', '-p', 'ActiveState', '--value', 'warsaw-beer-bot'): done(0, b'active\n'),
            ('systemctl', 'show', '-p', 'ActiveState', '--value', 'litestream'): done(0, b'inactive\n'),
        })
        self.assertEqual((h.bot_state(), h.litestream_state()), ('active', 'inactive'))
        self.assertEqual([t for _, t in run.calls], [5, 5])

    def test_a_state_systemd_did_not_give_is_a_host_error(self):
        argv = ('systemctl', 'show', '-p', 'ActiveState', '--value', 'warsaw-beer-bot')
        for answer, why in ((done(1, b'', b'Failed to connect to bus\n'), 'exit 1: Failed to connect to bus'),
                            (done(0, b''), "''"), (done(0, b'Active State\n'), "'Active State'")):
            with self.subTest(why):
                h, _ = host({argv: answer})
                with self.assertRaisesRegex(HostError, f'ActiveState warsaw-beer-bot: {why}'):
                    h.bot_state()

    def test_start_and_stop_go_through_the_existing_sudo_rule(self):
        verbs = [('stop_bot', 'stop', 'warsaw-beer-bot'), ('start_bot', 'start', 'warsaw-beer-bot'),
                 ('stop_litestream', 'stop', 'litestream'), ('start_litestream', 'start', 'litestream')]
        for method, verb, unit in verbs:
            with self.subTest(method):
                h, run = host({('sudo', '-n', 'systemctl', verb, unit): done(0)})
                self.assertIsNone(getattr(h, method)())
                self.assertEqual(run.calls, [(['sudo', '-n', 'systemctl', verb, unit], 180)])

    def test_sudo_refusing_is_a_host_error_with_its_reason(self):
        h, _ = host({('sudo', '-n', 'systemctl', 'stop', 'warsaw-beer-bot'): SUDO_FAILED})
        with self.assertRaisesRegex(HostError, '^systemctl stop warsaw-beer-bot: exit 1: sudo: a password is required$'):
            h.stop_bot()

    def test_a_command_that_could_not_run_is_a_host_error(self):
        for exc, name in ((subprocess.TimeoutExpired(['sudo'], 180), 'TimeoutExpired'),
                          (FileNotFoundError(2, 'No such file'), 'FileNotFoundError')):
            with self.subTest(name):
                h, _ = host({('sudo', '-n', 'systemctl', 'start', 'litestream'): exc})
                with self.assertRaisesRegex(HostError, f'^sudo: {name}$'):
                    h.start_litestream()

    def test_nrestarts_is_a_count_or_none(self):
        argv = ('systemctl', 'show', '-p', 'NRestarts', '--value', 'warsaw-beer-bot')
        for out, want in ((b'0\n', 0), (b'3\n', 3), (b'\n', None), (b'[not set]\n', None), (b'-1\n', None),
                          ('٣'.encode(), None)):
            with self.subTest(out):
                h, run = host({argv: done(0, out)})
                self.assertEqual(h.nrestarts(), want)
                self.assertEqual(run.calls, [(list(argv), 5)])

    def test_nrestarts_that_systemd_did_not_answer_is_a_host_error(self):
        h, _ = host({('systemctl', 'show', '-p', 'NRestarts', '--value', 'warsaw-beer-bot'): done(1, b'', b'no bus')})
        with self.assertRaisesRegex(HostError, 'NRestarts warsaw-beer-bot: exit 1: no bus'):
            h.nrestarts()


def helper(verb, sha=SHA):
    return ('sudo', '-n', '/usr/local/libexec/wbb-release', verb, '--sha', sha)


class RootHelper(unittest.TestCase):
    def test_verify_returns_the_receipts_tree(self):
        h, run = host({helper('verify'): done(0, f'VERIFIED {SHA}: tree {TREE} (run 7 attempt 1)\n'.encode())})
        self.assertEqual(h.verify(SHA), TREE)
        self.assertEqual(run.calls, [(list(helper('verify')), 300)])

    def test_switch_returns_the_tree_for_switched_and_current(self):
        for word in ('SWITCHED', 'CURRENT'):
            with self.subTest(word):
                h, run = host({helper('switch'): done(0, f'{word} {SHA} tree {TREE}\n'.encode())})
                self.assertEqual(h.switch(SHA), TREE)
                self.assertEqual(run.argvs(), [list(helper('switch'))])

    def test_refused_is_refused(self):
        for verb in ('verify', 'switch'):
            with self.subTest(verb):
                h, _ = host({helper(verb): done(2, b'', f'REFUSED: {SHA}: no receipt\n'.encode())})
                with self.assertRaisesRegex(Refused, f'^{verb} ccccccc: REFUSED: {SHA}: no receipt$'):
                    getattr(h, verb)(SHA)

    def test_exit_2_without_our_refused_line_is_a_host_error(self):
        # Б-ядро review: Python exits 2 when it cannot open the script (an install half done); a reinstall fixes
        # that, so it must never reach the engine as a Refused (which it turns into recovery-failed).
        for verb in ('verify', 'switch'):
            with self.subTest(verb):
                h, _ = host({helper(verb): done(2, b'', b"python3: can't open file '/usr/local/lib/wbb-release/x'\n")})
                with self.assertRaises(HostError):
                    getattr(h, verb)(SHA)

    def test_exit_1_without_a_verdict_line_is_sudo_failing_not_a_verdict(self):
        for verb in ('verify', 'switch'):
            with self.subTest(verb):
                h, _ = host({helper(verb): SUDO_FAILED})
                with self.assertRaisesRegex(HostError, f'^wbb-release {verb}: exit 1: sudo: a password is required$'):
                    getattr(h, verb)(SHA)

    def test_exit_1_is_never_a_switch_even_with_its_line(self):
        h, _ = host({helper('switch'): done(1, f'SWITCHED {SHA} tree {TREE}\n'.encode())})
        with self.assertRaisesRegex(HostError, '^wbb-release switch: exit 1: '):
            h.switch(SHA)

    def test_other_exit_codes_are_host_errors(self):
        for code in (64, 70, 75, 126):
            with self.subTest(code):
                h, _ = host({helper('verify'): done(code, b'', b'Traceback\n')})
                with self.assertRaisesRegex(HostError, f'^wbb-release verify: exit {code}: Traceback$'):
                    h.verify(SHA)

    def test_exit_0_without_the_line_for_this_sha_is_a_host_error(self):
        for out in (b'', f'VERIFIED {OTHER}: tree {TREE}\n'.encode(), f'VERIFIED {SHA}: tree {TREE[:-1]}\n'.encode(),
                    f'SWITCHED {SHA} tree {TREE}\n'.encode()):
            with self.subTest(out):
                h, _ = host({helper('verify'): done(0, out)})
                with self.assertRaisesRegex(HostError, '^wbb-release verify ccccccc: no verdict line: '):
                    h.verify(SHA)

    def test_a_sha_that_is_not_one_never_reaches_argv(self):
        for bad in ('C' * 40, 'c' * 39, '--sha', f'{SHA}\n'):
            with self.subTest(bad):
                h, run = host({})
                with self.assertRaisesRegex(Refused, 'not a full lowercase SHA'):
                    h.switch(bad)
                self.assertEqual(run.calls, [])


class Database(unittest.TestCase):
    def test_post_runs_dbsnap_as_the_bot_user(self):
        argv = tuple(DBSNAP + ['post', DB, POST])
        h, run = host({argv: done(0, f'POST {POST}\n'.encode())})
        self.assertIsNone(h.post(POST))
        self.assertEqual(run.calls, [(list(argv), 600)])

    def test_restore_runs_dbsnap_as_the_bot_user(self):
        argv = tuple(DBSNAP + ['restore', PRE, DB, POST])
        for word in ('RESTORED', 'ALREADY'):
            with self.subTest(word):
                h, run = host({argv: done(0, f'{word} {DB}\n'.encode())})
                self.assertIsNone(h.restore(PRE, POST))
                self.assertEqual(run.calls, [(list(argv), 600)])

    def test_refused_by_dbsnap_is_refused(self):
        h, _ = host({tuple(DBSNAP + ['restore', PRE, DB, POST]): done(2, b'', b'REFUSED: no complete post\n')})
        with self.assertRaisesRegex(Refused, '^dbsnap restore: REFUSED: no complete post$'):
            h.restore(PRE, POST)

    def test_dbsnap_that_python_cannot_open_is_a_host_error(self):
        h, _ = host({tuple(DBSNAP + ['restore', PRE, DB, POST]): done(2, b'', b"python3: can't open file\n")})
        with self.assertRaises(HostError):
            h.restore(PRE, POST)

    def test_sudo_failing_a_retryable_error_or_odd_output_is_a_host_error(self):
        argv = tuple(DBSNAP + ['post', DB, POST])
        for answer, why in ((SUDO_FAILED, 'exit 1: sudo: a password is required'),
                            (done(75, b'', b'TRANSIENT: No space left\n'), 'exit 75: TRANSIENT: No space left'),
                            (done(0, b'POST /elsewhere\n'), "unexpected output 'POST /elsewhere'")):
            with self.subTest(why):
                h, _ = host({argv: answer})
                with self.assertRaisesRegex(HostError, f'^dbsnap post: {why}$'):
                    h.post(POST)

    def test_a_relative_path_never_reaches_argv(self):
        h, run = host({})
        with self.assertRaisesRegex(Refused, 'not an absolute path'):
            h.post('rollback-post')
        self.assertEqual(run.calls, [])


def body(obj):
    return json.dumps(obj).encode()


class HealthProbe(unittest.TestCase):
    def probe(self, answers):
        with Server(answers) as s:
            h, _ = host({tuple(PORT_ARGV): done(0, f'{s.port}\n'.encode())})
            return h.health()

    def test_ok_with_the_release_it_read_at_startup(self):
        with Server([(200, body({'ok': True, 'releaseSha': SHA}), 0)]) as s:
            h, _ = host({tuple(PORT_ARGV): done(0, f'{s.port}\n'.encode())})
            self.assertEqual(h.health(), Health(True, SHA))
        self.assertEqual(s.requests, [('GET', '/health', b'')])

    def test_a_redirect_is_not_followed(self):
        # merge-deploy's curl did not follow one either (Б-ядро review).
        # Followed, the relative Location would land on a healthy answer from the same server.
        with self.assertRaises(HostError):
            self.probe([(302, b'', 0, {'Location': '/health'}), (200, body({'ok': True, 'releaseSha': SHA}), 0)])

    def test_a_proxy_in_the_environment_is_not_used(self):
        # Б-ядро review: urllib's default opener sent 127.0.0.1 through http_proxy, failing every probe.
        with Server([(200, body({'ok': True, 'releaseSha': SHA}), 0)]) as s, \
                mock.patch.dict(os.environ, {'http_proxy': 'http://127.0.0.1:9', 'no_proxy': ''}), \
                mock.patch.object(urllib.request, '_opener', None):
            h, _ = host({tuple(PORT_ARGV): done(0, f'{s.port}\n'.encode())})
            self.assertEqual(h.health(), Health(True, SHA))

    def test_todays_app_has_no_release_sha(self):
        self.assertEqual(self.probe([(200, b'{"ok":true}', 0)]), Health(True, None))

    def test_not_ok_keeps_the_release_it_names(self):
        self.assertEqual(self.probe([(200, body({'ok': False, 'releaseSha': SHA}), 0)]), Health(False, SHA))

    def test_only_ok_true_is_ok(self):
        for ok in ('true', 1, None):
            with self.subTest(ok):
                self.assertEqual(self.probe([(200, body({'ok': ok}), 0)]), Health(False, None))

    def test_a_release_sha_that_is_not_a_full_sha_is_none(self):
        for rs in ('abc', SHA.upper(), SHA + 'c', 42, None, SHA[:-1] + '\n'):
            with self.subTest(rs):
                self.assertEqual(self.probe([(200, body({'ok': True, 'releaseSha': rs}), 0)]), Health(True, None))

    def test_a_body_that_is_not_a_json_object_is_not_healthy(self):
        for raw in (b'OK', b'[true]', b''):
            with self.subTest(raw):
                self.assertEqual(self.probe([(200, raw, 0)]), Health(False, None))

    def test_no_2xx_answer_is_a_host_error(self):
        with self.assertRaisesRegex(HostError, '^/health: HTTP 500$'):
            self.probe([(500, b'{"ok":true}', 0)])

    def test_an_oversized_body_is_a_host_error(self):
        with self.assertRaisesRegex(HostError, '^/health: over 65536 bytes$'):
            self.probe([(200, b'{"ok":true,"pad":"' + b'x' * (64 * 1024) + b'"}', 0)])

    def test_a_body_of_exactly_64_kib_is_read(self):
        raw = b'{"ok":true,"pad":"'
        raw += b'x' * (64 * 1024 - len(raw) - 2) + b'"}'
        self.assertEqual(len(raw), 64 * 1024)
        self.assertEqual(self.probe([(200, raw, 0)]), Health(True, None))

    def test_a_timeout_is_a_host_error(self):
        with mock.patch.object(ha, 'HEALTH_TIMEOUT_S', 0.2), \
                self.assertRaisesRegex(HostError, r'^/health: (TimeoutError|URLError)$'):
            self.probe([(200, b'{"ok":true}', 1)])

    def test_nobody_listening_is_a_host_error(self):
        with Server([]) as s:
            closed = s.port
        h, _ = host({tuple(PORT_ARGV): done(0, f'{closed}\n'.encode())})
        with self.assertRaisesRegex(HostError, r'^/health: (URLError|ConnectionRefusedError)$'):
            h.health()

    def test_the_probe_is_three_seconds_to_the_port_read_once(self):
        seen = []

        def urlopen(url, timeout):
            seen.append((url, timeout))
            raise OSError('down')

        h, run = host({tuple(PORT_ARGV): done(0, b'8080\n')}, urlopen=urlopen)
        for _ in range(2):
            with self.assertRaisesRegex(HostError, '^/health: OSError$'):
                h.health()
        self.assertEqual(seen, [('http://127.0.0.1:8080/health', 3)] * 2)
        self.assertEqual(run.calls, [(PORT_ARGV, 10)])

    def test_an_empty_api_port_is_the_apps_default(self):
        seen = []

        def urlopen(url, timeout):
            seen.append(url)
            raise ConnectionRefusedError(111, 'refused')

        h, _ = host({tuple(PORT_ARGV): done(0, b'\n')}, urlopen=urlopen)
        with self.assertRaisesRegex(HostError, '^/health: ConnectionRefusedError$'):
            h.health()
        self.assertEqual(seen, ['http://127.0.0.1:3000/health'])

    def test_an_api_port_that_is_not_a_port_is_a_host_error(self):
        for out, why in ((b'abc\n', "'abc'"), (b'0\n', "'0'"), (b'65536\n', "'65536'"), (b'80 81\n', "'80 81'")):
            with self.subTest(out):
                h, _ = host({tuple(PORT_ARGV): done(0, out)})
                with self.assertRaisesRegex(HostError, f'^API_PORT is not a port: {why}$'):
                    h.health()

    def test_an_api_port_that_cannot_be_read_is_a_host_error(self):
        h, _ = host({tuple(PORT_ARGV): SUDO_FAILED})
        with self.assertRaisesRegex(HostError, '^read-env API_PORT: exit 1$'):
            h.health()


class Pointer(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp()
        self.addCleanup(lambda: subprocess.run(['rm', '-rf', self.base], check=True))
        self.roots = pub.Roots(os.path.join(self.base, 'releases'), os.path.join(self.base, 'receipts'),
                               os.path.join(self.base, 'staging'), (os.getuid(), os.getgid()))
        os.mkdir(self.roots.releases)
        self.cur = os.path.join(self.base, 'current')

    def test_current_reads_the_symlink(self):
        os.symlink(f'releases/{SHA}', self.cur)
        self.assertEqual(ha.RealHost(run=FakeRun(), roots=self.roots).current(), SHA)

    def test_no_current_is_none(self):
        self.assertIsNone(ha.RealHost(run=FakeRun(), roots=self.roots).current())

    def test_a_pointer_publish_does_not_understand_is_refused(self):
        os.mkdir(self.cur)
        with self.assertRaisesRegex(Refused, 'not a symlink'):
            ha.RealHost(run=FakeRun(), roots=self.roots).current()

    def test_a_pointer_that_cannot_be_read_is_a_host_error(self):
        roots = pub.Roots(os.path.join(self.base, 'file', 'releases'), '', '', (0, 0))
        with open(os.path.join(self.base, 'file'), 'w'):
            pass
        with self.assertRaisesRegex(HostError, '^current: NotADirectoryError: Not a directory$'):
            ha.RealHost(run=FakeRun(), roots=roots).current()


class BootAndTime(unittest.TestCase):
    def boot(self, content):
        fd, path = tempfile.mkstemp()
        self.addCleanup(os.unlink, path)
        with os.fdopen(fd, 'w') as f:
            f.write(content)
        return ha.RealHost(run=FakeRun(), boot_id_file=path)

    def test_boot_id(self):
        self.assertEqual(self.boot(BOOT + '\n').boot_id(), BOOT)

    def test_a_boot_id_that_is_not_one_is_a_host_error(self):
        with self.assertRaisesRegex(HostError, "^boot id: 'not-a-boot'$"):
            self.boot('not-a-boot\n').boot_id()

    def test_no_boot_id_file_is_a_host_error(self):
        with self.assertRaisesRegex(HostError, '^boot id: FileNotFoundError$'):
            ha.RealHost(run=FakeRun(), boot_id_file='/nonexistent/boot_id').boot_id()

    def test_now_and_sleep_are_the_injected_ones(self):
        slept = []
        h = ha.RealHost(run=FakeRun(), clock=iter([1_760_000_000.5]).__next__, sleep=slept.append)
        self.assertEqual(h.now(), 1_760_000_000.5)
        h.sleep(2)
        self.assertEqual(slept, [2])


if __name__ == '__main__':
    unittest.main()
