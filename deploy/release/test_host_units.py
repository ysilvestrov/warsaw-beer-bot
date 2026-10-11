"""The control plane's host files: deploy/sudoers.d/wbb-release against the adapters, and the tick's systemd units.

Plan: docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md, "Рішення" п.7, п.8, Task 3.

The sudo calls are not a list copied here: every public method of helpers_adapter.RealHelpers and
host_adapter.RealHost is driven over a recording `run`, and whatever argv starts with `sudo` is what the tick runs
through sudo. Each such call needs a rule — root's in wbb-release, the bot user's in merge-deploy's
warsaw-beer-bot — and each rule of wbb-release needs a call (a rule nobody uses is a grant nobody reviews).
Rules are read by a minimal parser of the two sudoers forms these files use; `visudo -cf` checks the real syntax
where the system has it.
"""
import contextlib
import errno
import fnmatch
import inspect
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gates  # noqa: E402
import helpers_adapter as hpa  # noqa: E402
import host_adapter as hsa  # noqa: E402
import installed as ins  # noqa: E402
from deploy_state import Pre  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOY = os.path.dirname(HERE)
SUDOERS = os.path.join(DEPLOY, 'sudoers.d')
OPERATOR = 'ysi'
SHA = 'c' * 40
PRE_NAME = '20251010T080000Z-ccccccc-pre.db'
# What sudo's secure_path resolves a bare command name to on the host — merge-deploy's rules already rely on it
# (`sudo systemctl` matched by /usr/bin/systemctl). A bare name not listed here fails the test, never guesses.
RESOLVED = {'systemctl': '/usr/bin/systemctl', 'bash': '/usr/bin/bash'}
SHELLS = {'sh', 'bash', 'dash', 'zsh', 'su', 'env', 'sudo', 'python3'}
# Every argument the adapters' public methods take, by parameter name: a new parameter name fails the test
# until it is given here, so a new method is driven too.
ARGS = {
    'a': SHA, 'b': SHA, 'sha': SHA, 'trusted': None, 'zip_path': None,  # a real file, made by sudo_calls
    'pre_name': PRE_NAME, 'pre': Pre(os.path.join(hpa.SNAPSHOT_ROOT, PRE_NAME), '0' * 64, 0),
    'patterns': gates.INSTALLED_COPIES, 'out': '/var/lib/x', 'pre_path': '/var/lib/x.db', 'post_dir': '/var/lib/y',
    'seconds': 0,
}
# The one answer to every command: as `git ls-tree -z` it lists a sudoers file, so installed_stale reaches root.
ANSWER = b'deploy/sudoers.d/wbb-release\0'


# --- a minimal sudoers reader -----------------------------------------------------------------------------------
class SudoersSyntax(ValueError):
    pass


ALIAS = re.compile(r'Cmnd_Alias\s+([A-Z][A-Z0-9_]*)\s*=\s*(.+)')
USER_SPEC = re.compile(r'([a-z_][a-z0-9_-]*)\s+ALL\s*=\s*\(([a-z_][a-z0-9_-]*)\)\s*NOPASSWD:\s*(.+)')


def logical_lines(text):
    """Comment lines dropped, backslash-continued lines joined."""
    out, cur = [], ''
    for raw in text.splitlines():
        line = raw.strip()
        if not cur and (line == '' or line.startswith('#')):
            continue
        if line.endswith('\\'):
            cur += line[:-1] + ' '
            continue
        out.append(cur + line)
        cur = ''
    if cur:
        raise SudoersSyntax(f'continuation at the end of the file: {cur!r}')
    return out


def split_unescaped(text, sep):
    parts = re.split(r'(?<!\\)' + sep, text)
    return [p.strip() for p in parts]


def unescape(word):
    return re.sub(r'\\(.)', r'\1', word)


def command(spec):
    """One Cmnd: (path, argument pattern or None for "any arguments")."""
    words = [unescape(w) for w in re.split(r'(?<!\\)\s+', spec.strip()) if w]
    if not words or not (words[0].startswith('/') or words[0] == 'ALL'):
        raise SudoersSyntax(f'not a command: {spec!r}')
    return words[0], (' '.join(words[1:]) if len(words) > 1 else None)


def parse(text):
    """[(user, runas, path, argument pattern)] with the file's own Cmnd_Alias names expanded."""
    aliases, rules = {}, []
    for line in logical_lines(text):
        m = ALIAS.fullmatch(line)
        if m:
            aliases[m.group(1)] = [command(c) for c in split_unescaped(m.group(2), ',')]
            continue
        m = USER_SPEC.fullmatch(line)
        if m is None:
            raise SudoersSyntax(f'neither Cmnd_Alias nor a user spec: {line!r}')
        for c in split_unescaped(m.group(3), ','):
            cmds = aliases[c] if c in aliases else [command(c)]
            rules += [(m.group(1), m.group(2), path, args) for path, args in cmds]
    return rules


def read_rules(name):
    with open(os.path.join(SUDOERS, name), encoding='utf-8') as f:
        return parse(f.read())


def rule_matches(rule, user, runas, path, args):
    r_user, r_runas, r_path, r_args = rule
    if (r_user, r_runas, r_path) != (user, runas, path):
        return False
    # sudo: no arguments in the rule allows any; otherwise the whole argument string against the pattern,
    # where `*` matches anything, spaces included.
    return r_args is None or fnmatch.fnmatchcase(' '.join(args), r_args)


# --- the adapters' sudo calls -----------------------------------------------------------------------------------
class Recorder:
    def __init__(self):
        self.argvs = []

    def __call__(self, argv, *, timeout, **kwargs):
        self.argvs.append(list(argv))
        return subprocess.CompletedProcess(argv, 0, ANSWER, b'')


def _no_network(*args, **kwargs):
    raise OSError('no network in this test')


def drive(obj, args):
    """Every public method of obj, with args by parameter name; whatever it raises after its calls is not ours."""
    for name, method in inspect.getmembers(obj, inspect.ismethod):
        if name.startswith('_'):
            continue
        kwargs = {p: args[p] for p in inspect.signature(method).parameters}
        with contextlib.suppress(Exception):
            method(**kwargs)


def sudo_calls():
    """(argv, user, runas, resolved path, args) of every argv the adapters start with `sudo`."""
    run = Recorder()
    data = tempfile.mkdtemp()
    real_open = os.open

    def operator_open(path, flags, *args):
        # The operator cannot read /etc/sudoers.d (0440 root): that is what sends installed_stale to root.
        if isinstance(path, str) and ins.digestable(path) and path != ins.LITESTREAM_CONFIG:
            raise PermissionError(errno.EACCES, 'Permission denied', path)
        return real_open(path, flags, *args)

    # publish opens the ZIP as the operator before it calls sudo (e2e review S1): it must exist.
    args = dict(ARGS, zip_path=os.path.join(data, 'x.zip'))
    with open(args['zip_path'], 'wb') as f:
        f.write(b'PK')
    try:
        with mock.patch.object(hpa.os, 'open', operator_open):
            drive(hpa.RealHelpers(data, run=run, api_factory=_no_network, clock=lambda: 1_760_083_200,
                                  lib_dir=os.path.join(data, 'lib')), args)
            drive(hsa.RealHost(run=run, urlopen=_no_network, clock=lambda: 1_760_083_200, sleep=lambda s: None,
                               boot_id_file=os.path.join(data, 'boot_id')), args)
    finally:
        shutil.rmtree(data)
    out = []
    for argv in run.argvs:
        if argv[0] != 'sudo':
            continue
        rest = argv[1:]
        assert rest[0] == '-n', f'sudo without -n would wait for a password: {argv}'
        runas = 'root'
        rest = rest[1:]
        if rest[0] == '-u':
            runas, rest = rest[1], rest[2:]
        path = rest[0] if rest[0].startswith('/') else RESOLVED[rest[0]]
        out.append((argv, OPERATOR, runas, path, rest[1:]))
    return out


class SudoersCoverage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.calls = sudo_calls()
        cls.release = read_rules('wbb-release')
        cls.merge = read_rules('warsaw-beer-bot')

    def test_the_adapters_reach_every_root_verb_through_sudo(self):
        """The derivation itself: the root helper's verbs the tick runs with sudo, and the two units it stops."""
        root = sorted({(c[3], c[4][0]) for c in self.calls if c[2] == 'root'})
        self.assertEqual(root, [('/usr/bin/systemctl', 'start'), ('/usr/bin/systemctl', 'stop'),
                                (ins.ROOT_HELPER, 'digest'), (ins.ROOT_HELPER, 'probe'), (ins.ROOT_HELPER, 'publish'),
                                (ins.ROOT_HELPER, 'switch'), (ins.ROOT_HELPER, 'trial'), (ins.ROOT_HELPER, 'verify')])

    def test_every_root_call_has_a_rule_in_wbb_release(self):
        missing = [c[0] for c in self.calls if c[2] == 'root'
                   and not any(rule_matches(r, *c[1:]) for r in self.release)]
        self.assertEqual(missing, [])

    def test_every_call_as_the_bot_user_has_merge_deploy_s_rule(self):
        as_bot = [c for c in self.calls if c[2] == ins.BOT_USER]
        self.assertEqual(sorted({c[3] for c in as_bot}), ['/usr/bin/bash'])
        missing = [c[0] for c in as_bot if not any(rule_matches(r, *c[1:]) for r in self.merge)]
        self.assertEqual(missing, [])

    def test_the_tick_runs_sudo_as_no_one_but_root_and_the_bot_user(self):
        self.assertEqual(sorted({c[2] for c in self.calls}), sorted({'root', ins.BOT_USER}))

    def test_every_rule_of_wbb_release_has_a_caller(self):
        unused = [r for r in self.release
                  if not any(rule_matches(r, *c[1:]) for c in self.calls if c[2] == 'root')]
        self.assertEqual(unused, [])

    def test_wbb_release_grants_no_audit_no_all_and_no_shell(self):
        self.assertEqual(sorted({(r[0], r[1]) for r in self.release}), [(OPERATOR, 'root')])
        self.assertEqual([r for r in self.release if r[2] == 'ALL' or r[3] is None
                          or os.path.basename(r[2]) in SHELLS], [])
        self.assertEqual([r for r in self.release if 'audit' in (r[3] or '').split()], [])

    def test_publish_is_allowed_only_with_the_zip_on_stdin(self):
        """e2e review S1: no rule lets the operator name a path for root to open."""
        publish = [c for c in self.calls if c[2] == 'root' and c[4][0] == 'publish']
        self.assertEqual([c[4] for c in publish], [['publish', '--sha', SHA, '--archive', '-']])
        path = (OPERATOR, 'root', ins.ROOT_HELPER, ['publish', '--sha', SHA, '--archive', '/etc/shadow'])
        self.assertEqual(any(rule_matches(r, *path) for r in self.release), False)

    def test_a_stray_argument_is_matched_by_star_so_the_helper_stays_the_boundary(self):
        """Documents why the plan puts the trust boundary in argparse: sudo's `*` crosses spaces."""
        call = (OPERATOR, 'root', ins.ROOT_HELPER, ['verify', '--sha', SHA, '--extra'])
        self.assertEqual(any(rule_matches(r, *call) for r in self.release), True)
        audit = (OPERATOR, 'root', ins.ROOT_HELPER, ['audit', '--sha', SHA])
        self.assertEqual(any(rule_matches(r, *audit) for r in self.release), False)


class SudoersSyntaxCheck(unittest.TestCase):
    def test_the_minimal_parser_reads_every_line_of_both_files(self):
        self.assertEqual(len(read_rules('wbb-release')), 10)
        self.assertEqual(len(read_rules('warsaw-beer-bot')), 19)

    def test_the_minimal_parser_refuses_what_it_does_not_know(self):
        for text in ('ysi ALL=(root) ALL\n', 'Defaults !requiretty\n', 'ysi ALL=(root) NOPASSWD: rm -rf /\n',
                     'ysi ALL=(root) NOPASSWD: /bin/true, \\\n'):
            with self.subTest(text):
                with self.assertRaises(SudoersSyntax):
                    parse(text)

    @unittest.skipUnless(os.access('/usr/sbin/visudo', os.X_OK), 'no visudo here: the minimal parser above checks')
    def test_visudo_accepts_wbb_release(self):
        r = subprocess.run(['/usr/sbin/visudo', '-cf', os.path.join(SUDOERS, 'wbb-release')],
                           capture_output=True, text=True, timeout=30)
        self.assertEqual((r.returncode, r.stderr), (0, ''))


# --- the tick's units -------------------------------------------------------------------------------------------
def unit_file(name):
    with open(os.path.join(DEPLOY, name), encoding='utf-8') as f:
        return f.read()


def directives(text, section):
    """The section's directives, comments and blank lines dropped."""
    body = text.split(f'[{section}]\n')[1].split('\n[')[0]
    return [line.strip() for line in body.splitlines() if line.strip() and not line.strip().startswith('#')]


def section_text(text, section):
    return text.split(f'[{section}]\n')[1].split('\n[')[0]


class TickUnits(unittest.TestCase):
    def test_the_tick_service(self):
        text = unit_file('wbb-tick.service')
        self.assertEqual(directives(text, 'Service'), [
            'Type=oneshot', 'User=ysi', 'Environment=HOME=/home/ysi', 'ExecStart=/usr/local/bin/wbb-tick timer',
            'TimeoutStartSec=30min', 'SuccessExitStatus=0 1 2', 'StandardOutput=journal', 'StandardError=journal'])
        self.assertIn('OnFailure=wbb-tick-failed.service', directives(text, 'Unit'))
        self.assertEqual(ins.installed_path('deploy/wbb-tick.service'), '/etc/systemd/system/wbb-tick.service')
        self.assertEqual(ins.installed_path('deploy/wbb-tick.sh'), '/usr/local/bin/wbb-tick')

    def test_neither_tick_unit_sets_no_new_privileges_or_a_proxy(self):
        for name in ('wbb-tick.service', 'wbb-tick-failed.service'):
            with self.subTest(name):
                lines = [d.lower() for d in directives(unit_file(name), 'Service')]
                self.assertEqual([d for d in lines if 'nonewprivileges' in d or 'proxy' in d], [])

    def test_the_failure_notice_service(self):
        text = unit_file('wbb-tick-failed.service')
        self.assertEqual(directives(text, 'Service'), [
            'Type=oneshot', 'User=ysi', 'Environment=HOME=/home/ysi', 'ExecStart=/usr/local/libexec/wbb-tick-failed',
            'TimeoutStartSec=2min', 'StandardOutput=journal', 'StandardError=journal'])
        self.assertEqual(ins.installed_path('deploy/wbb-tick-failed.sh'), '/usr/local/libexec/wbb-tick-failed')

    def test_the_timer_is_merge_deploy_s_schedule_line_for_line(self):
        """The #798 lesson travels with it: the [Timer] section, comment included, is merge-deploy's."""
        self.assertEqual(section_text(unit_file('wbb-tick.timer'), 'Timer'),
                         section_text(unit_file('wbb-autodeploy.timer'), 'Timer'))
        self.assertEqual(directives(unit_file('wbb-tick.timer'), 'Timer'),
                         ['OnActiveSec=5min', 'OnUnitActiveSec=5min', 'RandomizedDelaySec=60', 'Persistent=true'])


if __name__ == '__main__':
    unittest.main()
