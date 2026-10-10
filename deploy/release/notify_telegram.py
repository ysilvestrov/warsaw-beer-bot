"""The tick's notify(text) -> bool: Telegram sendMessage straight to the Bot API, never through the bot.

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-b-core.md, "Рішення" п.6,
Task 3. Mirrors merge-deploy's _notify_default (deploy/autodeploy.sh): a deploy that took the bot down must still
be able to say so, so the message does not depend on the bot process. TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_ID
are read for every message through wbb-read-env as the bot user (the operator cannot read the bot's .env).

True only for an HTTP 200 whose JSON says "ok": true — accepted by the API, which is all it proves (not read).
Any other outcome is False with one line on stderr naming what failed; the token is in the request URL and
nowhere else: no line, exception or argv carries it.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounded  # noqa: E402
from activate import HostError  # noqa: E402
from github_trust import _NoRedirect  # noqa: E402
from host_adapter import read_env  # noqa: E402

API = 'https://api.telegram.org'
TIMEOUT_S = 10
MAX_RESPONSE_BYTES = 64 * 1024
# What BotFather issues: <bot id>:<secret>. Anything else never reaches the URL path.
TOKEN = re.compile(r'[0-9]+:[A-Za-z0-9_-]+')


def make_notify(run=bounded.run, urlopen=None, api=API, err=None):
    opener = urlopen or urllib.request.build_opener(_NoRedirect).open

    def warn(why):
        print(f'notify: {why}', file=err or sys.stderr)
        return False

    def notify(text):
        try:
            token = read_env(run, 'TELEGRAM_BOT_TOKEN')
            chat = read_env(run, 'ADMIN_TELEGRAM_ID')
        except HostError as e:
            return warn(str(e))
        if not token or not chat:
            return warn('no TELEGRAM_BOT_TOKEN or ADMIN_TELEGRAM_ID')
        if not TOKEN.fullmatch(token):
            return warn('TELEGRAM_BOT_TOKEN is not a bot token')
        data = urllib.parse.urlencode({'chat_id': chat, 'text': text}).encode()
        req = urllib.request.Request(f'{api}/bot{token}/sendMessage', data=data, method='POST',
                                     headers={'User-Agent': 'wbb-deploy'})
        try:
            with opener(req, timeout=TIMEOUT_S) as resp:
                status, body = resp.status, resp.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as e:
            e.close()
            return warn(f'Telegram answered HTTP {e.code}')
        except Exception as e:  # the URL holds the token: only the exception's type is printed
            return warn(f'Telegram unreachable: {type(e).__name__}')
        try:
            ok = status == 200 and len(body) <= MAX_RESPONSE_BYTES and json.loads(body).get('ok') is True
        except (ValueError, AttributeError):
            ok = False
        return True if ok else warn(f'Telegram did not accept the message (HTTP {status})')

    return notify
