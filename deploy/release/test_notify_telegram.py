"""notify_telegram.make_notify against a local Bot API on 127.0.0.1 and a scripted wbb-read-env.

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-b-core.md, Task 3.
"""
import io
import os
import sys
import unittest
import urllib.parse
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notify_telegram as nt  # noqa: E402
from fake_run import FakeRun, Server, done  # noqa: E402

TOKEN = '123456789:AAF-secret_TOKEN'
CHAT = '42'
AS_BOT = ['sudo', '-n', '-u', 'warsaw-beer-bot', 'bash', '-lc', '"$0" "$@"', '/usr/local/bin/wbb-read-env',
          '/etc/warsaw-beer-bot/.env']
READ_TOKEN = tuple(AS_BOT + ['TELEGRAM_BOT_TOKEN'])
READ_CHAT = tuple(AS_BOT + ['ADMIN_TELEGRAM_ID'])
TEXT = '🔥 wbb-deploy ROLLED BACK ccccccc → bbbbbbb & more'


def env_run(token=done(0, f'{TOKEN}\n'.encode()), chat=done(0, f'{CHAT}\n'.encode())):
    return FakeRun({READ_TOKEN: token, READ_CHAT: chat})


class Notify(unittest.TestCase):
    def send(self, answers, run=None):
        err = io.StringIO()
        with Server(answers) as s:
            got = nt.make_notify(run=run or env_run(), api=s.url, err=err)(TEXT)
        self.assertNotIn(TOKEN, err.getvalue())
        self.assertNotIn(TOKEN.split(':')[1], err.getvalue())
        return got, err.getvalue(), s.requests

    def test_accepted_is_true(self):
        got, err, requests = self.send([(200, b'{"ok":true,"result":{"message_id":7}}', 0)])
        self.assertEqual((got, err), (True, ''))
        self.assertEqual(len(requests), 1)
        method, path, body = requests[0]
        self.assertEqual((method, path), ('POST', f'/bot{TOKEN}/sendMessage'))
        self.assertEqual(urllib.parse.parse_qs(body.decode()), {'chat_id': [CHAT], 'text': [TEXT]})

    def test_ok_false_is_false(self):
        got, err, _ = self.send([(200, b'{"ok":false,"description":"Bad Request: chat not found"}', 0)])
        self.assertEqual((got, err), (False, 'notify: Telegram did not accept the message (HTTP 200)\n'))

    def test_a_body_that_is_not_an_object_is_false(self):
        for raw in (b'not json', b'[true]'):
            with self.subTest(raw):
                got, err, _ = self.send([(200, raw, 0)])
                self.assertEqual((got, err), (False, 'notify: Telegram did not accept the message (HTTP 200)\n'))

    def test_a_2xx_other_than_200_is_false(self):
        got, err, _ = self.send([(202, b'{"ok":true}', 0)])
        self.assertEqual((got, err), (False, 'notify: Telegram did not accept the message (HTTP 202)\n'))

    def test_http_500_is_false(self):
        got, err, _ = self.send([(500, b'{"ok":false}', 0)])
        self.assertEqual((got, err), (False, 'notify: Telegram answered HTTP 500\n'))

    def test_a_timeout_is_false(self):
        with mock.patch.object(nt, 'TIMEOUT_S', 0.2):
            got, err, _ = self.send([(200, b'{"ok":true}', 1)])
        self.assertIs(got, False)
        self.assertRegex(err, r'^notify: Telegram unreachable: (TimeoutError|URLError)\n$')

    def test_nobody_listening_is_false(self):
        with Server([]) as s:
            closed = s.url
        err = io.StringIO()
        self.assertIs(nt.make_notify(run=env_run(), api=closed, err=err)(TEXT), False)
        self.assertEqual(err.getvalue(), 'notify: Telegram unreachable: URLError\n')

    def test_no_token_or_chat_sends_nothing(self):
        for run, why in ((env_run(token=done(0, b'\n')), 'no TELEGRAM_BOT_TOKEN or ADMIN_TELEGRAM_ID'),
                         (env_run(chat=done(0, b'')), 'no TELEGRAM_BOT_TOKEN or ADMIN_TELEGRAM_ID'),
                         (env_run(token=done(1, b'', b'sudo: a password is required\n')),
                          'read-env TELEGRAM_BOT_TOKEN: exit 1'),
                         (env_run(token=done(0, b'123:abc/../../x\n')), 'TELEGRAM_BOT_TOKEN is not a bot token')):
            with self.subTest(why):
                got, err, requests = self.send([], run=run)
                self.assertEqual((got, err, requests), (False, f'notify: {why}\n', []))

    def test_the_post_waits_ten_seconds_and_follows_no_redirect(self):
        seen = []

        def urlopen(req, timeout):
            seen.append((req.get_method(), req.full_url, timeout))
            raise OSError('down')

        err = io.StringIO()
        self.assertIs(nt.make_notify(run=env_run(), urlopen=urlopen, err=err)(TEXT), False)
        self.assertEqual(seen, [('POST', f'https://api.telegram.org/bot{TOKEN}/sendMessage', 10)])
        self.assertEqual(err.getvalue(), 'notify: Telegram unreachable: OSError\n')

    def test_a_redirect_is_not_followed(self):
        got, err, requests = self.send([(302, b'', 0, {'Location': '/elsewhere'}), (200, b'{"ok":true}', 0)])
        self.assertEqual((got, err, len(requests)), (False, 'notify: Telegram answered HTTP 302\n', 1))

    def test_the_env_is_read_for_every_message(self):
        run = FakeRun({READ_TOKEN: [done(0, b'\n'), done(0, b'\n')], READ_CHAT: [done(0, b'1\n'), done(0, b'1\n')]})
        notify = nt.make_notify(run=run, api='http://127.0.0.1:9', err=io.StringIO())
        notify('a'), notify('b')
        self.assertEqual(run.calls, [(list(READ_TOKEN), 10), (list(READ_CHAT), 10)] * 2)


if __name__ == '__main__':
    unittest.main()
