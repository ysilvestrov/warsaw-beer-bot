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
import unittest

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
        return response


class HelperCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.quadlet = os.path.join(self.dir, 'warsaw-beer-bot.container')
        self.free_asked = []
        self.free = 100 * GIB

    def host(self, runner):
        def free_bytes(path):
            self.free_asked.append(path)
            return self.free
        return wi.Host(podman=PODMAN, systemctl=SYSTEMCTL, run=runner, quadlet_path=self.quadlet,
                       template_path=os.path.join(self.dir, 'template'), snapshot_root=os.path.join(self.dir, 'snap'),
                       scratch_root=os.path.join(self.dir, 'scratch'), containers_root='/fake/containers',
                       free_bytes=free_bytes, bot_ids=lambda: (1001, 1002))

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


IMAGES_ARGV = [PODMAN, 'images', '--filter', f'reference={REPO}', '--format', '{{.Id}} {{.Digest}}']


def rmi(image_id):
    return [PODMAN, 'rmi', image_id]


class Prune(HelperCase):
    def test_removes_what_is_neither_kept_nor_pinned_and_counts_a_failed_rmi_as_skipped(self):
        self.write_quadlet(f'Image={REPO}@{D2}\n')
        listing = f'{I1} {D1}\n{I2} {D2}\n{I3} {D3}\n{I4} {D4}\n'
        runner = FakeRunner(done(stdout=listing), done(), done(2, stderr='Error: image is in use by a container\n'))
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 1 skipped 1 kept {D1} {D2}\n', ''))
        self.assertEqual(runner.calls, [(IMAGES_ARGV, 60, True), (rmi(I3), 120, True), (rmi(I4), 120, True)])

    def test_never_removes_the_quadlet_files_image_even_without_keep(self):
        self.write_quadlet(f'[Container]\nImage={REPO}@{D2}\n')
        runner = FakeRunner(done(stdout=f'{I2} {D2}\n'))
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 0 skipped 0 kept {D1} {D2}\n', ''))
        self.assertEqual(self.argvs(runner), [IMAGES_ARGV])

    def test_several_keeps_and_no_quadlet_file(self):
        runner = FakeRunner(done(stdout=f'{I1} {D1}\n{I2} {D2}\n{I3} {D3}\n'), done())
        self.assertEqual(self.main(['prune', '--keep', D2, '--keep', D1], runner),
                         (0, f'PRUNED 1 skipped 0 kept {D1} {D2}\n', ''))
        self.assertEqual(self.argvs(runner), [IMAGES_ARGV, rmi(I3)])

    def test_an_image_listed_under_a_kept_digest_is_kept_under_any_other(self):
        runner = FakeRunner(done(stdout=f'{I1} {D3}\n{I1} {D1}\n'))
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 0 skipped 0 kept {D1}\n', ''))
        self.assertEqual(self.argvs(runner), [IMAGES_ARGV])

    def test_an_image_listed_twice_is_removed_once(self):
        runner = FakeRunner(done(stdout=f'{I3} {D3}\n{I3} {D4}\n'), done())
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 1 skipped 0 kept {D1}\n', ''))
        self.assertEqual(self.argvs(runner), [IMAGES_ARGV, rmi(I3)])

    def test_nothing_listed(self):
        runner = FakeRunner(done(stdout=''))
        self.assertEqual(self.main(['prune', '--keep', D1], runner), (0, f'PRUNED 0 skipped 0 kept {D1}\n', ''))

    def test_a_listing_line_it_cannot_read_removes_nothing(self):
        for line in (f'{I3} <none>', f'{I3}', f'{I3} {D3} extra', f'sha256:{I3} {D3}'):
            with self.subTest(line=line):
                runner = FakeRunner(done(stdout=f'{I4} {D4}\n{line}\n'))
                self.assertEqual(self.main(['prune', '--keep', D1], runner),
                                 (2, '', f'REFUSED: podman images: unexpected line {line!r}\n'))
                self.assertEqual(self.argvs(runner), [IMAGES_ARGV])

    def test_a_failing_listing_is_tempfail(self):
        runner = FakeRunner(done(125, stderr='Error: boom\n'))
        self.assertEqual(self.main(['prune', '--keep', D1], runner),
                         (75, '', 'TEMPFAIL: podman images exited 125: Error: boom\n'))

    def test_a_timed_out_rmi_is_tempfail(self):
        runner = FakeRunner(done(stdout=f'{I3} {D3}\n'), subprocess.TimeoutExpired(rmi(I3), 120))
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
                     ['prune', '--keep']):
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
                          p.containers_root, p.run),
                         ('/usr/bin/podman', '/usr/bin/systemctl', '/etc/containers/systemd/warsaw-beer-bot.container',
                          '/usr/local/lib/wbb-image/warsaw-beer-bot.container',
                          '/var/lib/warsaw-beer-bot/deploy-snapshots', '/var/lib/wbb-image', '/var/lib/containers',
                          wi.bounded.run))

    def test_the_host_is_frozen(self):
        with self.assertRaises(AttributeError):
            wi.PRODUCTION.podman = '/tmp/podman'


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
