"""The root helper wbb-image: pull, current, prune, the argv boundary, exit codes, the wrapper.

Plan: docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md, Task 2.
podman and systemctl are never run: main() gets a fake Host whose runner records each argv (with its timeout) and
returns scripted CompletedProcess objects, or raises what it is given.
"""
import contextlib
import dataclasses
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wbb_image as wi  # noqa: E402

REPO = 'ghcr.io/ysilvestrov/warsaw-beer-bot'
X = '0123456789abcdef0123456789abcdef01234567'
OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98'
D1 = 'sha256:' + '1' * 64
D2 = 'sha256:' + '2' * 64
D3 = 'sha256:' + '3' * 64
D4 = 'sha256:' + '4' * 64
I1 = 'a' * 64
I2 = 'b' * 64
I3 = 'c' * 64
I4 = 'd' * 64
CONTENT = 'e' * 64
GIB = 1024 ** 3
# The bot's ids in tests are the test's own: the snapshot must belong to the bot, and only root could chown it.
UID = os.getuid()
GID = os.getgid()
PODMAN = '/fake/bin/podman'
SYSTEMCTL = '/fake/bin/systemctl'


def done(code=0, stdout='', stderr=''):
    return subprocess.CompletedProcess(['scripted'], code, stdout, stderr)


def image_json(**override):
    image = {'Id': I1, 'Digest': D1, 'RepoDigests': [f'{REPO}@{D1}'],
             'Labels': {'org.opencontainers.image.revision': X, 'wbb.content': CONTENT}}
    image.update(override)
    return json.dumps([image])


class FakeRunner:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, argv, *, timeout, text=False, **kwargs):
        self.calls.append((list(argv), timeout, text))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        if callable(response):
            # A step that looks at the host while "running" (the scratch copy), then answers.
            return response(argv)
        return response


class HelperCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.quadlet = os.path.join(self.dir, 'warsaw-beer-bot.container')
        self.free_asked = []
        self.free = 100 * GIB
        self.template = os.path.join(self.dir, 'template')
        self.snapshots = os.path.join(self.dir, 'snap')
        self.scratch = os.path.join(self.dir, 'scratch')
        os.mkdir(self.snapshots)
        os.mkdir(self.scratch, 0o700)
        os.chmod(self.scratch, 0o700)
        self.chowns = []
        self.scratch_owner = UID
        self.bot = (UID, GID)

    def host(self, runner):
        def free_bytes(path):
            self.free_asked.append(path)
            return self.free
        return wi.Host(podman=PODMAN, systemctl=SYSTEMCTL, run=runner, quadlet_path=self.quadlet,
                       template_path=self.template, snapshot_root=self.snapshots, scratch_root=self.scratch,
                       containers_root='/fake/containers', free_bytes=free_bytes, bot_ids=lambda: self.bot,
                       fchown=lambda fd, uid, gid: self.chowns.append((os.readlink(f'/proc/self/fd/{fd}'), uid, gid)),
                       scratch_owner=self.scratch_owner, pid=lambda: 4242)

    def main(self, argv, runner):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = wi.main(argv, self.host(runner))
        return code, out.getvalue(), err.getvalue()

    def write_quadlet(self, text):
        with open(self.quadlet, 'w', encoding='utf-8') as f:
            f.write(text)

    def argvs(self, runner):
        return [argv for argv, _, _ in runner.calls]


class Validators(unittest.TestCase):
    def test_sha_takes_exactly_40_lowercase_hex(self):
        self.assertEqual(wi.check_sha(X), X)
        for bad in (X.upper(), X[:39], X + '0', X[:39] + 'g', X + '\n', '', f'{X[:20]}/{X[21:]}'):
            with self.subTest(bad=bad):
                with self.assertRaises(wi.Refused):
                    wi.check_sha(bad)

    def test_digest_takes_sha256_and_exactly_64_lowercase_hex(self):
        self.assertEqual(wi.check_digest(D1), D1)
        for bad in ('sha256:' + '1' * 63, 'sha256:' + '1' * 65, 'sha256:' + 'A' * 64, '1' * 64,
                    'sha512:' + '1' * 64, 'SHA256:' + '1' * 64, D1 + '\n', f'{REPO}@{D1}', D1 + ' --x', ''):
            with self.subTest(bad=bad):
                with self.assertRaises(wi.Refused):
                    wi.check_digest(bad)

    def test_snapshot_is_a_name_with_a_7_to_40_hex_sha_and_pre_db(self):
        for good in ('20261012T101500Z-abcdef1-pre.db', f'20261012T101500Z-{X}-pre.db'):
            with self.subTest(good=good):
                self.assertEqual(wi.check_snapshot_name(good), good)
        for bad in ('20261012T101500Z-abcdef-pre.db', f'20261012T101500Z-{X}0-pre.db',
                    '20261012T101500Z-abcdef1.db', '20261012T101500Z-abcdef1-pre.db.x',
                    '20261012T101500Z-ABCDEF1-pre.db', '2026101T101500Z-abcdef1-pre.db',
                    '../20261012T101500Z-abcdef1-pre.db', 'x/20261012T101500Z-abcdef1-pre.db',
                    '/var/lib/x/20261012T101500Z-abcdef1-pre.db', '..', '20261012T101500Z-abcdef1-pre.db\n', ''):
            with self.subTest(bad=bad):
                with self.assertRaises(wi.Refused):
                    wi.check_snapshot_name(bad)


PULL_ARGV = [PODMAN, 'pull', f'{REPO}@{D1}']
INSPECT_ARGV = [PODMAN, 'image', 'inspect', f'{REPO}@{D1}', '--format', 'json']


class Pull(HelperCase):
    def test_pulls_by_digest_checks_the_image_and_prints_its_identity(self):
        runner = FakeRunner(done(), done(stdout=image_json()))
        self.assertEqual(self.main(['pull', '--sha', X, '--digest', D1], runner),
                         (0, f'PULLED {D1} {I1} content={CONTENT} revision={X}\n', ''))
        self.assertEqual(runner.calls, [(PULL_ARGV, 600, True), (INSPECT_ARGV, 60, True)])
        self.assertEqual(self.free_asked, ['/fake/containers'])

    def test_exactly_5_gib_free_is_enough(self):
        self.free = 5 * GIB
        runner = FakeRunner(done(), done(stdout=image_json()))
        self.assertEqual(self.main(['pull', '--sha', X, '--digest', D1], runner)[0], 0)
        self.assertEqual(self.argvs(runner), [PULL_ARGV, INSPECT_ARGV])

    def test_less_than_5_gib_free_is_refused_without_any_podman_call(self):
        self.free = 5 * GIB - 1
        runner = FakeRunner()
        self.assertEqual(self.main(['pull', '--sha', X, '--digest', D1], runner),
                         (2, '', f'REFUSED: {5 * GIB - 1} bytes free on /fake/containers, a pull needs {5 * GIB} '
                                 '(prune old images; nothing was removed)\n'))
        self.assertEqual(runner.calls, [])

    def test_an_invalid_sha_or_digest_is_refused_before_anything_is_asked(self):
        for argv, message in (
            (['pull', '--sha', X.upper(), '--digest', D1], f'REFUSED: not a full lowercase commit SHA: {X.upper()!r}\n'),
            (['pull', '--sha', X, '--digest', D1[:-1]], f'REFUSED: not a sha256:<64 lowercase hex> digest: {D1[:-1]!r}\n'),
        ):
            with self.subTest(argv=argv):
                runner = FakeRunner()
                self.free_asked = []
                self.assertEqual(self.main(argv, runner), (2, '', message))
                self.assertEqual((runner.calls, self.free_asked), ([], []))

    def test_every_mismatch_of_the_pulled_image_is_refused_naming_what_was_seen(self):
        ref = f'{REPO}@{D1}'
        rev = 'org.opencontainers.image.revision'
        cases = [
            ('digest', image_json(Digest=D2), f'{ref}: pulled image has Digest {D2!r}, expected {D1}'),
            ('no digest', image_json(Digest=None), f'{ref}: pulled image has Digest None, expected {D1}'),
            ('repo digests', image_json(RepoDigests=[f'ghcr.io/someone/else@{D1}']),
             f"{ref}: RepoDigests ['ghcr.io/someone/else@{D1}'] do not name it — not an image of {REPO}"),
            ('no repo digests', image_json(RepoDigests=None),
             f'{ref}: RepoDigests [] do not name it — not an image of {REPO}'),
            ('revision', image_json(Labels={rev: OTHER_SHA, 'wbb.content': CONTENT}),
             f'{ref}: label {rev} is {OTHER_SHA}, expected {X}'),
            ('no revision', image_json(Labels={'wbb.content': CONTENT}), f'{ref}: label {rev} is None, not a full SHA'),
            ('short revision', image_json(Labels={rev: X[:7], 'wbb.content': CONTENT}),
             f"{ref}: label {rev} is '{X[:7]}', not a full SHA"),
            ('no labels', image_json(Labels=None), f'{ref}: label {rev} is None, not a full SHA'),
            ('no content', image_json(Labels={rev: X}), f'{ref}: label wbb.content is None, not 64 hex'),
            ('bad content', image_json(Labels={rev: X, 'wbb.content': 'x y'}),
             f"{ref}: label wbb.content is 'x y', not 64 hex"),
            ('bad id', image_json(Id='zz'), f"{ref}: image Id 'zz' is not 64 hex"),
            ('not json', 'oops', f"podman image inspect of {ref}: not JSON: 'oops'"),
            ('two images', json.dumps([{}, {}]), f"podman image inspect of {ref}: expected one image, got '[{{}}, {{}}]'"),
            ('object', json.dumps({}), f"podman image inspect of {ref}: expected one image, got '{{}}'"),
        ]
        for name, inspect, message in cases:
            with self.subTest(name):
                runner = FakeRunner(done(), done(stdout=inspect))
                self.assertEqual(self.main(['pull', '--sha', X, '--digest', D1], runner), (2, '', f'REFUSED: {message}\n'))
                self.assertEqual(self.argvs(runner), [PULL_ARGV, INSPECT_ARGV])

    def test_a_failed_pull_is_tempfail_with_its_stderr_and_nothing_after_it(self):
        runner = FakeRunner(done(125, stderr='Error: initializing source: connection refused\n'))
        self.assertEqual(self.main(['pull', '--sha', X, '--digest', D1], runner),
                         (75, '', f'TEMPFAIL: podman pull {REPO}@{D1} exited 125: '
                                  'Error: initializing source: connection refused\n'))
        self.assertEqual(self.argvs(runner), [PULL_ARGV])

    def test_the_stderr_tail_is_bounded(self):
        runner = FakeRunner(done(1, stderr='x' * 5000 + 'END'))
        code, _, err = self.main(['pull', '--sha', X, '--digest', D1], runner)
        self.assertEqual((code, err), (75, f'TEMPFAIL: podman pull {REPO}@{D1} exited 1: ' + 'x' * 1997 + 'END\n'))

    def test_a_multi_line_reason_stays_one_verdict_line(self):
        runner = FakeRunner(done(125, stderr='Error: initializing source\nTEMPFAIL: not ours\nREFUSED: neither\n'))
        self.assertEqual(self.main(['pull', '--sha', X, '--digest', D1], runner),
                         (75, '', f'TEMPFAIL: podman pull {REPO}@{D1} exited 125: Error: initializing source '
                                  'TEMPFAIL: not ours REFUSED: neither\n'))

    def test_a_pull_that_times_out_is_tempfail(self):
        runner = FakeRunner(subprocess.TimeoutExpired(PULL_ARGV, 600))
        self.assertEqual(self.main(['pull', '--sha', X, '--digest', D1], runner),
                         (75, '', f'TEMPFAIL: podman pull {REPO}@{D1} timed out after 600s\n'))
        self.assertEqual(self.argvs(runner), [PULL_ARGV])

    def test_an_image_podman_does_not_know_after_the_pull_is_refused(self):
        runner = FakeRunner(done(), done(125, stderr=f'Error: {REPO}@{D1}: image not known\n'))
        self.assertEqual(self.main(['pull', '--sha', X, '--digest', D1], runner),
                         (2, '', f'REFUSED: {REPO}@{D1} is not a local image\n'))

    def test_an_inspect_that_fails_otherwise_is_tempfail(self):
        runner = FakeRunner(done(), done(125, stderr='Error: database is locked\n'))
        self.assertEqual(self.main(['pull', '--sha', X, '--digest', D1], runner),
                         (75, '', 'TEMPFAIL: podman image inspect exited 125: Error: database is locked\n'))


class Local(HelperCase):
    """`local`: is D here already — `image inspect` only, no pull, no free-space check (plan b-core п.10)."""

    def test_an_image_of_ours_that_is_here(self):
        runner = FakeRunner(done(stdout=image_json()))
        self.assertEqual(self.main(['local', '--digest', D1], runner),
                         (0, f'LOCAL {D1} {I1} content={CONTENT} revision={X}\n', ''))
        self.assertEqual((runner.calls, self.free_asked), ([(INSPECT_ARGV, 60, True)], []))

    def test_the_revision_printed_is_the_images_own_label(self):
        runner = FakeRunner(done(stdout=image_json(Labels={'org.opencontainers.image.revision': OTHER_SHA,
                                                           'wbb.content': CONTENT})))
        self.assertEqual(self.main(['local', '--digest', D1], runner),
                         (0, f'LOCAL {D1} {I1} content={CONTENT} revision={OTHER_SHA}\n', ''))

    def test_no_image_at_the_digest_is_not_local_exit_3(self):
        for stderr in (f'Error: {REPO}@{D1}: image not known\n', 'Error: no such image\n'):
            with self.subTest(stderr=stderr):
                runner = FakeRunner(done(125, stderr=stderr))
                self.assertEqual(self.main(['local', '--digest', D1], runner), (3, f'NOT LOCAL {D1}\n', ''))
                self.assertEqual(self.argvs(runner), [INSPECT_ARGV])

    def test_an_image_that_is_not_ours_is_refused(self):
        ref = f'{REPO}@{D1}'
        rev = 'org.opencontainers.image.revision'
        for name, inspect, message in (
            ('repo digests', image_json(RepoDigests=[f'ghcr.io/someone/else@{D1}']),
             f"{ref}: RepoDigests ['ghcr.io/someone/else@{D1}'] do not name it — not an image of {REPO}"),
            ('no revision', image_json(Labels={'wbb.content': CONTENT}), f'{ref}: label {rev} is None, not a full SHA'),
            ('no content', image_json(Labels={rev: X}), f'{ref}: label wbb.content is None, not 64 hex'),
            ('bad id', image_json(Id='zz'), f"{ref}: image Id 'zz' is not 64 hex"),
            ('not json', 'oops', f"podman image inspect of {ref}: not JSON: 'oops'"),
        ):
            with self.subTest(name):
                runner = FakeRunner(done(stdout=inspect))
                self.assertEqual(self.main(['local', '--digest', D1], runner), (2, '', f'REFUSED: {message}\n'))
                self.assertEqual(self.argvs(runner), [INSPECT_ARGV])

    def test_a_failing_inspect_is_tempfail(self):
        runner = FakeRunner(done(125, stderr='Error: database is locked\n'))
        self.assertEqual(self.main(['local', '--digest', D1], runner),
                         (75, '', 'TEMPFAIL: podman image inspect exited 125: Error: database is locked\n'))

    def test_an_inspect_that_times_out_is_tempfail(self):
        runner = FakeRunner(subprocess.TimeoutExpired('podman', 60))
        self.assertEqual(self.main(['local', '--digest', D1], runner),
                         (75, '', 'TEMPFAIL: podman image inspect timed out after 60s\n'))

    def test_an_invalid_digest_is_refused_before_any_call(self):
        runner = FakeRunner()
        self.assertEqual(self.main(['local', '--digest', D1.upper()], runner),
                         (2, '', f'REFUSED: not a sha256:<64 lowercase hex> digest: {D1.upper()!r}\n'))
        self.assertEqual(runner.calls, [])

    def test_not_local_is_still_a_refusal_for_every_other_action(self):
        runner = FakeRunner(done(125, stderr='Error: image not known\n'))
        self.assertEqual(self.main(['audit', '--digest', D1], runner),
                         (2, '', f'REFUSED: {REPO}@{D1} is not a local image\n'))


class InspectOurs(HelperCase):
    """The check trial/audit/activate rely on: the image's own Digest is not part of it (pull checks that)."""

    def test_returns_the_inspect_data_of_an_image_of_our_repository(self):
        runner = FakeRunner(done(stdout=image_json(Digest=D2)))
        self.assertEqual(wi.inspect_ours(self.host(runner), D1), json.loads(image_json(Digest=D2))[0])
        self.assertEqual(runner.calls, [(INSPECT_ARGV, 60, True)])


SHOW_ARGV = [SYSTEMCTL, 'show', 'warsaw-beer-bot.service', '-p', 'LoadState,SourcePath,FragmentPath']
CONTAINER_ARGV = [PODMAN, 'container', 'inspect', 'warsaw-beer-bot', '--format', '{{.Image}} {{.ImageDigest}}']
NO_CONTAINER = done(125, stderr='Error: no such container warsaw-beer-bot\n')


def show(load, source, fragment):
    # systemctl prints the properties in its own order, not the one asked for.
    return done(stdout=f'FragmentPath={fragment}\nLoadState={load}\nSourcePath={source}\n')


class Current(HelperCase):
    def quadlet_show(self):
        return show('loaded', self.quadlet, '/run/systemd/generator/warsaw-beer-bot.service')

    def test_a_quadlet_unit_running_its_image(self):
        self.write_quadlet(f'[Container]\nContainerName=warsaw-beer-bot\nImage={REPO}@{D1}\nPull=never\n')
        runner = FakeRunner(done(stdout=f'{I1} {D1}\n'), self.quadlet_show())
        self.assertEqual(self.main(['current'], runner),
                         (0, f'CURRENT quadlet={D1} container-image={I1} container-digest={D1} unit=quadlet\n', ''))
        self.assertEqual(runner.calls, [(CONTAINER_ARGV, 60, True), (SHOW_ARGV, 30, True)])

    def test_nothing_yet_no_file_no_container_no_unit(self):
        runner = FakeRunner(NO_CONTAINER, show('not-found', '', ''))
        self.assertEqual(self.main(['current'], runner),
                         (0, 'CURRENT quadlet=none container-image=none container-digest=none unit=absent\n', ''))
        self.assertEqual(self.argvs(runner), [CONTAINER_ARGV, SHOW_ARGV])

    def test_the_old_unit_in_etc_is_foreign(self):
        runner = FakeRunner(NO_CONTAINER, show('loaded', '', '/etc/systemd/system/warsaw-beer-bot.service'))
        self.assertEqual(self.main(['current'], runner),
                         (0, 'CURRENT quadlet=none container-image=none container-digest=none unit=foreign\n', ''))

    def test_foreign_whenever_one_of_the_two_paths_is_not_ours(self):
        for name, response in (
            ('a unit in /etc shadows the generated one', show('loaded', self.quadlet, '/etc/systemd/system/x.service')),
            ('generated from another file', show('loaded', '/etc/containers/systemd/other.container',
                                                 '/run/systemd/generator/warsaw-beer-bot.service')),
            ('a generator path only as a prefix of the name', show('loaded', self.quadlet, '/run/systemd/generator.x/w')),
            ('masked', show('masked', '', '/dev/null')),
        ):
            with self.subTest(name):
                runner = FakeRunner(NO_CONTAINER, response)
                self.assertEqual(self.main(['current'], runner)[:2],
                                 (0, 'CURRENT quadlet=none container-image=none container-digest=none unit=foreign\n'))

    def test_systemctl_failing_is_tempfail(self):
        runner = FakeRunner(NO_CONTAINER, done(1, stderr='Failed to connect to bus\n'))
        self.assertEqual(self.main(['current'], runner),
                         (75, '', 'TEMPFAIL: systemctl show exited 1: Failed to connect to bus\n'))

    def test_systemctl_output_without_a_load_state_is_refused(self):
        runner = FakeRunner(NO_CONTAINER, done(stdout='SourcePath=\n'))
        self.assertEqual(self.main(['current'], runner),
                         (2, '', "REFUSED: systemctl show warsaw-beer-bot.service: no LoadState in 'SourcePath='\n"))

    def test_podman_failing_otherwise_than_no_such_container_is_tempfail_not_none(self):
        runner = FakeRunner(done(125, stderr='Error: database is locked\n'))
        self.assertEqual(self.main(['current'], runner),
                         (75, '', 'TEMPFAIL: podman container inspect exited 125: Error: database is locked\n'))
        self.assertEqual(self.argvs(runner), [CONTAINER_ARGV])

    def test_a_container_inspect_it_cannot_read_is_refused(self):
        for stdout in (f'{I1}\n', f'{I1} {D1} x\n', f'{I1} {D1[:-1]}\n', f'{I1[:-1]} {D1}\n', '\n'):
            with self.subTest(stdout=stdout):
                runner = FakeRunner(done(stdout=stdout))
                self.assertEqual(self.main(['current'], runner),
                                 (2, '', f'REFUSED: podman container inspect warsaw-beer-bot: unexpected '
                                         f'{stdout.strip()!r}\n'))

    def test_a_quadlet_file_it_cannot_read_is_refused_before_any_call(self):
        q = self.quadlet
        for text, message in (
            (f'Image={REPO}:latest\n', f"{q}: 'Image={REPO}:latest' is not Image={REPO}@sha256:<64 hex>"),
            (f'Image=ghcr.io/someone/else@{D1}\n',
             f"{q}: 'Image=ghcr.io/someone/else@{D1}' is not Image={REPO}@sha256:<64 hex>"),
            (f'Image={REPO}@{D1[:-1]}\n', f"{q}: 'Image={REPO}@{D1[:-1]}' is not Image={REPO}@sha256:<64 hex>"),
            (f'Image={REPO}@{D1}\nImage={REPO}@{D2}\n', f'{q}: expected exactly one Image= line, found 2'),
            ('[Container]\nPull=never\n', f'{q}: expected exactly one Image= line, found 0'),
        ):
            with self.subTest(text=text):
                self.write_quadlet(text)
                runner = FakeRunner()
                self.assertEqual(self.main(['current'], runner), (2, '', f'REFUSED: {message}\n'))
                self.assertEqual(runner.calls, [])

    def test_a_quadlet_file_that_is_a_symlink_is_refused(self):
        target = os.path.join(self.dir, 'elsewhere')
        with open(target, 'w', encoding='utf-8') as f:
            f.write(f'Image={REPO}@{D1}\n')
        os.symlink(target, self.quadlet)
        runner = FakeRunner()
        self.assertEqual(self.main(['current'], runner),
                         (2, '', f'REFUSED: {self.quadlet}: Too many levels of symbolic links\n'))
        self.assertEqual(runner.calls, [])

    def test_a_quadlet_path_that_is_a_directory_is_refused(self):
        os.mkdir(self.quadlet)
        self.assertEqual(self.main(['current'], FakeRunner()), (2, '', f'REFUSED: {self.quadlet}: not a regular file\n'))


IMAGES_ARGV = [PODMAN, 'images', '--filter', f'reference={REPO}', '--format', 'json']


def rmi(image_id):
    return [PODMAN, 'rmi', image_id]


def listed(*images):
    """`podman images --format json`: one entry per image, its names under RepoDigests."""
    return done(stdout=json.dumps([{'Id': image_id, 'Digest': digest, 'RepoDigests': names, 'Names': [f'{REPO}']}
                                   for image_id, digest, names in images]))


def at(*digests):
    return [f'{REPO}@{d}' for d in digests]


class Prune(HelperCase):
    def test_removes_what_is_neither_kept_nor_pinned_and_counts_a_failed_rmi_as_skipped(self):
        self.write_quadlet(f'Image={REPO}@{D2}\n')
        runner = FakeRunner(listed((I1, D1, at(D1)), (I2, D2, at(D2)), (I3, D3, at(D3)), (I4, D4, at(D4))),
                            done(), done(2, stderr='Error: image is in use by a container\n'))
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 1 skipped 1 kept {D1} {D2}\n', ''))
        self.assertEqual(runner.calls, [(IMAGES_ARGV, 60, True), (rmi(I3), 120, True), (rmi(I4), 120, True)])

    def test_never_removes_the_quadlet_files_image_even_without_keep(self):
        self.write_quadlet(f'[Container]\nImage={REPO}@{D2}\n')
        runner = FakeRunner(listed((I2, D2, at(D2))))
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 0 skipped 0 kept {D1} {D2}\n', ''))
        self.assertEqual(self.argvs(runner), [IMAGES_ARGV])

    def test_several_keeps_and_no_quadlet_file(self):
        runner = FakeRunner(listed((I1, D1, at(D1)), (I2, D2, at(D2)), (I3, D3, at(D3))), done())
        self.assertEqual(self.main(['prune', '--keep', D2, '--keep', D1], runner),
                         (0, f'PRUNED 1 skipped 0 kept {D1} {D2}\n', ''))
        self.assertEqual(self.argvs(runner), [IMAGES_ARGV, rmi(I3)])

    def test_an_image_is_kept_when_any_of_its_repo_digests_is_kept(self):
        # Its own Digest is D3, but it is also known as D1 (pulled twice, or a manifest list): rmi takes the image.
        runner = FakeRunner(listed((I1, D3, at(D3, D1))))
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 0 skipped 0 kept {D1}\n', ''))
        self.assertEqual(self.argvs(runner), [IMAGES_ARGV])

    def test_an_image_is_kept_when_its_digest_is_pinned_though_no_repo_digest_says_so(self):
        self.write_quadlet(f'Image={REPO}@{D2}\n')
        runner = FakeRunner(listed((I2, D2, [])))
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 0 skipped 0 kept {D1} {D2}\n', ''))
        self.assertEqual(self.argvs(runner), [IMAGES_ARGV])

    def test_an_image_listed_twice_is_removed_once(self):
        runner = FakeRunner(listed((I3, D3, at(D3)), (I3, D3, at(D3))), done())
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 1 skipped 0 kept {D1}\n', ''))
        self.assertEqual(self.argvs(runner), [IMAGES_ARGV, rmi(I3)])

    def test_null_repo_digests_are_no_names(self):
        runner = FakeRunner(done(stdout=json.dumps([{'Id': I3, 'Digest': D3, 'RepoDigests': None}])), done())
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 1 skipped 0 kept {D1}\n', ''))
        self.assertEqual(self.argvs(runner), [IMAGES_ARGV, rmi(I3)])

    def test_nothing_listed(self):
        runner = FakeRunner(done(stdout='[]'))
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 0 skipped 0 kept {D1}\n', ''))

    def test_a_listing_it_cannot_read_removes_nothing(self):
        good = {'Id': I4, 'Digest': D4, 'RepoDigests': at(D4)}
        for name, stdout in (
            ('not json', 'oops'),
            ('an object', json.dumps({'Id': I3})),
            ('an entry that is a string', json.dumps([good, I3])),
            ('a short id', json.dumps([good, {'Id': I3[:12], 'Digest': D3, 'RepoDigests': at(D3)}])),
            ('a prefixed id', json.dumps([good, {'Id': f'sha256:{I3}', 'Digest': D3, 'RepoDigests': at(D3)}])),
            ('no digest', json.dumps([good, {'Id': I3, 'RepoDigests': at(D3)}])),
            ('a bad digest', json.dumps([good, {'Id': I3, 'Digest': '<none>', 'RepoDigests': at(D3)}])),
            ('a repo digest without @', json.dumps([good, {'Id': I3, 'Digest': D3, 'RepoDigests': [REPO]}])),
            ('a repo digest with a tag', json.dumps([good, {'Id': I3, 'Digest': D3, 'RepoDigests': [f'{REPO}:x']}])),
            ('repo digests not a list', json.dumps([good, {'Id': I3, 'Digest': D3, 'RepoDigests': f'{REPO}@{D3}'}])),
        ):
            with self.subTest(name):
                runner = FakeRunner(done(stdout=stdout))
                code, out, err = self.main(['prune', '--keep', D1], runner)
                self.assertEqual((code, out, err.startswith('REFUSED: podman images: ')), (2, '', True))
                self.assertEqual(self.argvs(runner), [IMAGES_ARGV])

    def test_a_failing_listing_is_tempfail(self):
        runner = FakeRunner(done(125, stderr='Error: boom\n'))
        self.assertEqual(self.main(['prune', '--keep', D1], runner),
                         (75, '', 'TEMPFAIL: podman images exited 125: Error: boom\n'))

    def test_a_timed_out_rmi_is_tempfail(self):
        runner = FakeRunner(listed((I3, D3, at(D3))), subprocess.TimeoutExpired(rmi(I3), 120))
        self.assertEqual(self.main(['prune', '--keep', D1], runner),
                         (75, '', f'TEMPFAIL: podman rmi {I3} timed out after 120s\n'))

    def test_an_invalid_keep_is_refused_before_any_call(self):
        runner = FakeRunner()
        self.assertEqual(self.main(['prune', '--keep', D1, '--keep', 'latest'], runner),
                         (2, '', "REFUSED: not a sha256:<64 lowercase hex> digest: 'latest'\n"))
        self.assertEqual(runner.calls, [])

    def test_a_quadlet_file_it_cannot_read_is_refused_before_any_call(self):
        self.write_quadlet(f'Image={REPO}:latest\n')
        runner = FakeRunner()
        self.assertEqual(self.main(['prune', '--keep', D1], runner),
                         (2, '', f"REFUSED: {self.quadlet}: 'Image={REPO}:latest' is not Image={REPO}@sha256:<64 hex>\n"))
        self.assertEqual(runner.calls, [])


class Usage(HelperCase):
    def test_usage_errors_exit_64_and_call_nothing(self):
        for argv in ([], ['frobnicate'], ['current', 'extra'], ['current', '--sha', X], ['prune'],
                     ['pull', '--sha', X], ['pull', '--digest', D1], ['pull', '--sha', X, '--digest', D1, 'x'],
                     ['prune', '--keep'], ['-h'], ['--help'], ['pull', '-h'], ['current', '--help'],
                     ['prune', '--keep', D1, '-h'], ['local'], ['local', '--digest', D1, '--sha', X]):
            with self.subTest(argv=argv):
                runner = FakeRunner()
                code, out, _ = self.main(argv, runner)
                self.assertEqual((code, out, runner.calls, self.free_asked), (64, '', [], []))


class InternalError(HelperCase):
    def test_an_exception_inside_exits_70_with_a_traceback(self):
        runner = FakeRunner(RuntimeError('boom'))
        code, out, err = self.main(['current'], runner)
        lines = err.splitlines()
        self.assertEqual((code, out, lines[0], lines[-1]),
                         (70, '', 'Traceback (most recent call last):', 'RuntimeError: boom'))

    def test_a_failing_free_space_check_exits_70(self):
        def free_bytes(path):
            raise FileNotFoundError(2, 'No such file or directory', path)
        host = dataclasses.replace(self.host(FakeRunner()), free_bytes=free_bytes)
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            code = wi.main(['pull', '--sha', X, '--digest', D1], host)
        self.assertEqual((code, err.getvalue().splitlines()[-1]),
                         (70, "FileNotFoundError: [Errno 2] No such file or directory: '/fake/containers'"))


class Production(unittest.TestCase):
    def test_the_production_host(self):
        p = wi.PRODUCTION
        self.assertEqual((p.podman, p.systemctl, p.quadlet_path, p.template_path, p.snapshot_root, p.scratch_root,
                          p.containers_root, p.run, p.fchown, p.scratch_owner, p.pid),
                         ('/usr/bin/podman', '/usr/bin/systemctl', '/etc/containers/systemd/warsaw-beer-bot.container',
                          '/usr/local/lib/wbb-image/warsaw-beer-bot.container',
                          '/var/lib/warsaw-beer-bot/deploy-snapshots', '/var/lib/wbb-image', '/var/lib/containers',
                          wi.bounded.run, os.fchown, 0, os.getpid))

    def test_the_host_is_frozen(self):
        with self.assertRaises(AttributeError):
            wi.PRODUCTION.podman = '/tmp/podman'


# --- Task 3: trial, audit, activate ---

REV = 'org.opencontainers.image.revision'
SNAP = '20261012T101500Z-0123456-pre.db'
SNAP_BYTES = b'SQLite format 3\x00 a pre snapshot'
# sha256sum of SNAP_BYTES, as db-snapshot.sh writes it into <snapshot>.sha256.
SNAP_SHA256 = '8302bd00edad6b83049b588aeb8e7e72a0b712adbad091a47612801404fb12e0'
INSPECT_D1 = done(stdout=image_json())
INSPECT_D2 = done(stdout=image_json(Id=I2, Digest=D2, RepoDigests=[f'{REPO}@{D2}'],
                                    Labels={REV: OTHER_SHA, 'wbb.content': CONTENT}))
INSPECT_D2_ARGV = [PODMAN, 'image', 'inspect', f'{REPO}@{D2}', '--format', 'json']
TRIAL_OK = done(stdout='TRIAL OK: schema 46 -> 47\n')
START_OK = done(stdout=f'START OK {X}\noutput tail:\n')
COMPAT_OK = done(stdout=f'START OK {OTHER_SHA}\n')
TRIAL_ARGV = ['trial', '--digest', D1, '--previous', D2, '--snapshot', SNAP]


def removed(step, action='trial'):
    return [PODMAN, 'rm', '-f', '-i', f'wbb-image-{action}-4242-{step}']


def isolated(name, scratch):
    """The confinement of a trial step ("Рішення" п.8), written out: it is the security boundary."""
    return [PODMAN, 'run', '--name', name, '--rm', '--pull=never', '--network=none', '--read-only',
            '--tmpfs', '/tmp', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', f'{UID}:{GID}',
            '--memory=1g', '--pids-limit=256', '-v', f'{scratch}:/data',
            '-e', 'TELEGRAM_BOT_TOKEN=123456:abcdefghij', '-e', 'OSRM_BASE_URL=http://x',
            '-e', 'NOMINATIM_USER_AGENT=x', '-e', 'DATABASE_PATH=/data/app.db', '-e', 'WBB_RELEASE_REQUIRED=true',
            '-e', 'API_PORT=3000']


class Trial(HelperCase):
    def setUp(self):
        super().setUp()
        self.snap = os.path.join(self.snapshots, SNAP)
        with open(self.snap, 'wb') as f:
            f.write(SNAP_BYTES)
        with open(self.snap + '.sha256', 'w', encoding='ascii') as f:
            f.write(SNAP_SHA256 + '\n')
        self.seen = []

    def look(self, response):
        """While the first step runs: what the scratch directory holds."""
        def step(argv):
            scratch = argv[argv.index('-v') + 1].removesuffix(':/data')
            db = os.path.join(scratch, 'app.db')
            with open(db, 'rb') as f:
                self.seen.append((os.path.dirname(scratch), stat.S_IMODE(os.stat(scratch).st_mode),
                                  stat.S_IMODE(os.stat(db).st_mode), f.read(), list(self.chowns)))
            return response
        return step

    def scratch_of(self, runner):
        argv = runner.calls[2][0]
        return argv[argv.index('-v') + 1].removesuffix(':/data')

    def test_migrates_starts_and_starts_the_previous_image_on_one_private_copy(self):
        runner = FakeRunner(INSPECT_D1, INSPECT_D2, self.look(TRIAL_OK), done(), START_OK, done(), COMPAT_OK, done())
        self.assertEqual(self.main(TRIAL_ARGV, runner),
                         (0, f'TRIAL OK: schema 46 -> 47\nSTART OK {X}\nCOMPAT OK {D2}\n', ''))
        scratch = self.scratch_of(runner)
        start = ['node', 'deploy/image/start-check.cjs', '--leave-running', '--timeout', '90']
        self.assertEqual(runner.calls, [
            (INSPECT_ARGV, 60, True),
            (INSPECT_D2_ARGV, 60, True),
            (isolated('wbb-image-trial-4242-migrate', scratch)
             + [f'{REPO}@{D1}', 'node', 'deploy/trial-migrate.cjs', '/app', '/data/app.db'], 180, True),
            (removed('migrate'), 60, True),
            (isolated('wbb-image-trial-4242-start', scratch) + [f'{REPO}@{D1}', *start], 150, True),
            (removed('start'), 60, True),
            (isolated('wbb-image-trial-4242-compat', scratch) + [f'{REPO}@{D2}', *start], 150, True),
            (removed('compat'), 60, True),
        ])
        db = os.path.join(scratch, 'app.db')
        self.assertEqual(self.seen, [(self.scratch, 0o700, 0o600, SNAP_BYTES,
                                      [(db, UID, GID), (scratch, UID, GID)])])
        self.assertEqual(os.listdir(self.scratch), [])

    def test_the_previous_image_may_be_the_candidate_itself(self):
        runner = FakeRunner(INSPECT_D1, INSPECT_D1, TRIAL_OK, done(), START_OK, done(), START_OK, done())
        self.assertEqual(self.main(['trial', '--digest', D1, '--previous', D1, '--snapshot', SNAP], runner),
                         (0, f'TRIAL OK: schema 46 -> 47\nSTART OK {X}\nCOMPAT OK {D1}\n', ''))

    PREFIX = {
        'migrate': [INSPECT_D1, INSPECT_D2],
        'start': [INSPECT_D1, INSPECT_D2, TRIAL_OK, done()],
        'compat': [INSPECT_D1, INSPECT_D2, TRIAL_OK, done(), START_OK, done()],
    }
    PRINTED = {
        'migrate': '',
        'start': 'TRIAL OK: schema 46 -> 47\n',
        'compat': f'TRIAL OK: schema 46 -> 47\nSTART OK {X}\n',
    }
    STARTED = {
        'migrate': ['migrate'],
        'start': ['migrate', 'start'],
        'compat': ['migrate', 'start', 'compat'],
    }

    def test_every_exit_of_every_step_has_its_verdict(self):
        rows = [
            # step, the step's answer, exit, what it adds to stdout, stderr (a REFUSED/TEMPFAIL line comes first:
            # the controller reads it as the first line of stderr; the step's output tail follows it)
            ('migrate', done(1, 'TRIAL FAILED: no such table: x\n', 'at migrate\n'), 1,
             'TRIAL FAILED: no such table: x\n', '[trial exited 1]\nTRIAL FAILED: no such table: x\nat migrate\n'),
            ('migrate', done(0, 'migrated\n'), 2, '',
             f"REFUSED: trial-migrate in {D1} exited 0 with 'migrated', not TRIAL OK\n[trial exited 0]\nmigrated\n"),
            ('migrate', done(64, '', 'usage: trial-migrate <clone_dir> <db_copy>\n'), 75, '',
             f'TEMPFAIL: trial-migrate in {D1} exited 64\n'
             '[trial exited 64]\nusage: trial-migrate <clone_dir> <db_copy>\n'),
            ('migrate', done(137), 75, '', f'TEMPFAIL: trial-migrate in {D1} exited 137\n[trial exited 137]\n'),
            ('migrate', done(125, '', 'Error: no space left\n'), 75, '',
             f'TEMPFAIL: trial-migrate in {D1} exited 125\n[trial exited 125]\nError: no space left\n'),
            ('start', done(1, 'START FAILED: /health answered 500\noutput tail:\nboom\n'), 1,
             'START FAILED: /health answered 500\n',
             '[start exited 1]\nSTART FAILED: /health answered 500\noutput tail:\nboom\n'),
            ('start', done(0, f'START OK {OTHER_SHA}\n'), 2, '',
             f"REFUSED: start-check in {D1} exited 0 with 'START OK {OTHER_SHA}', expected START OK {X}\n"
             f'[start exited 0]\nSTART OK {OTHER_SHA}\n'),
            ('start', done(0, ''), 2, '',
             f"REFUSED: start-check in {D1} exited 0 with '', expected START OK {X}\n[start exited 0]\n"),
            ('start', done(75, 'START TIMEOUT: no "api listening" within 90s\n'), 75, '',
             f'TEMPFAIL: start-check in {D1} exited 75: START TIMEOUT: no "api listening" within 90s\n'
             '[start exited 75]\nSTART TIMEOUT: no "api listening" within 90s\n'),
            ('start', done(137), 75, '', f'TEMPFAIL: start-check in {D1} exited 137\n[start exited 137]\n'),
            ('compat', done(1, 'START FAILED: bot exited (code 1) before "api listening"\n'), 1,
             'COMPAT FAILED: START FAILED: bot exited (code 1) before "api listening"\n',
             '[compat exited 1]\nSTART FAILED: bot exited (code 1) before "api listening"\n'),
            ('compat', done(0, f'START OK {X}\n'), 2, '',
             f"REFUSED: start-check in {D2} exited 0 with 'START OK {X}', expected START OK {OTHER_SHA}\n"
             f'[compat exited 0]\nSTART OK {X}\n'),
            ('compat', done(64, '', 'usage: start-check.cjs [--timeout <seconds>]\n'), 2, '',
             f'REFUSED: previous image {D2} predates start-check --leave-running\n'
             '[compat exited 64]\nusage: start-check.cjs [--timeout <seconds>]\n'),
            # Spec §6.3: S that does not answer on the copy D has just started on is a verdict on the data.
            ('compat', done(75, 'START TIMEOUT: no "api listening" within 90s\n'), 1,
             'COMPAT FAILED: START TIMEOUT: no "api listening" within 90s\n',
             '[compat exited 75]\nSTART TIMEOUT: no "api listening" within 90s\n'),
            ('compat', done(137), 75, '', f'TEMPFAIL: start-check in {D2} exited 137\n[compat exited 137]\n'),
            # The kernel killed the bot (OOM under --memory): could not judge, for either image.
            ('start', done(75, 'START KILLED: bot killed by SIGKILL\n'), 75, '',
             f'TEMPFAIL: start-check in {D1} exited 75: START KILLED: bot killed by SIGKILL\n'
             '[start exited 75]\nSTART KILLED: bot killed by SIGKILL\n'),
            ('compat', done(75, 'START KILLED: bot killed by SIGKILL\n'), 75, '',
             f'TEMPFAIL: start-check in {D2} exited 75: START KILLED: bot killed by SIGKILL\n'
             '[compat exited 75]\nSTART KILLED: bot killed by SIGKILL\n'),
            ('compat', done(75, '', 'Error: OCI runtime error\n'), 75, '',
             f'TEMPFAIL: start-check in {D2} exited 75\n[compat exited 75]\nError: OCI runtime error\n'),
            # An exit 1 is a verdict only with its own FAILED line (node itself exits 1 on a crash).
            ('migrate', done(1, '', 'node:internal/modules/cjs/loader:1228\n'), 75, '',
             f'TEMPFAIL: trial-migrate in {D1} exited 1\n'
             '[trial exited 1]\nnode:internal/modules/cjs/loader:1228\n'),
            ('migrate', done(1, 'START FAILED: x\n'), 75, '',
             f'TEMPFAIL: trial-migrate in {D1} exited 1: START FAILED: x\n[trial exited 1]\nSTART FAILED: x\n'),
            ('start', done(1, 'Error: boom\n'), 75, '',
             f'TEMPFAIL: start-check in {D1} exited 1: Error: boom\n[start exited 1]\nError: boom\n'),
            ('compat', done(1, 'TRIAL FAILED: x\n'), 75, '',
             f'TEMPFAIL: start-check in {D2} exited 1: TRIAL FAILED: x\n[compat exited 1]\nTRIAL FAILED: x\n'),
        ]
        for step, answer, code, printed, err in rows:
            with self.subTest(step=step, code=answer.returncode, stdout=answer.stdout):
                runner = FakeRunner(*self.PREFIX[step], answer, done())
                self.assertEqual(self.main(TRIAL_ARGV, runner), (code, self.PRINTED[step] + printed, err))
                self.assertEqual([a for a in self.argvs(runner) if a[1] == 'rm'],
                                 [removed(s) for s in self.STARTED[step]])
                self.assertEqual(os.listdir(self.scratch), [])

    def test_a_step_that_times_out_is_tempfail_and_its_container_is_removed(self):
        for step, digest, timeout in (('migrate', D1, 180), ('start', D1, 150), ('compat', D2, 150)):
            with self.subTest(step=step):
                runner = FakeRunner(*self.PREFIX[step], subprocess.TimeoutExpired('podman', timeout), done())
                self.assertEqual(self.main(TRIAL_ARGV, runner),
                                 (75, self.PRINTED[step], f'TEMPFAIL: {step} in {digest} timed out after {timeout}s\n'))
                self.assertEqual([a for a in self.argvs(runner) if a[1] == 'rm'],
                                 [removed(s) for s in self.STARTED[step]])
                self.assertEqual(os.listdir(self.scratch), [])

    def test_our_own_candidate_not_knowing_leave_running_is_an_internal_error(self):
        runner = FakeRunner(*self.PREFIX['start'], done(64, '', 'usage: start-check.cjs\n'), done())
        code, out, err = self.main(TRIAL_ARGV, runner)
        self.assertEqual((code, out, err.splitlines()[-3:]),
                         (70, 'TRIAL OK: schema 46 -> 47\n',
                          [f"RuntimeError: start-check in {D1} refused its usage (64): ''", '[start exited 64]',
                           'usage: start-check.cjs']))
        self.assertEqual(os.listdir(self.scratch), [])

    def test_an_exception_inside_a_step_removes_its_container_and_the_scratch(self):
        runner = FakeRunner(INSPECT_D1, INSPECT_D2, RuntimeError('boom'), done())
        code, _, err = self.main(TRIAL_ARGV, runner)
        self.assertEqual((code, err.splitlines()[-1]), (70, 'RuntimeError: boom'))
        self.assertEqual(self.argvs(runner)[-1], removed('migrate'))
        self.assertEqual(os.listdir(self.scratch), [])

    def test_a_container_removal_that_times_out_does_not_hide_the_verdict(self):
        runner = FakeRunner(INSPECT_D1, INSPECT_D2, done(1, 'TRIAL FAILED: x\n'), subprocess.TimeoutExpired('rm', 60))
        self.assertEqual(self.main(TRIAL_ARGV, runner),
                         (1, 'TRIAL FAILED: x\n', 'wbb-image: podman rm -f -i wbb-image-trial-4242-migrate timed out\n'
                                                  '[trial exited 1]\nTRIAL FAILED: x\n'))

    # #858 AI review: a container left behind is said on stderr, never hidden; the verdict stands.
    def test_a_container_removal_that_fails_is_reported_and_does_not_hide_the_verdict(self):
        runner = FakeRunner(INSPECT_D1, INSPECT_D2, done(1, 'TRIAL FAILED: x\n'),
                            done(125, stderr='Error: database is locked\n'))
        self.assertEqual(self.main(TRIAL_ARGV, runner),
                         (1, 'TRIAL FAILED: x\n', 'wbb-image: podman rm -f -i wbb-image-trial-4242-migrate exited 125: '
                                                  'Error: database is locked\n[trial exited 1]\nTRIAL FAILED: x\n'))

    def test_a_verdict_line_is_cut_to_1000_characters(self):
        runner = FakeRunner(INSPECT_D1, INSPECT_D2, done(1, 'TRIAL FAILED: ' + 'x' * 5000 + '\n'), done())
        code, out, _ = self.main(TRIAL_ARGV, runner)
        self.assertEqual((code, out), (1, 'TRIAL FAILED: ' + 'x' * 986 + '\n'))

    def test_invalid_arguments_are_refused_before_any_call(self):
        for argv in (['trial', '--digest', D1[:-1], '--previous', D2, '--snapshot', SNAP],
                     ['trial', '--digest', D1, '--previous', 'latest', '--snapshot', SNAP],
                     ['trial', '--digest', D1, '--previous', D2, '--snapshot', f'../{SNAP}'],
                     ['trial', '--digest', D1, '--previous', D2, '--snapshot', os.path.join(self.snapshots, SNAP)]):
            with self.subTest(argv=argv):
                runner = FakeRunner()
                self.assertEqual(self.main(argv, runner)[0], 2)
                self.assertEqual(runner.calls, [])

    def test_an_image_not_of_our_repository_is_refused_before_any_container(self):
        for answers, message in (
            ([done(stdout=image_json(RepoDigests=[f'ghcr.io/x/y@{D1}']))],
             f"{REPO}@{D1}: RepoDigests ['ghcr.io/x/y@{D1}'] do not name it — not an image of {REPO}"),
            ([INSPECT_D1, done(125, stderr=f'Error: {REPO}@{D2}: image not known\n')], f'{REPO}@{D2} is not a local image'),
        ):
            with self.subTest(message=message):
                runner = FakeRunner(*answers)
                self.assertEqual(self.main(TRIAL_ARGV, runner), (2, '', f'REFUSED: {message}\n'))
                self.assertEqual((len(runner.calls), self.chowns, os.listdir(self.scratch)), (len(answers), [], []))

    def test_no_snapshot_is_tempfail(self):
        os.unlink(os.path.join(self.snapshots, SNAP))
        runner = FakeRunner(INSPECT_D1, INSPECT_D2)
        self.assertEqual(self.main(TRIAL_ARGV, runner), (75, '', f'TEMPFAIL: no snapshot {SNAP} in {self.snapshots}\n'))
        self.assertEqual((len(runner.calls), os.listdir(self.scratch)), (2, []))

    def test_a_snapshot_that_is_a_symlink_or_not_a_file_is_refused(self):
        path = os.path.join(self.snapshots, SNAP)
        os.unlink(path)
        secret = os.path.join(self.dir, 'secret')
        with open(secret, 'w', encoding='utf-8') as f:
            f.write('root only')
        os.symlink(secret, path)
        runner = FakeRunner(INSPECT_D1, INSPECT_D2)
        self.assertEqual(self.main(TRIAL_ARGV, runner), (2, '', f'REFUSED: {path}: Too many levels of symbolic links\n'))
        os.unlink(path)
        os.mkdir(path)
        runner = FakeRunner(INSPECT_D1, INSPECT_D2)
        self.assertEqual(self.main(TRIAL_ARGV, runner), (2, '', f'REFUSED: {path}: not a regular file\n'))
        self.assertEqual((self.chowns, os.listdir(self.scratch)), ([], []))


    # --- the scratch root, the snapshot and its checksum (review: items 3, 6, 8) ---

    def test_the_scratch_root_must_have_mode_0700(self):
        for mode in (0o750, 0o777, 0o500):
            with self.subTest(mode=oct(mode)):
                os.chmod(self.scratch, mode)
                runner = FakeRunner()
                self.assertEqual(self.main(TRIAL_ARGV, runner),
                                 (2, '', f'REFUSED: {self.scratch}: must be a directory owned by uid {UID} with mode '
                                         f'0700, is uid {UID} mode {mode:04o}\n'))
                self.assertEqual(runner.calls, [])

    def test_a_scratch_root_that_is_a_symlink_to_a_directory_is_refused(self):
        os.rmdir(self.scratch)
        os.symlink(self.snapshots, self.scratch)
        runner = FakeRunner()
        code, out, err = self.main(TRIAL_ARGV, runner)
        self.assertEqual((code, out, err.endswith(' (not a directory)\n'), runner.calls), (2, '', True, []))

    def test_the_scratch_root_must_belong_to_the_expected_owner(self):
        self.scratch_owner = UID + 1
        runner = FakeRunner()
        self.assertEqual(self.main(TRIAL_ARGV, runner),
                         (2, '', f'REFUSED: {self.scratch}: must be a directory owned by uid {UID + 1} with mode 0700, '
                                 f'is uid {UID} mode 0700\n'))
        self.assertEqual(runner.calls, [])

    def test_a_missing_scratch_root_is_refused(self):
        os.rmdir(self.scratch)
        runner = FakeRunner()
        self.assertEqual(self.main(TRIAL_ARGV, runner),
                         (2, '', f'REFUSED: {self.scratch}: missing (sudo bash deploy/install-image.sh)\n'))

    def test_a_snapshot_not_owned_by_the_bot_is_refused(self):
        self.bot = (UID + 1, GID)
        runner = FakeRunner(INSPECT_D1, INSPECT_D2)
        self.assertEqual(self.main(TRIAL_ARGV, runner),
                         (2, '', f'REFUSED: {self.snap}: owned by uid {UID} with 1 link(s), expected uid {UID + 1} and 1\n'))
        self.assertEqual((len(runner.calls), self.chowns, os.listdir(self.scratch)), (2, [], []))

    def test_a_snapshot_with_a_second_link_is_refused(self):
        os.link(self.snap, os.path.join(self.dir, 'hardlink'))
        runner = FakeRunner(INSPECT_D1, INSPECT_D2)
        self.assertEqual(self.main(TRIAL_ARGV, runner),
                         (2, '', f'REFUSED: {self.snap}: owned by uid {UID} with 2 link(s), expected uid {UID} and 1\n'))

    def run_in_thread(self, runner):
        """main() in a thread with a deadline: an open that blocked (a FIFO without O_NONBLOCK) leaves it alive."""
        result = []
        thread = threading.Thread(target=lambda: result.append(self.main(TRIAL_ARGV, runner)), daemon=True)
        thread.start()
        thread.join(10)
        return thread.is_alive(), result

    def test_a_snapshot_that_is_a_fifo_is_refused_without_hanging(self):
        os.unlink(self.snap)
        os.mkfifo(self.snap)
        self.assertEqual(self.run_in_thread(FakeRunner(INSPECT_D1, INSPECT_D2)),
                         (False, [(2, '', f'REFUSED: {self.snap}: not a regular file\n')]))

    def test_a_checksum_that_is_a_fifo_is_refused_without_hanging(self):
        os.unlink(self.snap + '.sha256')
        os.mkfifo(self.snap + '.sha256')
        self.assertEqual(self.run_in_thread(FakeRunner(INSPECT_D1, INSPECT_D2)),
                         (False, [(2, '', f'REFUSED: {self.snap}.sha256: not a regular file\n')]))

    def test_a_checksum_that_is_a_symlink_is_refused(self):
        os.unlink(self.snap + '.sha256')
        os.symlink(os.path.join(self.dir, 'elsewhere'), self.snap + '.sha256')
        runner = FakeRunner(INSPECT_D1, INSPECT_D2)
        self.assertEqual(self.main(TRIAL_ARGV, runner),
                         (2, '', f'REFUSED: {self.snap}.sha256: Too many levels of symbolic links\n'))

    def test_no_checksum_is_tempfail(self):
        os.unlink(self.snap + '.sha256')
        runner = FakeRunner(INSPECT_D1, INSPECT_D2)
        self.assertEqual(self.main(TRIAL_ARGV, runner),
                         (75, '', f'TEMPFAIL: no checksum {SNAP}.sha256 in {self.snapshots}\n'))
        self.assertEqual((len(runner.calls), os.listdir(self.scratch)), (2, []))

    def test_a_checksum_that_is_not_a_sha256_is_tempfail(self):
        for text, shown in (('', "''"), (SNAP_SHA256[:63] + '\n', repr(SNAP_SHA256[:63])),
                            (SNAP_SHA256.upper() + '\n', repr(SNAP_SHA256.upper()[:80]))):
            with self.subTest(text=text):
                with open(self.snap + '.sha256', 'w', encoding='ascii') as f:
                    f.write(text)
                runner = FakeRunner(INSPECT_D1, INSPECT_D2)
                self.assertEqual(self.main(TRIAL_ARGV, runner),
                                 (75, '', f'TEMPFAIL: {self.snap}.sha256: not a sha256: {shown}\n'))

    def test_a_copy_that_does_not_match_its_checksum_is_tempfail_and_runs_nothing(self):
        other = 'f' * 64
        with open(self.snap + '.sha256', 'w', encoding='ascii') as f:
            f.write(other + '\n')
        runner = FakeRunner(INSPECT_D1, INSPECT_D2)
        self.assertEqual(self.main(TRIAL_ARGV, runner),
                         (75, '', f'TEMPFAIL: snapshot copy has sha256 {SNAP_SHA256}, its .sha256 says {other}\n'))
        self.assertEqual((len(runner.calls), os.listdir(self.scratch)), (2, []))

    def test_twice_the_snapshot_free_in_the_scratch_root_is_enough(self):
        self.free = 2 * len(SNAP_BYTES)
        runner = FakeRunner(INSPECT_D1, INSPECT_D2, TRIAL_OK, done(), START_OK, done(), COMPAT_OK, done())
        self.assertEqual(self.main(TRIAL_ARGV, runner)[0], 0)
        self.assertEqual(self.free_asked, [self.scratch])

    def test_less_than_twice_the_snapshot_free_is_tempfail_before_any_copy(self):
        self.free = 2 * len(SNAP_BYTES) - 1
        runner = FakeRunner(INSPECT_D1, INSPECT_D2)
        self.assertEqual(self.main(TRIAL_ARGV, runner),
                         (75, '', f'TEMPFAIL: {2 * len(SNAP_BYTES) - 1} bytes free on {self.scratch}, a trial of a '
                                  f'{len(SNAP_BYTES)}-byte snapshot needs {2 * len(SNAP_BYTES)}\n'))
        self.assertEqual((len(runner.calls), self.chowns, os.listdir(self.scratch)), (2, [], []))

AUDIT_ARGV = [PODMAN, 'run', '--name', 'wbb-image-audit-4242-audit', '--rm', '--pull=never', '--network=host',
              '--read-only', '--tmpfs', '/tmp', '--cap-drop=ALL', '--security-opt=no-new-privileges',
              '--user', f'{UID}:{GID}', '--memory=1g', '--pids-limit=256',
              '-e', 'TELEGRAM_BOT_TOKEN=123456:abcdefghij', '-e', 'OSRM_BASE_URL=http://x',
              '-e', 'NOMINATIM_USER_AGENT=x', '-e', 'WBB_RELEASE_REQUIRED=true', '-e', 'API_PORT=3000',
              f'{REPO}@{D1}', 'sh', '-c',
              'cd /app && npm audit --omit=dev --json | node_modules/.bin/tsx scripts/autodeploy/audit-verdict-cli.ts']


class Audit(HelperCase):
    def test_clean(self):
        runner = FakeRunner(INSPECT_D1, done(0, 'clean\n'), done())
        self.assertEqual(self.main(['audit', '--digest', D1], runner), (0, f'AUDIT CLEAN {D1}\n', ''))
        self.assertEqual(runner.calls, [(INSPECT_ARGV, 60, True), (AUDIT_ARGV, 300, True),
                                        (removed('audit', 'audit'), 60, True)])

    def test_an_advisory_is_a_verdict_with_its_details(self):
        runner = FakeRunner(INSPECT_D1, done(10, 'high: x (via y)\ncritical: z\n'), done())
        self.assertEqual(self.main(['audit', '--digest', D1], runner),
                         (1, f'AUDIT ADVISORY {D1}\nhigh: x (via y)\ncritical: z\n', ''))

    def test_any_other_exit_could_not_audit(self):
        for code in (1, 2, 125, 137):
            with self.subTest(code=code):
                runner = FakeRunner(INSPECT_D1, done(code, '', 'npm ERR! network\n'), done())
                self.assertEqual(self.main(['audit', '--digest', D1], runner),
                                 (75, '', f'TEMPFAIL: audit in {D1} exited {code}\n[audit exited {code}]\nnpm ERR! network\n'))
                self.assertEqual(self.argvs(runner)[-1], removed('audit', 'audit'))

    def test_a_timeout_could_not_audit(self):
        runner = FakeRunner(INSPECT_D1, subprocess.TimeoutExpired('podman', 300), done())
        self.assertEqual(self.main(['audit', '--digest', D1], runner),
                         (75, '', f'TEMPFAIL: audit in {D1} timed out after 300s\n'))
        self.assertEqual(self.argvs(runner)[-1], removed('audit', 'audit'))

    def test_an_image_not_of_our_repository_is_refused_without_a_container(self):
        runner = FakeRunner(done(stdout=image_json(Labels=None)))
        self.assertEqual(self.main(['audit', '--digest', D1], runner),
                         (2, '', f'REFUSED: {REPO}@{D1}: label {REV} is None, not a full SHA\n'))
        self.assertEqual(self.argvs(runner), [INSPECT_ARGV])


TEMPLATE = (f'# activate fills in @@DIGEST@@, @@UID@@ and @@GID@@\n[Container]\nImage={REPO}@@@DIGEST@@\n'
            '  ; @@UID@@ is numeric\nUser=@@UID@@\nGroup=@@GID@@\n')
WRITTEN = (f'# activate fills in @@DIGEST@@, @@UID@@ and @@GID@@\n[Container]\nImage={REPO}@{D1}\n'
           f'  ; @@UID@@ is numeric\nUser={UID}\nGroup={GID}\n')
RELOAD = [SYSTEMCTL, 'daemon-reload']
RESTART = [SYSTEMCTL, 'restart', 'warsaw-beer-bot.service']


class Activate(HelperCase):
    def setUp(self):
        super().setUp()
        with open(self.template, 'w', encoding='utf-8') as f:
            f.write(TEMPLATE)

    def ours(self):
        return show('loaded', self.quadlet, '/run/systemd/generator/warsaw-beer-bot.service')

    def read_quadlet(self):
        with open(self.quadlet, encoding='utf-8') as f:
            return f.read(), stat.S_IMODE(os.stat(self.quadlet).st_mode)

    def test_first_activation_writes_the_template_reloads_checks_and_restarts(self):
        runner = FakeRunner(INSPECT_D1, show('not-found', '', ''), done(), self.ours(), done())
        self.assertEqual(self.main(['activate', '--digest', D1], runner), (0, f'ACTIVATED {D1}\n', ''))
        self.assertEqual(runner.calls, [(INSPECT_ARGV, 60, True), (SHOW_ARGV, 30, True), (RELOAD, 60, True),
                                        (SHOW_ARGV, 30, True), (RESTART, 180, True)])
        self.assertEqual((self.read_quadlet(), sorted(os.listdir(self.dir))),
                         ((WRITTEN, 0o644), ['scratch', 'snap', 'template', 'warsaw-beer-bot.container']))

    def test_replaces_the_file_of_a_quadlet_unit(self):
        self.write_quadlet(f'Image={REPO}@{D2}\n')
        runner = FakeRunner(INSPECT_D1, self.ours(), done(), self.ours(), done())
        self.assertEqual(self.main(['activate', '--digest', D1], runner), (0, f'ACTIVATED {D1}\n', ''))
        self.assertEqual(self.read_quadlet(), (WRITTEN, 0o644))

    def test_creates_the_quadlet_directory_when_there_is_none(self):
        self.quadlet = os.path.join(self.dir, 'containers', 'systemd', 'warsaw-beer-bot.container')
        runner = FakeRunner(INSPECT_D1, show('not-found', '', ''), done(), self.ours(), done())
        self.assertEqual(self.main(['activate', '--digest', D1], runner)[0], 0)
        self.assertEqual(self.read_quadlet(), (WRITTEN, 0o644))

    def test_a_stale_temp_file_that_is_a_symlink_is_replaced_not_followed(self):
        target = os.path.join(self.dir, 'target')
        with open(target, 'w', encoding='utf-8') as f:
            f.write('untouched')
        os.symlink(target, self.quadlet + '.tmp')
        runner = FakeRunner(INSPECT_D1, show('not-found', '', ''), done(), self.ours(), done())
        self.assertEqual(self.main(['activate', '--digest', D1], runner)[0], 0)
        with open(target, encoding='utf-8') as f:
            self.assertEqual(f.read(), 'untouched')
        self.assertEqual((self.read_quadlet(), os.path.lexists(self.quadlet + '.tmp')), ((WRITTEN, 0o644), False))

    def test_a_foreign_unit_is_refused_with_no_write_and_no_reload(self):
        self.write_quadlet(f'Image={REPO}@{D2}\n')
        runner = FakeRunner(INSPECT_D1, show('loaded', '', '/etc/systemd/system/warsaw-beer-bot.service'))
        self.assertEqual(self.main(['activate', '--digest', D1], runner),
                         (2, '', f'REFUSED: warsaw-beer-bot.service is not generated from {self.quadlet} '
                                 '(a unit elsewhere shadows it?)\n'))
        self.assertEqual(self.argvs(runner), [INSPECT_ARGV, SHOW_ARGV])
        self.assertEqual((self.read_quadlet()[0], os.path.lexists(self.quadlet + '.tmp')),
                         (f'Image={REPO}@{D2}\n', False))

    def refused_after_reload(self, kind):
        return (2, '', f'REFUSED: after daemon-reload warsaw-beer-bot.service was {kind}, not generated from '
                       f'{self.quadlet}; the previous file is back, not restarted\n')

    def test_not_quadlet_after_the_reload_puts_the_previous_file_back_and_does_not_restart(self):
        previous = f'# the one before\nImage={REPO}@{D2}\n'
        for after, kind in ((show('loaded', '', '/etc/systemd/system/warsaw-beer-bot.service'), 'foreign'),
                            (show('not-found', '', ''), 'absent')):
            with self.subTest(kind=kind):
                self.write_quadlet(previous)
                runner = FakeRunner(INSPECT_D1, self.ours(), done(), after, done())
                self.assertEqual(self.main(['activate', '--digest', D1], runner), self.refused_after_reload(kind))
                self.assertEqual(self.argvs(runner), [INSPECT_ARGV, SHOW_ARGV, RELOAD, SHOW_ARGV, RELOAD])
                self.assertEqual((self.read_quadlet(), os.path.lexists(self.quadlet + '.tmp')),
                                 ((previous, 0o644), False))

    def test_not_quadlet_after_the_reload_removes_a_file_there_was_none_of(self):
        runner = FakeRunner(INSPECT_D1, show('not-found', '', ''), done(),
                            show('loaded', '', '/etc/systemd/system/warsaw-beer-bot.service'), done())
        self.assertEqual(self.main(['activate', '--digest', D1], runner), self.refused_after_reload('foreign'))
        self.assertEqual(self.argvs(runner), [INSPECT_ARGV, SHOW_ARGV, RELOAD, SHOW_ARGV, RELOAD])
        self.assertEqual((os.path.lexists(self.quadlet), os.path.lexists(self.quadlet + '.tmp')), (False, False))

    def test_a_failing_reload_after_putting_the_file_back_is_tempfail(self):
        runner = FakeRunner(INSPECT_D1, show('not-found', '', ''), done(), show('not-found', '', ''),
                            done(1, stderr='Access denied\n'))
        self.assertEqual(self.main(['activate', '--digest', D1], runner),
                         (75, '', 'TEMPFAIL: systemctl daemon-reload (restore) exited 1: Access denied\n'))
        self.assertEqual(os.path.lexists(self.quadlet), False)

    # #858 AI review: a reload that fails must not leave D on disk for a later reload or a reboot to start.
    def test_a_failing_first_reload_puts_the_previous_file_back_reloads_again_and_is_tempfail(self):
        previous = f'# the one before\nImage={REPO}@{D2}\n'
        self.write_quadlet(previous)
        runner = FakeRunner(INSPECT_D1, self.ours(), done(1, stderr='Access denied\n'), done())
        self.assertEqual(self.main(['activate', '--digest', D1], runner),
                         (75, '', 'TEMPFAIL: systemctl daemon-reload exited 1: Access denied\n'))
        self.assertEqual((self.argvs(runner), self.read_quadlet(), os.path.lexists(self.quadlet + '.tmp')),
                         ([INSPECT_ARGV, SHOW_ARGV, RELOAD, RELOAD], (previous, 0o644), False))

    # #858 AI review: a client that timed out does not prove systemd kept the previous unit.
    def test_a_timed_out_first_reload_removes_a_file_there_was_none_of_and_reloads_again(self):
        runner = FakeRunner(INSPECT_D1, show('not-found', '', ''), subprocess.TimeoutExpired('systemctl', 60), done())
        self.assertEqual(self.main(['activate', '--digest', D1], runner),
                         (75, '', 'TEMPFAIL: systemctl daemon-reload timed out after 60s\n'))
        self.assertEqual((self.argvs(runner), os.path.lexists(self.quadlet)),
                         ([INSPECT_ARGV, SHOW_ARGV, RELOAD, RELOAD], False))

    def test_a_second_reload_that_fails_too_is_said_in_the_tempfail(self):
        runner = FakeRunner(INSPECT_D1, show('not-found', '', ''), done(1, stderr='Access denied\n'),
                            done(1, stderr='Still denied\n'))
        self.assertEqual(self.main(['activate', '--digest', D1], runner),
                         (75, '', 'TEMPFAIL: systemctl daemon-reload exited 1: Access denied; the previous file is '
                                  'back, systemctl daemon-reload (restore) exited 1: Still denied\n'))
        self.assertEqual(os.path.lexists(self.quadlet), False)

    # #858 AI review: a restore that cannot write is still 75 with what happened, never a traceback (70).
    def test_a_restore_that_cannot_write_is_tempfail_saying_so(self):
        previous = f'# the one before\nImage={REPO}@{D2}\n'
        self.write_quadlet(previous)
        runner = FakeRunner(INSPECT_D1, self.ours(), done(1, stderr='Access denied\n'), done())
        real = wi._write_atomically
        calls = []

        def write(path, data):
            calls.append(path)
            if len(calls) == 2:
                raise OSError(28, 'No space left on device')
            return real(path, data)

        with mock.patch.object(wi, '_write_atomically', write):
            result = self.main(['activate', '--digest', D1], runner)
        self.assertEqual(result, (75, '', 'TEMPFAIL: systemctl daemon-reload exited 1: Access denied; putting the '
                                          f'previous {self.quadlet} back failed too: [Errno 28] No space left on device\n'))
        # #858 AI review, round 3: systemd is reloaded even then — the restore may have changed the file first.
        self.assertEqual(self.argvs(runner), [INSPECT_ARGV, SHOW_ARGV, RELOAD, RELOAD])

    def test_a_restore_that_cannot_write_and_a_second_reload_that_fails_say_both(self):
        self.write_quadlet(f'Image={REPO}@{D2}\n')
        runner = FakeRunner(INSPECT_D1, self.ours(), done(1, stderr='Access denied\n'), done(1, stderr='Still denied\n'))
        real = wi._write_atomically
        calls = []

        def write(path, data):
            calls.append(path)
            if len(calls) == 2:
                raise OSError(28, 'No space left on device')
            return real(path, data)

        with mock.patch.object(wi, '_write_atomically', write):
            result = self.main(['activate', '--digest', D1], runner)
        self.assertEqual(result, (75, '', 'TEMPFAIL: systemctl daemon-reload exited 1: Access denied; putting the '
                                          f'previous {self.quadlet} back failed too: [Errno 28] No space left on device; '
                                          'then systemctl daemon-reload (restore) exited 1: Still denied\n'))

    def test_a_previous_quadlet_path_that_is_not_a_file_is_refused_before_writing(self):
        os.mkdir(self.quadlet)
        runner = FakeRunner(INSPECT_D1, show('not-found', '', ''))
        self.assertEqual(self.main(['activate', '--digest', D1], runner),
                         (2, '', f'REFUSED: {self.quadlet}: not a regular file\n'))
        self.assertEqual(self.argvs(runner), [INSPECT_ARGV, SHOW_ARGV])

    def test_a_template_without_each_placeholder_exactly_once_is_refused_before_any_write(self):
        for text, counts in (
            (TEMPLATE.replace('@@GID@@', '0'), "{'@@DIGEST@@': 1, '@@UID@@': 1, '@@GID@@': 0}"),
            (TEMPLATE + 'Environment=X=@@UID@@\n', "{'@@DIGEST@@': 1, '@@UID@@': 2, '@@GID@@': 1}"),
            ('', "{'@@DIGEST@@': 0, '@@UID@@': 0, '@@GID@@': 0}"),
            ('# @@DIGEST@@ @@UID@@ @@GID@@\n', "{'@@DIGEST@@': 0, '@@UID@@': 0, '@@GID@@': 0}"),
        ):
            with self.subTest(counts=counts):
                with open(self.template, 'w', encoding='utf-8') as f:
                    f.write(text)
                runner = FakeRunner(INSPECT_D1, show('not-found', '', ''))
                self.assertEqual(self.main(['activate', '--digest', D1], runner),
                                 (2, '', f'REFUSED: {self.template}: each placeholder must occur exactly once '
                                         f'outside comments, found {counts}\n'))
                self.assertEqual((self.argvs(runner), os.path.lexists(self.quadlet)),
                                 ([INSPECT_ARGV, SHOW_ARGV], False))

    def test_a_missing_template_is_refused(self):
        os.unlink(self.template)
        runner = FakeRunner(INSPECT_D1, show('not-found', '', ''))
        self.assertEqual(self.main(['activate', '--digest', D1], runner),
                         (2, '', f'REFUSED: {self.template}: No such file or directory '
                                 '(sudo bash deploy/install-image.sh)\n'))

    def test_a_restart_that_fails_is_a_verdict_on_the_activated_image(self):
        runner = FakeRunner(INSPECT_D1, show('not-found', '', ''), done(), self.ours(),
                            done(1, stderr='Job for warsaw-beer-bot.service failed.\nSee "journalctl -xeu".\n'))
        self.assertEqual(self.main(['activate', '--digest', D1], runner),
                         (1, 'ACTIVATE FAILED: restart exited 1: Job for warsaw-beer-bot.service failed. '
                             'See "journalctl -xeu".\n', ''))
        self.assertEqual(self.argvs(runner), [INSPECT_ARGV, SHOW_ARGV, RELOAD, SHOW_ARGV, RESTART])
        self.assertEqual(self.read_quadlet(), (WRITTEN, 0o644))

    def test_a_failing_reload_or_a_restart_timeout_is_tempfail(self):
        for answers, message in (
            ([done(1, stderr='Access denied\n'), done()], 'systemctl daemon-reload exited 1: Access denied'),
            ([subprocess.TimeoutExpired('systemctl', 60), done()], 'systemctl daemon-reload timed out after 60s'),
            ([done(), self.ours(), subprocess.TimeoutExpired('systemctl', 180)],
             'systemctl restart warsaw-beer-bot.service timed out after 180s'),
        ):
            with self.subTest(message=message):
                runner = FakeRunner(INSPECT_D1, show('not-found', '', ''), *answers)
                self.assertEqual(self.main(['activate', '--digest', D1], runner), (75, '', f'TEMPFAIL: {message}\n'))

    def test_an_image_not_of_our_repository_is_refused_before_systemctl(self):
        runner = FakeRunner(done(125, stderr='Error: image not known\n'))
        self.assertEqual(self.main(['activate', '--digest', D1], runner),
                         (2, '', f'REFUSED: {REPO}@{D1} is not a local image\n'))
        self.assertEqual((self.argvs(runner), os.path.lexists(self.quadlet)), ([INSPECT_ARGV], False))

    def test_the_real_template_activates_into_a_file_current_reads_back(self):
        self.template = os.path.join(os.path.dirname(HERE), 'warsaw-beer-bot.container')
        runner = FakeRunner(INSPECT_D1, show('not-found', '', ''), done(), self.ours(), done())
        self.assertEqual(self.main(['activate', '--digest', D1], runner)[0], 0)
        lines = self.read_quadlet()[0].splitlines()
        self.assertEqual(([line for line in lines if line.startswith(('Image=', 'User=', 'Group='))],
                          wi.quadlet_digest(self.host(FakeRunner()))),
                         ([f'Image={REPO}@{D1}', f'User={UID}', f'Group={GID}'], D1))


LIB = '/usr/local/lib/wbb-image'
TARGET = 'import sys\nprint(sys.argv[1:], sys.flags.isolated)\nsys.exit(int(sys.argv[1]))\n'


class Wrapper(unittest.TestCase):
    """deploy/image/helper/wbb-image.sh, copied with its library directory replaced by a temp one."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.lib = os.path.join(self.dir, 'lib')
        with open(os.path.join(HERE, 'wbb-image.sh'), encoding='utf-8') as f:
            self.text = f.read()
        self.path = os.path.join(self.dir, 'wbb-image.sh')
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write(self.text.replace(LIB, self.lib))

    def run_sh(self, *args):
        r = subprocess.run(['sh', self.path, *args], capture_output=True, text=True, timeout=30)
        return r.returncode, r.stdout, r.stderr

    def write_lib(self, text):
        os.makedirs(self.lib, exist_ok=True)
        with open(os.path.join(self.lib, 'wbb_image.py'), 'w', encoding='utf-8') as f:
            f.write(text)

    def test_runs_the_installed_library_isolated_without_bytecode(self):
        self.assertEqual((self.text.splitlines()[0], self.text.splitlines()[-1]),
                         ('#!/bin/sh', f'exec /usr/bin/python3 -I -B {LIB}/wbb_image.py "$@"'))

    def test_the_arguments_and_the_exit_code_pass_through_unchanged(self):
        self.write_lib(TARGET)
        self.assertEqual(self.run_sh('3', 'pull', '--sha', 'a b', ''), (3, "['3', 'pull', '--sha', 'a b', ''] 1\n", ''))

    def test_without_the_library_it_exits_70_not_2(self):
        self.assertEqual(self.run_sh('current'),
                         (70, '', f'wbb-image: {self.lib}/wbb_image.py is not installed '
                                  '(sudo bash deploy/install-image.sh)\n'))

    def test_a_library_that_does_not_compile_exits_70_not_1(self):
        self.write_lib('import sys\nmatch sys.argv:\n    case [_, *rest] if (x := 1:\n        pass\n')
        code, out, err = self.run_sh('current')
        self.assertEqual((code, out, err.splitlines()[-1]),
                         (70, '', f'wbb-image: {self.lib}/wbb_image.py does not compile under /usr/bin/python3'))
        self.assertIn('SyntaxError', err)

    def test_the_real_library_gets_no_bytecode_written_into_it(self):
        shutil.copytree(HERE, self.lib, ignore=shutil.ignore_patterns('__pycache__', 'test_*', '*.sh'))
        self.assertEqual(self.run_sh('--no-such-option')[:2], (64, ''))
        self.assertEqual(os.path.exists(os.path.join(self.lib, '__pycache__')), False)

    def test_is_executable_in_the_repo(self):
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(HERE, 'wbb-image.sh')).st_mode) & 0o111, 0o111)


class BrokenImport(unittest.TestCase):
    """A sibling module that fails to import is an internal error (70), never Python's 1 (a bad candidate)."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        for name in ('wbb_image.py', 'bounded.py'):
            shutil.copy(os.path.join(HERE, name), self.dir)

    def run_copy(self, *args):
        r = subprocess.run([sys.executable, '-I', os.path.join(self.dir, 'wbb_image.py'), *args], capture_output=True,
                           text=True, timeout=60, cwd=tempfile.gettempdir())
        return r.returncode, r.stdout, r.stderr

    def test_a_broken_bounded_exits_70(self):
        with open(os.path.join(self.dir, 'bounded.py'), 'w', encoding='utf-8') as f:
            f.write("raise ImportError('broken on purpose')\n")
        code, out, err = self.run_copy('current')
        self.assertEqual((code, out, err.splitlines()[-1]), (70, '', 'ImportError: broken on purpose'))

    def test_an_intact_copy_reaches_its_own_usage_error(self):
        self.assertEqual(self.run_copy()[:2], (64, ''))


if __name__ == '__main__':
    unittest.main()
