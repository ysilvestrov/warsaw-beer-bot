"""deploy/wbb-tick-failed.sh: what wbb-tick.service's OnFailure says, when, and how often.

Plan: docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md, "Рішення" п.7, Task 3.
The script runs for real under bash with fake `sudo`, `wbb-read-env` and `curl` first on PATH and a temporary
XDG_STATE_HOME. The fake sudo accepts only the bot-user command merge-deploy's rule allows and runs the fake
wbb-read-env in place of the installed one; the fake curl records its argv and its stdin (the -K config).
"""
import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), 'wbb-tick-failed.sh')
TOKEN = '123456:SECRET-token_value'
CHAT = '4242'
NOTICE = 'wbb-autodeploy/tick-failed-notice'
# The text of a tick that did not start (exit 71), as the script words it.
T71 = ('🔥 wbb-tick failed and reported nothing itself: exit 71: did not start (the library is missing or failed to '
       'import). See: journalctl -u wbb-tick.service')

FAKE_SUDO = r'''#!/bin/sh
echo "$*" >> "$FAKE_LOG/sudo.argv"
[ "$1 $2 $3 $4 $5 $6" = '-n -u warsaw-beer-bot bash -lc "$0" "$@"' ] || { echo "fake sudo: no rule: $*" >&2; exit 1; }
[ "$7" = /usr/local/bin/wbb-read-env ] || { echo "fake sudo: not wbb-read-env: $7" >&2; exit 1; }
shift 7
exec wbb-read-env "$@"
'''
FAKE_READ_ENV = r'''#!/bin/sh
echo "$*" >> "$FAKE_LOG/read-env.argv"
[ -z "${FAKE_READ_ENV_FAIL:-}" ] || { echo "read-env.sh: cannot read $1" >&2; exit 1; }
[ "$1" = /etc/warsaw-beer-bot/.env ] || exit 9
case "$2" in
  TELEGRAM_BOT_TOKEN) echo "$FAKE_TOKEN" ;;
  ADMIN_TELEGRAM_ID) echo "$FAKE_CHAT" ;;
esac
'''
# The UTC day comes from the test, never the clock: a run across midnight must not change what a test sees.
FAKE_DATE = r'''#!/bin/sh
[ "$*" = "-u +%F" ] || { echo "fake date: unexpected $*" >&2; exit 9; }
echo "$FAKE_TODAY"
'''
FAKE_CURL = r'''#!/bin/sh
for a in "$@"; do printf '%s\n' "$a"; done >> "$FAKE_LOG/curl.argv"
echo --- >> "$FAKE_LOG/curl.argv"
cat >> "$FAKE_LOG/curl.stdin"
echo "curl: (22) https://api.telegram.org/bot$FAKE_TOKEN/sendMessage 400" >&2
exit "${FAKE_CURL_EXIT:-0}"
'''


class TickFailed(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.bin, self.log, self.state = (os.path.join(self.dir, d) for d in ('bin', 'log', 'state'))
        for d in (self.bin, self.log, self.state):
            os.makedirs(d)
        for name, body in (('sudo', FAKE_SUDO), ('wbb-read-env', FAKE_READ_ENV), ('curl', FAKE_CURL),
                           ('date', FAKE_DATE)):
            path = os.path.join(self.bin, name)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(body)
            os.chmod(path, 0o755)
        for name in ('sudo.argv', 'read-env.argv', 'curl.argv', 'curl.stdin'):
            open(os.path.join(self.log, name), 'w').close()

    def run_failed(self, result, status, **extra):
        env = {'PATH': f'{self.bin}:/usr/bin:/bin', 'HOME': os.path.join(self.dir, 'home'),
               'XDG_STATE_HOME': self.state, 'FAKE_LOG': self.log, 'FAKE_TOKEN': TOKEN, 'FAKE_CHAT': CHAT,
               'MONITOR_SERVICE_RESULT': result, 'MONITOR_EXIT_STATUS': status, 'MONITOR_EXIT_CODE': 'exited',
               'MONITOR_UNIT': 'wbb-tick.service', 'FAKE_TODAY': '2026-10-11', **extra}
        r = subprocess.run(['bash', SCRIPT], env=env, capture_output=True, text=True, timeout=30)
        return r.returncode, r.stdout, r.stderr

    def logged(self, name):
        with open(os.path.join(self.log, name), encoding='utf-8') as f:
            return f.read()

    def sent(self):
        """The `text=` of every message curl was asked to send."""
        argv = self.logged('curl.argv').splitlines()
        return [argv[i + 1][len('text='):] for i, a in enumerate(argv) if a == '--data-urlencode'
                and argv[i + 1].startswith('text=')]

    def test_a_timeout_is_reported(self):
        # What systemd hands over for a unit stopped at TimeoutStartSec: the signal's name, not a number.
        code, out, err = self.run_failed('timeout', 'TERM', MONITOR_EXIT_CODE='killed')
        text = ('🔥 wbb-tick failed and reported nothing itself: timeout (killed TERM). '
                'See: journalctl -u wbb-tick.service')
        self.assertEqual((code, out, err), (0, f'wbb-tick-failed: reported: {text}\n', ''))
        self.assertEqual(self.sent(), [text])
        self.assertEqual(self.logged('curl.stdin'), f'url = "https://api.telegram.org/bot{TOKEN}/sendMessage"\n')

    def test_the_request_goes_without_a_proxy_and_with_the_admin_s_chat(self):
        self.run_failed('signal', 'KILL', MONITOR_EXIT_CODE='killed')
        self.assertEqual(self.logged('curl.argv').splitlines()[:11], [
            '-K', '-', '-fsS', '--noproxy', '*', '--proto', '=https', '--max-time', '10', '-X', 'POST'])
        self.assertIn(f'chat_id={CHAT}', self.logged('curl.argv').splitlines())

    def test_a_signal_or_a_core_dump_is_reported(self):
        for result, status in (('signal', 'KILL'), ('core-dump', 'SEGV')):
            with self.subTest(result):
                shutil.rmtree(self.state)
                self.assertEqual(self.run_failed(result, status, MONITOR_EXIT_CODE='dumped')[0], 0)
        self.assertEqual(self.sent(), [
            '🔥 wbb-tick failed and reported nothing itself: signal (dumped KILL). See: journalctl -u wbb-tick.service',
            '🔥 wbb-tick failed and reported nothing itself: core-dump (dumped SEGV). '
            'See: journalctl -u wbb-tick.service'])

    def test_what_the_tick_reported_itself_is_not_repeated(self):
        for status in ('3', '4', '70', '0', '1', '2'):
            with self.subTest(status):
                self.assertEqual(self.run_failed('exit-code', status), (0, '', ''))
        self.assertEqual((self.logged('curl.argv'), self.logged('sudo.argv')), ('', ''))
        self.assertEqual(os.path.exists(os.path.join(self.state, NOTICE)), False)

    def test_exit_71_64_and_an_unknown_status_are_reported(self):
        for status in ('71', '64', '5'):
            with self.subTest(status):
                self.assertEqual(self.run_failed('exit-code', status)[0], 0)
        prefix = '🔥 wbb-tick failed and reported nothing itself: '
        suffix = '. See: journalctl -u wbb-tick.service'
        self.assertEqual(self.sent(), [
            prefix + 'exit 71: did not start (the library is missing or failed to import)' + suffix,
            prefix + 'exit 64: refused to run (usage, or started as root)' + suffix,
            prefix + 'exit 5, a status the tick does not define' + suffix])

    def test_the_same_text_is_sent_once_a_utc_day(self):
        first = self.run_failed('exit-code', '71')
        second = self.run_failed('exit-code', '71')
        self.assertEqual((first[0], second[0]), (0, 0))
        self.assertEqual(len(self.sent()), 1)
        self.assertEqual(second[1:], ('', f'wbb-tick-failed: already reported today: {T71}\n'))

    def test_another_text_the_same_day_is_sent(self):
        self.run_failed('exit-code', '71')
        self.run_failed('timeout', 'TERM')
        self.assertEqual(len(self.sent()), 2)

    def test_two_alternating_failures_are_each_sent_once_a_day(self):
        """e2e review N3: one line per text sent today, not just the last text."""
        for result, status in (('exit-code', '71'), ('timeout', 'TERM'), ('exit-code', '71'), ('timeout', 'TERM')):
            self.run_failed(result, status, MONITOR_EXIT_CODE='killed')
        prefix = '🔥 wbb-tick failed and reported nothing itself: '
        suffix = '. See: journalctl -u wbb-tick.service'
        self.assertEqual(self.sent(), [
            prefix + 'exit 71: did not start (the library is missing or failed to import)' + suffix,
            prefix + 'timeout (killed TERM)' + suffix])

    def test_yesterday_s_mark_does_not_hold_back_today_s_notice_and_is_dropped(self):
        self.run_failed('exit-code', '71', FAKE_TODAY='2026-10-10')
        self.run_failed('exit-code', '71', FAKE_TODAY='2026-10-11')
        self.assertEqual(len(self.sent()), 2)
        with open(os.path.join(self.state, NOTICE), encoding='utf-8') as f:
            self.assertEqual([line.split(' ')[0] for line in f.read().splitlines()], ['2026-10-11'])

    def test_a_manual_run_without_monitor_unit_sends_nothing(self):
        code, out, err = self.run_failed('exit-code', '71', MONITOR_UNIT='')
        self.assertEqual((code, out, err), (0, '', "wbb-tick-failed: no MONITOR_UNIT — not started by "
                                                   "wbb-tick.service's OnFailure=; nothing to report\n"))
        self.assertEqual((self.logged('sudo.argv'), self.logged('curl.argv')), ('', ''))

    def test_the_notice_falls_back_to_home_without_xdg_state_home(self):
        env_home = os.path.join(self.dir, 'home')
        self.run_failed('exit-code', '71', XDG_STATE_HOME='')
        with open(os.path.join(env_home, '.local/state', NOTICE), encoding='utf-8') as f:
            self.assertEqual(f.read(), f'2026-10-11 {hashlib.sha256(T71.encode()).hexdigest()}\n')

    def test_a_failed_read_env_is_a_failure_that_names_itself_and_leaks_nothing(self):
        code, out, err = self.run_failed('exit-code', '71', FAKE_READ_ENV_FAIL='1')
        self.assertEqual((code, out, err), (1, '', 'read-env.sh: cannot read /etc/warsaw-beer-bot/.env\n'
                                                   "wbb-tick-failed: cannot read the bot's .env through wbb-read-env; "
                                                   f'not reported: {T71}\n'))
        self.assertEqual((self.logged('curl.argv'), os.path.exists(os.path.join(self.state, NOTICE))), ('', False))

    def test_no_token_or_no_chat_is_a_failure(self):
        for missing in ('FAKE_TOKEN', 'FAKE_CHAT'):
            with self.subTest(missing):
                code, out, err = self.run_failed('exit-code', '71', **{missing: ''})
                self.assertEqual((code, out, err), (1, '', 'wbb-tick-failed: no TELEGRAM_BOT_TOKEN or ADMIN_TELEGRAM_ID; '
                                                           f'not reported: {T71}\n'))
        self.assertEqual(self.logged('curl.argv'), '')

    def test_a_token_that_is_not_a_bot_token_never_reaches_curl(self):
        code, _, err = self.run_failed('exit-code', '71', FAKE_TOKEN='1:x"\nurl = "https://evil')
        self.assertEqual((code, err), (1, f'wbb-tick-failed: TELEGRAM_BOT_TOKEN is not a bot token; not reported: {T71}\n'))
        self.assertEqual(self.logged('curl.stdin'), '')

    def test_telegram_refusing_is_a_failure_tried_again_next_time(self):
        code, out, err = self.run_failed('exit-code', '71', FAKE_CURL_EXIT='22')
        self.assertEqual((code, out, err), (1, '', f'wbb-tick-failed: Telegram did not accept the notice (curl exit 22): '
                                                   f'{T71}\n'))
        self.assertEqual(os.path.exists(os.path.join(self.state, NOTICE)), False)
        self.run_failed('exit-code', '71')
        self.assertEqual(len(self.sent()), 2)

    def test_the_token_is_in_no_argv_and_no_output(self):
        outputs = [self.run_failed('exit-code', '71'), self.run_failed('exit-code', '64', FAKE_CURL_EXIT='22'),
                   self.run_failed('timeout', 'TERM', FAKE_READ_ENV_FAIL='1')]
        seen = ''.join(out + err for _, out, err in outputs)
        seen += self.logged('curl.argv') + self.logged('sudo.argv') + self.logged('read-env.argv')
        self.assertEqual(TOKEN in seen, False)
        self.assertEqual(TOKEN in self.logged('curl.stdin'), True)

    def test_bash_parses_it(self):
        r = subprocess.run(['bash', '-n', SCRIPT], capture_output=True, text=True, timeout=30)
        self.assertEqual((r.returncode, r.stderr), (0, ''))


if __name__ == '__main__':
    unittest.main()
