"""The activation engine's real Host: systemctl, the root helper through sudo, /health, dbsnap as the bot user.

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-b-core.md, "Рішення" п.2-6,
Task 1. The protocol is activate.py's (its docstring); the commands mirror merge-deploy's (deploy/autodeploy.sh):

  bot_state / litestream_state  systemctl show -p ActiveState --value <unit>              (operator)
  stop_* / start_*              sudo -n systemctl stop|start <unit>                        (root, existing rule)
  nrestarts                     systemctl show -p NRestarts --value warsaw-beer-bot        (operator)
  verify / switch               sudo -n /usr/local/libexec/wbb-release verify|switch --sha  (root helper)
  post / restore                dbsnap.py as warsaw-beer-bot through `bash -lc '"$0" "$@"'` (existing rule)
  health                        GET http://127.0.0.1:<API_PORT>/health, 3 s, at most 64 KiB
  current                       publish.current_sha over the production roots (a symlink read, no root)
  boot_id                       /proc/sys/kernel/random/boot_id

Exit codes ("Рішення" п.2): 0 is done; 2 is the helper's REFUSED -> safe_tar.Refused; anything else — 1
included — is HostError. Neither verify nor switch nor dbsnap ever exits 1, and sudo exits 1 for its own
failures ("a password is required", a missing rule): exit 1 is never read as a verdict here.
"""
import http.client
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounded  # noqa: E402
import installed as ins  # noqa: E402
import publish as pub  # noqa: E402
from activate import Health, HostError  # noqa: E402
from deploy_state import _BOOT_ID  # noqa: E402
from github_trust import SHA, _NoRedirect  # noqa: E402
from safe_tar import Refused  # noqa: E402
from wbb_release import PRODUCTION_ROOTS  # noqa: E402

HEALTH_TIMEOUT_S = 3
HEALTH_MAX_BYTES = 64 * 1024
SHOW_TIMEOUT_S = 5
READ_ENV_TIMEOUT_S = 10
# systemctl stop waits for the unit's TimeoutStopSec (90 s by default).
SERVICE_TIMEOUT_S = 180
# Re-hashing a release tree and copying the database are bounded by the payload, not by a protocol.
VERIFY_TIMEOUT_S = 300
DB_TIMEOUT_S = 600
DEFAULT_API_PORT = '3000'
PYTHON = '/usr/bin/python3'
VERIFIED = re.compile(r'VERIFIED ([0-9a-f]{40}): tree ([0-9a-f]{64})(?: .*)?')
SWITCHED = re.compile(r'(?:SWITCHED|CURRENT) ([0-9a-f]{40}) tree ([0-9a-f]{64})')
UNIT_STATE = re.compile(r'[a-z][a-z-]*')
REASON_MAX = 300


def as_bot(argv):
    """argv run as the bot user through merge-deploy's rule `(warsaw-beer-bot) NOPASSWD: /usr/bin/bash -lc *`.

    The command string is fixed; argv goes positionally ($0, $@), so nothing in it is parsed by a shell.
    """
    return ['sudo', '-n', '-u', ins.BOT_USER, 'bash', '-lc', '"$0" "$@"', *argv]


def dbsnap_argv(*args):
    return as_bot([PYTHON, '-I', '-B', os.path.join(ins.LIB_DIR, 'dbsnap.py'), *args])


def _text(b):
    return b.decode('utf-8', 'replace') if isinstance(b, bytes) else (b or '')


def refused(result):
    """Exit 2 is OUR refusal only with the `REFUSED: ` line wbb_release.py and dbsnap.py print on stderr.

    Python itself exits 2 when it cannot open the script (an installation half done, a LIB_DIR the bot user
    cannot read): that is a host failure a reinstall fixes, never a refusal a retry cannot fix (Б-ядро
    review) — the engine would turn it into recovery-failed.
    """
    return result.returncode == 2 and any(line.startswith('REFUSED: ') for line in _text(result.stderr).splitlines())


def reason(result):
    """The first non-empty line of stderr, else of stdout, cut: what the operator reads in a HostError."""
    for stream in (result.stderr, result.stdout):
        for line in _text(stream).splitlines():
            if line.strip():
                return line.strip()[:REASON_MAX]
    return 'no output'


def call(run, argv, timeout, error=HostError, **kwargs):
    """run(argv) -> CompletedProcess; a failure to run at all (missing binary, timeout) raises `error`.
    kwargs (stdin=) go to run as they are."""
    try:
        return run(argv, timeout=timeout, **kwargs)
    except (OSError, subprocess.SubprocessError) as e:
        raise error(f'{argv[0]}: {type(e).__name__}') from None


def read_env(run, key, error=HostError):
    """One key of the bot's .env through wbb-read-env as the bot user (merge-deploy _read_env_default).

    The value itself never goes into an exception: it may be a token.
    """
    r = call(run, as_bot([ins.READ_ENV_BIN, ins.BOT_ENV_FILE, key]), READ_ENV_TIMEOUT_S, error)
    if r.returncode != 0:
        raise error(f'read-env {key}: exit {r.returncode}')
    lines = _text(r.stdout).splitlines()
    return lines[0].strip() if lines else ''


def _first_line(result):
    lines = _text(result.stdout).splitlines()
    return lines[0] if lines else ''


def _sha(sha):
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise Refused(f'not a full lowercase SHA: {sha!r}')
    return sha


def _abs(path):
    if not isinstance(path, str) or not os.path.isabs(path) or '\n' in path or '\0' in path:
        raise Refused(f'not an absolute path: {path!r}')
    return path


class RealHost:
    def __init__(self, run=bounded.run, urlopen=None, clock=time.time, sleep=time.sleep,
                 roots=PRODUCTION_ROOTS, boot_id_file=ins.BOOT_ID_FILE, db=ins.DB_PATH):
        # /health is local: never through a proxy from the environment, never after a redirect (merge-deploy's
        # curl had neither) — a proxy would turn every probe into a failed one, i.e. a rollback (Б-ядро review).
        urlopen = urlopen or urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect).open
        self._run, self._urlopen, self._clock, self._sleep = run, urlopen, clock, sleep
        self._roots, self._boot_id_file, self._db = roots, boot_id_file, db
        self._port = None

    # --- units -------------------------------------------------------------------------------------------------
    def _show(self, prop, unit):
        r = call(self._run, ['systemctl', 'show', '-p', prop, '--value', unit], SHOW_TIMEOUT_S)
        if r.returncode != 0:
            raise HostError(f'systemctl show {prop} {unit}: exit {r.returncode}: {reason(r)}')
        return _text(r.stdout).strip()

    def _state(self, unit):
        got = self._show('ActiveState', unit)
        if not UNIT_STATE.fullmatch(got):
            raise HostError(f'systemctl show ActiveState {unit}: {got[:REASON_MAX]!r}')
        return got

    def _service(self, verb, unit):
        r = call(self._run, ['sudo', '-n', 'systemctl', verb, unit], SERVICE_TIMEOUT_S)
        if r.returncode != 0:
            raise HostError(f'systemctl {verb} {unit}: exit {r.returncode}: {reason(r)}')

    def bot_state(self):
        return self._state(ins.BOT_UNIT)

    def litestream_state(self):
        return self._state(ins.LITESTREAM_UNIT)

    def stop_bot(self):
        self._service('stop', ins.BOT_UNIT)

    def start_bot(self):
        self._service('start', ins.BOT_UNIT)

    def stop_litestream(self):
        self._service('stop', ins.LITESTREAM_UNIT)

    def start_litestream(self):
        self._service('start', ins.LITESTREAM_UNIT)

    def nrestarts(self):
        """The unit's NRestarts; None when systemd answered something that is not a count."""
        got = self._show('NRestarts', ins.BOT_UNIT)
        return int(got) if got.isascii() and got.isdigit() else None

    # --- releases ----------------------------------------------------------------------------------------------
    def current(self):
        try:
            return pub.current_sha(self._roots)
        except OSError as e:
            raise HostError(f'current: {type(e).__name__}: {e.strerror}') from None

    def _helper(self, verb, sha, line):
        r = call(self._run, ['sudo', '-n', ins.ROOT_HELPER, verb, '--sha', _sha(sha)], VERIFY_TIMEOUT_S)
        if refused(r):
            raise Refused(f'{verb} {sha[:7]}: {reason(r)}')
        if r.returncode != 0:
            raise HostError(f'wbb-release {verb}: exit {r.returncode}: {reason(r)}')
        m = line.fullmatch(_first_line(r))
        if m is None or m.group(1) != sha:
            raise HostError(f'wbb-release {verb} {sha[:7]}: no verdict line: {_first_line(r)[:REASON_MAX]!r}')
        return m.group(2)

    def verify(self, sha):
        return self._helper('verify', sha, VERIFIED)

    def switch(self, sha):
        return self._helper('switch', sha, SWITCHED)

    # --- the database (as the bot user) -------------------------------------------------------------------------
    def _dbsnap(self, args, done):
        r = call(self._run, dbsnap_argv(*args), DB_TIMEOUT_S)
        if refused(r):
            raise Refused(f'dbsnap {args[0]}: {reason(r)}')
        if r.returncode != 0:
            raise HostError(f'dbsnap {args[0]}: exit {r.returncode}: {reason(r)}')
        if not done.fullmatch(_first_line(r)):
            raise HostError(f'dbsnap {args[0]}: unexpected output {_first_line(r)[:REASON_MAX]!r}')

    def post(self, out):
        self._dbsnap(['post', self._db, _abs(out)], re.compile(re.escape(f'POST {out}')))

    def restore(self, pre_path, post_dir):
        self._dbsnap(['restore', _abs(pre_path), self._db, _abs(post_dir)],
                     re.compile(f'(?:RESTORED|ALREADY) {re.escape(self._db)}'))

    # --- /health --------------------------------------------------------------------------------------------------
    def api_port(self):
        """API_PORT of the bot's .env, read once per Host (one tick); empty is the app's default 3000."""
        if self._port is None:
            got = read_env(self._run, 'API_PORT') or DEFAULT_API_PORT
            if not (got.isascii() and got.isdigit() and 1 <= int(got) <= 65535):
                raise HostError(f'API_PORT is not a port: {got[:20]!r}')
            self._port = int(got)
        return self._port

    def health(self):
        """One probe. No 2xx answer at all is HostError (the engine counts it a failed probe)."""
        url = f'http://127.0.0.1:{self.api_port()}/health'
        try:
            with self._urlopen(url, timeout=HEALTH_TIMEOUT_S) as resp:
                body = resp.read(HEALTH_MAX_BYTES + 1)
        except urllib.error.HTTPError as e:
            e.close()  # #828 AI review: the error carries the open response; a probe a minute must not leak it
            raise HostError(f'/health: HTTP {e.code}') from None
        except (OSError, http.client.HTTPException, ValueError) as e:
            raise HostError(f'/health: {type(e).__name__}') from None
        if len(body) > HEALTH_MAX_BYTES:
            raise HostError(f'/health: over {HEALTH_MAX_BYTES} bytes')
        try:
            data = json.loads(body)
        except ValueError:
            return Health(False, None)
        if not isinstance(data, dict):
            return Health(False, None)
        rs = data.get('releaseSha')
        return Health(data.get('ok') is True, rs if isinstance(rs, str) and SHA.fullmatch(rs) else None)

    # --- time and boot ------------------------------------------------------------------------------------------
    def boot_id(self):
        try:
            with open(self._boot_id_file, encoding='ascii') as f:
                got = f.read(128).strip()
        except (OSError, ValueError) as e:
            raise HostError(f'boot id: {type(e).__name__}') from None
        if not _BOOT_ID.fullmatch(got):
            raise HostError(f'boot id: {got[:40]!r}')
        return got

    def now(self):
        return self._clock()

    def sleep(self, seconds):
        self._sleep(seconds)
