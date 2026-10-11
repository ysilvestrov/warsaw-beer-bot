"""helpers_adapter.RealHelpers over a scripted `run` (argv, exit codes) and a real temporary git clone.

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-b-core.md, Task 2.
Nothing here runs sudo or gh, or reaches GitHub: the API is test_github_trust's scripted one.
"""
import errno
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounded  # noqa: E402
import github_trust as gt  # noqa: E402
import helpers_adapter as hpa  # noqa: E402
import publish as pub  # noqa: E402
import test_github_trust as tg  # noqa: E402
from deploy_state import Pre  # noqa: E402
from fake_run import FakeRun, done  # noqa: E402
from gates import Pr  # noqa: E402
from helpers import HelperError, Run  # noqa: E402

SHA = 'c' * 40
OTHER = 'd' * 40
TREE = '1' * 64
DATA = '/home/ysi/.local/share/wbb-autodeploy'
CLONE = DATA + '/repo'
GIT = ['git', '-C', CLONE]
AS_BOT = ['sudo', '-n', '-u', 'warsaw-beer-bot', 'bash', '-lc', '"$0" "$@"']
SNAPS = '/var/lib/warsaw-beer-bot/deploy-snapshots'
PRE_NAME = '20251010T080000Z-ccccccc-pre.db'
T = 1_760_083_200  # 2025-10-10T08:00:00Z
TOKEN = 'ghp_SECRETTOKEN0123456789'
SUDO_FAILED = done(1, b'', b'sudo: a password is required\n')


def helpers(answers=None, **kw):
    run = FakeRun(answers)
    kw.setdefault('clock', lambda: T)
    return hpa.RealHelpers(DATA, run=run, **kw), run


class Git(unittest.TestCase):
    def test_fetch_main(self):
        h, run = helpers({tuple(GIT + ['fetch', '-q', '--prune', 'origin']): done(0),
                          tuple(GIT + ['rev-parse', '--verify', 'origin/main^{commit}']): done(0, f'{SHA}\n'.encode())})
        self.assertEqual(h.fetch_main(), SHA)
        self.assertEqual([t for _, t in run.calls], [300, 60])

    def test_a_failed_fetch_or_a_strange_rev_parse_is_a_helper_error(self):
        fetch = tuple(GIT + ['fetch', '-q', '--prune', 'origin'])
        parse = tuple(GIT + ['rev-parse', '--verify', 'origin/main^{commit}'])
        for answers, why in (({fetch: done(128, b'', b'fatal: unable to access\n')}, 'git fetch: exit 128: fatal'),
                             ({fetch: done(0), parse: done(0, b'refs/heads/main\n')}, 'not a full lowercase SHA')):
            with self.subTest(why):
                h, _ = helpers(answers)
                with self.assertRaisesRegex(HelperError, why):
                    h.fetch_main()

    def test_is_ancestor_asks_merge_base_once_both_commits_are_known(self):
        for code, want in ((0, True), (1, False)):
            with self.subTest(code):
                h, run = helpers({tuple(GIT + ['cat-file', '-e', SHA]): done(0),
                                  tuple(GIT + ['cat-file', '-e', OTHER]): done(0),
                                  tuple(GIT + ['merge-base', '--is-ancestor', SHA, OTHER]): done(code)})
                self.assertIs(h.is_ancestor(SHA, OTHER), want)
                self.assertEqual(len(run.calls), 3)

    def test_a_commit_the_clone_does_not_have_is_no_ones_ancestor(self):
        h, run = helpers({tuple(GIT + ['cat-file', '-e', SHA]): done(1)})
        self.assertIs(h.is_ancestor(SHA, OTHER), False)
        self.assertEqual(run.argvs(), [GIT + ['cat-file', '-e', SHA]])

    def test_git_that_could_not_answer_is_a_helper_error(self):
        cat = tuple(GIT + ['cat-file', '-e', SHA])
        for answers, why in (({cat: done(128, b'', b'fatal: not a git repository\n')}, 'git cat-file: exit 128'),
                             ({cat: done(0), tuple(GIT + ['cat-file', '-e', OTHER]): done(0),
                               tuple(GIT + ['merge-base', '--is-ancestor', SHA, OTHER]): done(128, b'', b'fatal: x\n')},
                              'git merge-base: exit 128: fatal: x')):
            with self.subTest(why):
                h, _ = helpers(answers)
                with self.assertRaisesRegex(HelperError, why):
                    h.is_ancestor(SHA, OTHER)

    def test_a_ref_that_is_not_a_sha_never_reaches_git(self):
        h, run = helpers({})
        for call in (lambda: h.is_ancestor('HEAD', SHA), lambda: h.changed_paths(SHA, '--output=/x'),
                     lambda: h.commits(SHA[:7], SHA)):
            with self.assertRaisesRegex(HelperError, 'not a full lowercase SHA'):
                call()
        self.assertEqual(run.calls, [])

    def test_changed_paths_without_renames_or_quoting(self):
        argv = GIT + ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', '-z', SHA, OTHER]
        h, _ = helpers({tuple(argv): done(0, 'deploy/a.sh\0docs/żółw.md\0with\nnewline\0'.encode())})
        self.assertEqual(h.changed_paths(SHA, OTHER), ('deploy/a.sh', 'docs/żółw.md', 'with\nnewline'))

    def test_an_empty_diff_is_no_paths_and_a_failed_one_an_error(self):
        argv = tuple(GIT + ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', '-z', SHA, OTHER])
        h, _ = helpers({argv: [done(0, b''), done(128, b'', b'fatal: bad object\n')]})
        self.assertEqual(h.changed_paths(SHA, OTHER), ())
        with self.assertRaisesRegex(HelperError, '^git diff: exit 128: fatal: bad object$'):
            h.changed_paths(SHA, OTHER)

    def test_commits(self):
        h, _ = helpers({tuple(GIT + ['rev-list', f'{SHA}..{OTHER}']): done(0, f'{OTHER}\n{"e" * 40}\n'.encode())})
        self.assertEqual(h.commits(SHA, OTHER), (OTHER, 'e' * 40))

    def test_truncated_output_is_never_read_as_complete(self):
        seen = []

        def run(a, timeout):
            seen.append(a)
            r = subprocess.CompletedProcess(a, 0, f'{OTHER}\n'.encode(), b'')
            r.truncated = True
            return r

        h = hpa.RealHelpers(DATA, run=run)
        with self.assertRaisesRegex(HelperError, '^git rev-list: output too large$'):
            h.commits(SHA, OTHER)
        self.assertEqual(seen, [GIT + ['rev-list', f'{SHA}..{OTHER}']])


class GitHub(unittest.TestCase):
    PULLS = ('gh', 'api', f'repos/ysilvestrov/warsaw-beer-bot/commits/{SHA}/pulls?per_page=100')

    def test_pr_labels(self):
        prs = [{'number': 12, 'labels': [{'name': 'deploy:hold'}, {'name': 'bug'}]}, {'number': 13, 'labels': []}]
        h, run = helpers({self.PULLS: done(0, json.dumps(prs).encode())})
        self.assertEqual(h.pr_labels(SHA), (Pr(12, ('deploy:hold', 'bug')), Pr(13, ())))
        self.assertEqual(run.calls, [(list(self.PULLS), 60)])

    def test_pr_labels_that_cannot_be_trusted_are_a_helper_error(self):
        for answer, why in ((done(1, b'', b'HTTP 502\n'), 'exit 1: HTTP 502'), (done(0, b'<html>'), 'unexpected JSON'),
                            (done(0, b'{"number": 1}'), 'unexpected JSON'),
                            (done(0, b'[{"number": "1", "labels": []}]'), 'unexpected JSON'),
                            (done(0, b'[{"number": 1, "labels": [{}]}]'), 'unexpected JSON')):
            with self.subTest(why):
                h, _ = helpers({self.PULLS: answer})
                with self.assertRaisesRegex(HelperError, why):
                    h.pr_labels(SHA)

    def test_a_full_page_of_prs_may_be_partial(self):
        page = [{'number': n, 'labels': []} for n in range(1, 101)]
        h, _ = helpers({self.PULLS: [done(0, json.dumps(page[:99]).encode()), done(0, json.dumps(page).encode())]})
        self.assertEqual(len(h.pr_labels(SHA)), 99)
        with self.assertRaisesRegex(HelperError, '100 PRs, the listing may be partial'):
            h.pr_labels(SHA)

    def with_api(self, data, token=done(0, f'{TOKEN}\n'.encode())):
        made = []
        api = tg.fake_api(data)

        def factory(tok):
            made.append(tok)
            return api
        h, run = helpers({('gh', 'auth', 'token'): token}, api_factory=factory, repo=tg.REPO)
        return h, run, made

    def test_trusted_is_fetch_trusted_over_the_operators_token(self):
        h, run, made = self.with_api(tg.GOOD)
        got = h.trusted(tg.SHA)
        self.assertEqual((got.sha, got.run_id, got.run_attempt, got.zip_sha256), (tg.SHA, tg.RUN, 2, tg.DIGEST))
        h.trusted(tg.SHA)
        self.assertEqual((made, run.calls), ([TOKEN], [(['gh', 'auth', 'token'], 30)]))

    def test_cis_own_verdict_and_no_run_yet_pass_through_unchanged(self):
        for data, exc in ((tg.with_(runs=tg.listing('workflow_runs', [tg.run(conclusion='failure')])), gt.RunFailed),
                          (tg.with_(runs=tg.listing('workflow_runs', [])), gt.NoRunYet)):
            with self.subTest(exc.__name__):
                h, _, _ = self.with_api(data)
                with self.assertRaises(exc) as caught:
                    h.trusted(tg.SHA)
                self.assertIs(type(caught.exception), exc)

    def test_no_token_is_a_helper_error_that_never_shows_one(self):
        for answer, why in ((done(1, f'{TOKEN}\n'.encode(), b'no oauth token found for github.com\n'),
                             '^gh auth token: exit 1, no token: no oauth token found for github.com$'),
                            (done(0, b'\n'), '^gh auth token: exit 0, no token$'),
                            (done(0, f'{TOKEN} {TOKEN}\n'.encode()), '^gh auth token: exit 0, no token$'),
                            (FileNotFoundError(2, 'gh'), '^gh: FileNotFoundError$')):
            with self.subTest(why):
                h, _, made = self.with_api(tg.GOOD, token=answer)
                with self.assertRaisesRegex(HelperError, why) as caught:
                    h.trusted(tg.SHA)
                self.assertNotIn(TOKEN, str(caught.exception))
                self.assertEqual(made, [])


class Download(unittest.TestCase):
    def setUp(self):
        self.data = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.data)
        self.trusted = gt.fetch_trusted(tg.fake_api(tg.GOOD), tg.REPO, tg.SHA)
        self.got = []

    def helpers(self, body=b'PK zip bytes', exc=None):
        test = self

        class Api:
            def download(self, repo, artifact_id, out, cap):
                test.got.append((repo, artifact_id, cap))
                out.write(body)
                if exc is not None:
                    raise exc
                return len(body)

        return hpa.RealHelpers(self.data, run=FakeRun({('gh', 'auth', 'token'): done(0, TOKEN.encode())}),
                               api_factory=lambda tok: Api())

    def test_the_zip_lands_in_a_private_directory_named_by_the_sha(self):
        path = self.helpers().download(tg.SHA, self.trusted)
        self.assertEqual(path, os.path.join(self.data, 'artifacts', f'{tg.SHA}.zip'))
        with open(path, 'rb') as f:
            self.assertEqual(f.read(), b'PK zip bytes')
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode), 0o700)
        self.assertEqual(self.got, [(tg.REPO, 11602159138, 257 * 1024 * 1024)])
        self.assertEqual(os.listdir(os.path.dirname(path)), [f'{tg.SHA}.zip'])

    def test_a_left_over_partial_is_made_private(self):
        # #828 AI review: O_CREAT keeps the mode of a file that already exists.
        os.mkdir(os.path.join(self.data, 'artifacts'), 0o700)
        part = os.path.join(self.data, 'artifacts', f'{tg.SHA}.zip.partial')
        with open(part, 'wb'):
            pass
        os.chmod(part, 0o644)
        path = self.helpers().download(tg.SHA, self.trusted)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_a_failed_download_leaves_nothing_and_its_untrusted_passes_through(self):
        with self.assertRaisesRegex(gt.Untrusted, '^artifact storage returned 403$'):
            self.helpers(exc=gt.Untrusted('artifact storage returned 403')).download(tg.SHA, self.trusted)
        self.assertEqual(os.listdir(os.path.join(self.data, 'artifacts')), [])

    def test_an_identity_of_another_sha_is_refused(self):
        with self.assertRaisesRegex(HelperError, 'the trusted identity is of e58da52, not ccccccc'):
            self.helpers().download(SHA, self.trusted)
        self.assertEqual(self.got, [])

    def test_a_directory_others_can_read_is_refused(self):
        os.mkdir(os.path.join(self.data, 'artifacts'), 0o755)
        os.chmod(os.path.join(self.data, 'artifacts'), 0o755)
        with self.assertRaisesRegex(HelperError, 'must be a directory of this user, 0700'):
            self.helpers().download(tg.SHA, self.trusted)
        self.assertEqual(self.got, [])


def release(verb, *extra, sudo=True):
    return tuple((['sudo', '-n'] if sudo else []) + ['/usr/local/libexec/wbb-release', verb, '--sha', SHA, *extra])


class Release(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.base)
        self.zip = os.path.join(self.base, 'a.zip')
        with open(self.zip, 'wb') as f:
            f.write(b'PK\x03\x04 the artifact')

    def one(self, verb, answer, *args, **kw):
        argv = release(verb, *kw.pop('extra', ()), sudo=kw.pop('sudo', True))
        h, run = helpers({argv: answer})
        got = getattr(h, verb)(SHA, *args)
        self.assertEqual(run.argvs(), [list(argv)])
        return got

    def test_every_verdict_line(self):
        cases = [
            ('verify', (), {}, done(0, f'VERIFIED {SHA}: tree {TREE} (run 7 attempt 1)\n'.encode()),
             Run(0, 'VERIFIED', f'VERIFIED {SHA}: tree {TREE} (run 7 attempt 1)', TREE)),
            ('publish', (self.zip,), {'extra': ('--archive', '-')},
             done(0, f'ACCEPTED {SHA}: run 7 attempt 1, artifact 9\n'.encode()),
             Run(0, 'ACCEPTED', f'ACCEPTED {SHA}: run 7 attempt 1, artifact 9')),
            ('publish', (self.zip,), {'extra': ('--archive', '-')},
             done(0, f'ALREADY-ACCEPTED {SHA}: run 7 attempt 1, artifact 9\n'.encode()),
             Run(0, 'ALREADY-ACCEPTED', f'ALREADY-ACCEPTED {SHA}: run 7 attempt 1, artifact 9')),
            ('audit', (), {'sudo': False}, done(0, f'AUDIT CLEAN {SHA} tree {TREE}\nno advisories\n'.encode()),
             Run(0, 'CLEAN', f'AUDIT CLEAN {SHA} tree {TREE}\nno advisories', TREE)),
            ('audit', (), {'sudo': False}, done(1, f'AUDIT ADVISORY {SHA} tree {TREE}\nhigh: x\n'.encode()),
             Run(1, 'ADVISORY', f'AUDIT ADVISORY {SHA} tree {TREE}\nhigh: x', TREE)),
            ('audit', (), {'sudo': False}, done(0, f'AUDIT UNRUNNABLE {SHA} tree None\n'.encode()),
             Run(0, 'UNRUNNABLE', f'AUDIT UNRUNNABLE {SHA} tree None')),
            ('probe', (), {}, done(1, f'PROBE FAILED {SHA}: native: x\nNODE /usr/bin/node {TREE} v24 137\n'.encode()),
             Run(1, 'FAILED', f'PROBE FAILED {SHA}: native: x\nNODE /usr/bin/node {TREE} v24 137')),
            ('trial', (PRE_NAME,), {'extra': ('--snapshot', PRE_NAME)}, done(0, f'TRIAL OK {SHA}: migrate: y\n'.encode()),
             Run(0, 'OK', f'TRIAL OK {SHA}: migrate: y')),
            ('verify', (), {}, done(2, b'', f'REFUSED: {SHA}: no receipt\n'.encode()),
             Run(2, None, f'REFUSED: {SHA}: no receipt')),
            ('verify', (), {}, done(0, b''), Run(0, None, '')),
        ]
        for verb, args, kw, answer, want in cases:
            with self.subTest(f'{verb} {want.kind}'):
                self.assertEqual(self.one(verb, answer, *args, **kw), want)

    def test_timeouts(self):
        h, run = helpers({release('verify'): done(2), release('audit', sudo=False): done(2), release('probe'): done(2),
                          release('trial', '--snapshot', PRE_NAME): done(2),
                          release('publish', '--archive', '-'): done(2)})
        h.verify(SHA), h.audit(SHA), h.probe(SHA), h.trial(SHA, PRE_NAME), h.publish(SHA, self.zip)
        self.assertEqual([t for _, t in run.calls], [300, 300, 300, 600, 900])

    def test_publish_gives_root_the_zip_on_stdin_opened_by_the_operator(self):
        """e2e review S1: the path never reaches root's argv; the bytes come through stdin."""
        seen = []

        def run(argv, *, timeout, stdin=None, **kwargs):
            seen.append((argv, stdin.read()))
            return subprocess.CompletedProcess(argv, 0, f'ACCEPTED {SHA}: run 7\n'.encode(), b'')
        got = hpa.RealHelpers(DATA, run=run).publish(SHA, self.zip)
        self.assertEqual(seen, [(list(release('publish', '--archive', '-')), b'PK\x03\x04 the artifact')])
        self.assertEqual(got.kind, 'ACCEPTED')

    def test_publish_refuses_what_is_not_the_operator_s_regular_file_before_sudo(self):
        link = os.path.join(self.base, 'link.zip')
        os.symlink(self.zip, link)
        for path, why in ((link, f'{link}: OSError: Too many levels of symbolic links'),
                          (self.base, f'{self.base}: not a regular file'),
                          ('/dev/null', '/dev/null: not a regular file'),
                          (os.path.join(self.base, 'none.zip'),
                           f'{self.base}/none.zip: FileNotFoundError: No such file or directory')):
            with self.subTest(path):
                h, run = helpers({})
                with self.assertRaises(HelperError) as cm:
                    h.publish(SHA, path)
                self.assertEqual((str(cm.exception), run.calls), (why, []))

    def test_exit_1_without_its_verdict_line_is_not_a_verdict(self):
        for verb, answer in (('probe', SUDO_FAILED), ('probe', done(1, f'PROBE FAILED {OTHER}: x\n'.encode())),
                             ('probe', done(1, f'TRIAL FAILED {SHA}: x\n'.encode())), ('verify', SUDO_FAILED)):
            with self.subTest(f'{verb} {answer}'):
                with self.assertRaisesRegex(HelperError, f'^wbb-release {verb}: exit 1: '):
                    self.one(verb, answer)

    def test_other_exit_codes_are_helper_errors(self):
        for code in (64, 70, 75, -9):
            with self.subTest(code):
                with self.assertRaisesRegex(HelperError, f'^wbb-release probe: exit {code}: PROBE TRANSIENT'):
                    self.one('probe', done(code, f'PROBE TRANSIENT {SHA}: no unit\n'.encode()))

    def test_a_command_that_could_not_run_is_a_helper_error(self):
        with self.assertRaisesRegex(HelperError, '^sudo: TimeoutExpired$'):
            self.one('probe', subprocess.TimeoutExpired(['sudo'], 300))

    def test_bad_arguments_never_reach_argv(self):
        h, run = helpers({})
        for call, why in ((lambda: h.trial(SHA, '../bot.db'), 'not a pre snapshot name'),
                          (lambda: h.trial(SHA, f'{SNAPS}/{PRE_NAME}'), 'not a pre snapshot name'),
                          (lambda: h.publish(SHA, 'a.zip'), 'not an absolute path'),
                          (lambda: h.verify('-h'), 'not a full lowercase SHA')):
            with self.subTest(why):
                with self.assertRaisesRegex(HelperError, why):
                    call()
        self.assertEqual(run.calls, [])


class Manifest(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.base)
        self.roots = pub.Roots(os.path.join(self.base, 'releases'), '', '', (0, 0))
        os.makedirs(os.path.join(self.roots.releases, SHA))
        self.path = os.path.join(self.roots.releases, SHA, 'tree-manifest.json')
        self.h = hpa.RealHelpers(DATA, run=FakeRun(), roots=self.roots)

    def write(self, data):
        with open(self.path, 'wb') as f:
            f.write(data)

    def test_the_manifest_bytes_up_to_the_limit(self):
        self.write(b'0123456789')
        with mock.patch.object(hpa, 'MAX_MANIFEST_BYTES', 10):
            self.assertEqual(self.h.manifest(SHA), b'0123456789')

    def test_over_the_limit_is_a_helper_error(self):
        self.write(b'0123456789A')
        with mock.patch.object(hpa, 'MAX_MANIFEST_BYTES', 10), self.assertRaisesRegex(HelperError, 'over 10 bytes'):
            self.h.manifest(SHA)

    def test_a_missing_or_linked_manifest_is_a_helper_error(self):
        with self.assertRaisesRegex(HelperError, 'FileNotFoundError'):
            self.h.manifest(SHA)
        os.symlink('/etc/hostname', self.path)
        with self.assertRaisesRegex(HelperError, 'OSError: Too many levels of symbolic links'):
            self.h.manifest(SHA)


class Snapshots(unittest.TestCase):
    PATH = f'{SNAPS}/{PRE_NAME}'
    SNAP = tuple(AS_BOT + ['/usr/local/bin/wbb-db-snapshot', 'snapshot', '/var/lib/warsaw-beer-bot/bot.db', PATH])
    SUM = tuple(AS_BOT + ['/usr/bin/cat', PATH + '.sha256'])
    DISCARD = tuple(AS_BOT + ['/usr/local/bin/wbb-db-snapshot', 'discard', PATH])

    def test_snapshot_pre_as_the_bot_user(self):
        h, run = helpers({self.SNAP: done(0, f'{self.PATH}\n'.encode()), self.SUM: done(0, f'{TREE}\n'.encode())})
        self.assertEqual(h.snapshot_pre(SHA), Pre(self.PATH, TREE, T))
        self.assertEqual(run.calls, [(list(self.SNAP), 600), (list(self.SUM), 30)])

    def test_a_failed_snapshot_is_a_helper_error(self):
        h, run = helpers({self.SNAP: done(1, b'', b'db-snapshot: refusing to overwrite\n')})
        with self.assertRaisesRegex(HelperError, '^snapshot: exit 1: db-snapshot: refusing to overwrite$'):
            h.snapshot_pre(SHA)
        self.assertEqual(run.argvs(), [list(self.SNAP)])

    def test_a_snapshot_without_its_checksum_is_discarded(self):
        h, run = helpers({self.SNAP: done(0), self.SUM: done(0, b'not a digest\n'), self.DISCARD: done(0)})
        with self.assertRaisesRegex(HelperError, 'not a sha256 hex digest'):
            h.snapshot_pre(SHA)
        self.assertEqual(run.argvs(), [list(self.SNAP), list(self.SUM), list(self.DISCARD)])

    def test_discard_pre(self):
        h, run = helpers({self.DISCARD: [done(0), done(1, b'', b'db-snapshot: refusing\n')]})
        self.assertIsNone(h.discard_pre(Pre(self.PATH, TREE, T)))
        self.assertEqual(run.calls, [(list(self.DISCARD), 30)])
        with self.assertRaisesRegex(HelperError, '^discard: exit 1: db-snapshot: refusing$'):
            h.discard_pre(Pre(self.PATH, TREE, T))

    def test_discard_only_a_pre_snapshot_of_the_snapshot_directory(self):
        h, run = helpers({})
        for path in ('/var/lib/warsaw-beer-bot/bot.db', f'{SNAPS}/x-rollback-post', f'/tmp/{PRE_NAME}'):
            with self.subTest(path), self.assertRaisesRegex(HelperError, 'not a pre snapshot of'):
                h.discard_pre(Pre(path, TREE, T))
        self.assertEqual(run.calls, [])


def git(repo, *args):
    subprocess.run(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', *args], check=True,
                   capture_output=True)


class RealClone(unittest.TestCase):
    """The same commands against a real git repository: what the clone answers, not what a script says."""

    def setUp(self):
        self.data = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.data)
        self.repo = os.path.join(self.data, 'repo')
        self.inst = os.path.join(self.data, 'installed')
        os.makedirs(os.path.join(self.repo, 'deploy', 'release'))
        subprocess.run(['git', 'init', '-q', self.repo], check=True)
        self.files = {'deploy/db-snapshot.sh': b'#!/bin/sh\necho snap\n', 'deploy/release/tick.py': b'print(1)\n',
                      'deploy/release/test_tick.py': b'test\n', 'src/index.ts': b'export {}\n'}
        for path, data in self.files.items():
            os.makedirs(os.path.dirname(os.path.join(self.repo, path)), exist_ok=True)
            with open(os.path.join(self.repo, path), 'wb') as f:
                f.write(data)
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'one')
        self.first = self.head()
        git(self.repo, 'commit', '-q', '--allow-empty', '-m', 'two')
        git(self.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.h = hpa.RealHelpers(self.data, run=bounded.run, locate=self.locate, installed_owner=os.geteuid(),
                                 lib_dir=os.path.join(self.inst, 'deploy', 'release'))

    def head(self):
        return subprocess.run(['git', '-C', self.repo, 'rev-parse', 'HEAD'], check=True, capture_output=True,
                              text=True).stdout.strip()

    def locate(self, path):
        return None if 'test_' in path or path.startswith('src/') else os.path.join(self.inst, path)

    def install(self, path, data):
        dest = os.path.join(self.inst, path)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'wb') as f:
            f.write(data)
        os.chmod(dest, 0o644)
        return dest

    def test_ancestry_in_a_real_clone(self):
        main = self.head()
        self.assertEqual((self.h.is_ancestor(self.first, main), self.h.is_ancestor(main, self.first),
                          self.h.is_ancestor(main, main), self.h.is_ancestor('a' * 40, main)), (True, False, True, False))
        self.assertEqual(self.h.commits(self.first, main), (main,))
        self.assertEqual(self.h.changed_paths(self.first, main), ())

    def test_installed_copies_identical_to_main_are_current(self):
        self.install('deploy/db-snapshot.sh', self.files['deploy/db-snapshot.sh'])
        self.install('deploy/release/tick.py', self.files['deploy/release/tick.py'])
        self.assertIsNone(self.h.installed_stale(('deploy/release/**', 'deploy/db-snapshot.sh', 'src/**')))

    def test_a_different_or_missing_copy_is_named(self):
        self.install('deploy/db-snapshot.sh', b'#!/bin/sh\necho old\n')
        self.assertEqual(self.h.installed_stale(('deploy/release/**', 'deploy/db-snapshot.sh')),
                         'STALE: 2 installed file(s) differ from origin/main:\n'
                         '  deploy/db-snapshot.sh\n'
                         f'  deploy/release/tick.py (not installed at {self.inst}/deploy/release/tick.py)')

    def test_a_longer_copy_differs(self):
        self.install('deploy/db-snapshot.sh', self.files['deploy/db-snapshot.sh'] + b'\n')
        self.assertEqual(self.h.installed_stale(('deploy/db-snapshot.sh',)),
                         'STALE: 1 installed file(s) differ from origin/main:\n  deploy/db-snapshot.sh')

    def test_only_files_of_the_given_patterns_are_compared(self):
        self.install('deploy/release/tick.py', self.files['deploy/release/tick.py'])
        self.assertIsNone(self.h.installed_stale(('deploy/release/**',)))

    def test_a_right_copy_others_could_rewrite_is_stale(self):
        # #828 AI review: what sudo runs must be closed to writes by anyone but its owner.
        os.chmod(self.install('deploy/db-snapshot.sh', self.files['deploy/db-snapshot.sh']), 0o664)
        self.assertEqual(self.h.installed_stale(('deploy/db-snapshot.sh',)),
                         'STALE: 1 installed file(s) differ from origin/main:\n'
                         f'  deploy/db-snapshot.sh ({self.inst}/deploy/db-snapshot.sh is not {os.geteuid()}-owned and '
                         'closed to group/other writes)')

    def test_a_right_copy_of_another_owner_is_stale(self):
        self.install('deploy/db-snapshot.sh', self.files['deploy/db-snapshot.sh'])
        h = hpa.RealHelpers(self.data, run=bounded.run, locate=self.locate, installed_owner=os.geteuid() + 1,
                            lib_dir=os.path.join(self.inst, 'deploy', 'release'))
        self.assertEqual(h.installed_stale(('deploy/db-snapshot.sh',)).splitlines()[1],
                         f'  deploy/db-snapshot.sh ({self.inst}/deploy/db-snapshot.sh is not {os.geteuid() + 1}-owned '
                         'and closed to group/other writes)')

    def test_a_symlink_in_place_of_a_copy_is_stale(self):
        real = self.install('deploy/elsewhere.sh', self.files['deploy/db-snapshot.sh'])
        os.symlink(real, os.path.join(self.inst, 'deploy', 'db-snapshot.sh'))
        self.assertEqual(self.h.installed_stale(('deploy/db-snapshot.sh',)).splitlines()[1],
                         f'  deploy/db-snapshot.sh ({self.inst}/deploy/db-snapshot.sh is a symlink)')

    def test_a_library_file_main_no_longer_has_is_stale(self):
        # #828 AI review: a module deleted from the repository kept running from its installed copy.
        self.install('deploy/release/tick.py', self.files['deploy/release/tick.py'])
        gone = self.install('deploy/release/old_helper.py', b'print(0)\n')
        self.assertEqual(self.h.installed_stale(('deploy/release/**',)),
                         'STALE: 1 installed file(s) differ from origin/main:\n'
                         f'  {gone} (installed, but nothing in origin/main installs it)')

    def test_a_directory_symlink_in_the_library_is_stale(self):
        # #828 AI review, second pass: os.walk does not descend into it.
        self.install('deploy/release/tick.py', self.files['deploy/release/tick.py'])
        elsewhere = os.path.join(self.data, 'elsewhere')
        os.makedirs(elsewhere)
        link = os.path.join(self.inst, 'deploy', 'release', 'pkg')
        os.symlink(elsewhere, link)
        self.assertEqual(self.h.installed_stale(('deploy/release/**',)),
                         'STALE: 1 installed file(s) differ from origin/main:\n'
                         f'  {link} (a symlink inside the installed library)')

    @unittest.skipIf(os.geteuid() == 0, 'root reads a 0000 directory anyway')
    def test_a_library_directory_that_cannot_be_read_is_cannot_assess(self):
        self.install('deploy/release/tick.py', self.files['deploy/release/tick.py'])
        closed = os.path.join(self.inst, 'deploy', 'release', 'closed')
        os.makedirs(closed)
        os.chmod(closed, 0)
        self.addCleanup(os.chmod, closed, 0o755)
        with self.assertRaisesRegex(HelperError, 'PermissionError'):
            self.h.installed_stale(('deploy/release/**',))

    def test_a_copy_that_cannot_be_read_is_cannot_assess(self):
        os.makedirs(os.path.join(self.inst, 'deploy', 'db-snapshot.sh'))
        with self.assertRaisesRegex(HelperError, 'IsADirectoryError'):
            self.h.installed_stale(('deploy/db-snapshot.sh',))

    def test_no_clone_is_cannot_assess(self):
        shutil.rmtree(self.repo)
        with self.assertRaisesRegex(HelperError, '^git ls-tree: exit 128: fatal'):
            self.h.installed_stale(('deploy/db-snapshot.sh',))



class RootDigest(unittest.TestCase):
    """installed_stale on a copy the operator cannot read: root's `digest` instead (plan C-core "Рішення" п.3).

    A real clone; the sudoers copy sits at its production path, where a scripted os.open answers EACCES, and only
    `sudo` goes to a FakeRun — git runs for real."""
    SUDOERS = '/etc/sudoers.d/wbb-release'
    BODY = b'ysi ALL=(root) NOPASSWD: /usr/local/libexec/wbb-release verify --sha *\n'
    # sha256 of BODY, as root would print it
    RIGHT = '14c604660f542eaa5208e4fc6590e8b233c13251c9345df3674a146dda3f6782'

    def setUp(self):
        self.data = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.data)
        self.repo = os.path.join(self.data, 'repo')
        self.readable = os.path.join(self.data, 'installed-sudoers')
        os.makedirs(os.path.join(self.repo, 'deploy', 'sudoers.d'))
        subprocess.run(['git', 'init', '-q', self.repo], check=True)
        for path, data in (('deploy/sudoers.d/wbb-release', self.BODY), ('deploy/db-snapshot.sh', b'#!/bin/sh\n')):
            with open(os.path.join(self.repo, path), 'wb') as f:
                f.write(data)
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'one')
        git(self.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.sudo = FakeRun()
        self.dest = {'deploy/sudoers.d/wbb-release': self.SUDOERS, 'deploy/db-snapshot.sh': '/usr/local/bin/wbb-db-snapshot'}
        self.denied = {self.SUDOERS, '/usr/local/bin/wbb-db-snapshot'}
        self.h = hpa.RealHelpers(self.data, run=self.route, locate=self.dest.get, lib_dir=os.path.join(self.data, 'lib'))

    def route(self, argv, *, timeout, **kw):
        return (self.sudo if argv[0] == 'sudo' else bounded.run)(argv, timeout=timeout, **kw)

    def answer(self, *answers):
        argv = ('sudo', '-n', '/usr/local/libexec/wbb-release', 'digest', '--path', self.SUDOERS)
        self.sudo.answers[argv] = list(answers)

    def stale(self, patterns=('deploy/sudoers.d/**',)):
        real_open = os.open

        def fake_open(path, flags, *args):
            if path in self.denied:
                raise PermissionError(errno.EACCES, 'Permission denied', path)
            return real_open(path, flags, *args)
        with mock.patch.object(hpa.os, 'open', fake_open):
            return self.h.installed_stale(patterns)

    def test_root_s_digest_of_the_right_copy_is_current(self):
        self.answer(done(0, f'DIGEST {self.SUDOERS} {self.RIGHT} uid 0 mode 0440\n'.encode()))
        self.assertIsNone(self.stale())
        self.assertEqual(self.sudo.calls, [(['sudo', '-n', '/usr/local/libexec/wbb-release', 'digest', '--path',
                                             self.SUDOERS], 30)])

    def test_another_digest_is_stale(self):
        self.answer(done(0, f'DIGEST {self.SUDOERS} {"0" * 64} uid 0 mode 0440\n'.encode()))
        self.assertEqual(self.stale(), 'STALE: 1 installed file(s) differ from origin/main:\n  deploy/sudoers.d/wbb-release')

    def test_a_right_digest_of_another_owner_or_open_to_writes_is_stale(self):
        for line in ('uid 1000 mode 0440', 'uid 0 mode 0460', 'uid 0 mode 0442'):
            with self.subTest(line):
                self.answer(done(0, f'DIGEST {self.SUDOERS} {self.RIGHT} {line}\n'.encode()))
                self.assertEqual(self.stale(), 'STALE: 1 installed file(s) differ from origin/main:\n'
                                               f'  deploy/sudoers.d/wbb-release ({self.SUDOERS} is not 0-owned and '
                                               'closed to group/other writes)')

    def test_absent_is_not_installed(self):
        self.answer(done(0, f'ABSENT {self.SUDOERS}\n'.encode()))
        self.assertEqual(self.stale(), 'STALE: 1 installed file(s) differ from origin/main:\n'
                                       f'  deploy/sudoers.d/wbb-release (not installed at {self.SUDOERS})')

    def test_a_helper_that_did_not_answer_is_cannot_assess(self):
        for code, out, err in ((70, b'', b'Traceback\n'), (75, b'', b'busy\n'), (1, b'', b'sudo: a password is required\n'),
                               (2, b'', f'REFUSED: {self.SUDOERS}: a symlink, not an installed copy\n'.encode()),
                               (64, b'', b'usage\n'), (-9, b'', b'')):
            with self.subTest(code):
                self.answer(done(code, out, err))
                with self.assertRaisesRegex(HelperError, f'^wbb-release digest {self.SUDOERS}: exit {code}: '):
                    self.stale()

    def test_an_answer_that_is_not_about_this_path_is_cannot_assess(self):
        for out in (f'DIGEST /etc/sudoers.d/other {self.RIGHT} uid 0 mode 0440\n', 'ABSENT /etc/litestream.yml\n',
                    f'DIGEST {self.SUDOERS} {self.RIGHT} uid 0 mode 440\n', f'DIGEST {self.SUDOERS} {self.RIGHT[:63]} uid 0 mode 0440\n',
                    f'DIGEST {self.SUDOERS} {self.RIGHT} uid 0 mode 0440\nDIGEST {self.SUDOERS} {self.RIGHT} uid 0 mode 0440\n',
                    '', 'OK\n'):
            with self.subTest(out):
                self.answer(done(0, out.encode()))
                with self.assertRaisesRegex(HelperError, f'^wbb-release digest {self.SUDOERS}: unexpected answer'):
                    self.stale()

    def test_a_readable_copy_never_asks_root(self):
        self.dest['deploy/sudoers.d/wbb-release'] = self.readable
        with open(self.readable, 'wb') as f:
            f.write(self.BODY)
        os.chmod(self.readable, 0o440)
        h = hpa.RealHelpers(self.data, run=self.route, locate=self.dest.get, lib_dir=os.path.join(self.data, 'lib'),
                            installed_owner=os.geteuid())
        self.h = h
        self.assertIsNone(self.stale())
        self.assertEqual(self.sudo.calls, [])

    def test_an_unreadable_copy_root_may_not_digest_is_cannot_assess(self):
        """Only sudoers and the litestream config go to root; any other EACCES stays what it was."""
        with self.assertRaisesRegex(HelperError, '^/usr/local/bin/wbb-db-snapshot: PermissionError: Permission denied$'):
            self.stale(('deploy/db-snapshot.sh',))
        self.assertEqual(self.sudo.calls, [])


if __name__ == '__main__':
    unittest.main()
