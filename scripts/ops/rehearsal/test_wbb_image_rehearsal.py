"""The rehearsal shim of the root helper and the kit's Quadlet template.

Plan: docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-harness.md, "Рішення" п.1, п.4, Task 1.
podman and systemctl are never run: the shim's main() gets the kit's Host with a fake runner (as
deploy/image/helper/test_wbb_image.py does) and temp paths where the kit writes; the template is the real one.
"""
import contextlib
import dataclasses
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wbb_image_rehearsal as shim  # noqa: E402

wi = shim.wbb_image
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
PRODUCTION_TEMPLATE = os.path.join(ROOT, 'deploy', 'image', 'warsaw-beer-bot.container')
KIT_TEMPLATE = os.path.join(HERE, 'wbb-rehearsal.container')
REPO = 'ghcr.io/ysilvestrov/warsaw-beer-bot'
X = '0123456789abcdef0123456789abcdef01234567'
D1 = 'sha256:' + '1' * 64
D2 = 'sha256:' + '2' * 64
I1 = 'a' * 64
UID = os.getuid()
GID = os.getgid()
PODMAN = '/fake/bin/podman'
SYSTEMCTL = '/fake/bin/systemctl'
SHOW_ARGV = [SYSTEMCTL, 'show', 'wbb-rehearsal.service', '-p', 'LoadState,SourcePath,FragmentPath']
CONTAINER_ARGV = [PODMAN, 'container', 'inspect', 'wbb-rehearsal', '--format', '{{.Image}} {{.ImageDigest}}']
RELOAD = [SYSTEMCTL, 'daemon-reload']
RESTART = [SYSTEMCTL, 'restart', 'wbb-rehearsal.service']
GENERATED = '/run/systemd/generator/wbb-rehearsal.service'
SICK = 'Exec=node -e "process.exit(1)"'


def done(code=0, stdout='', stderr=''):
    return subprocess.CompletedProcess(['scripted'], code, stdout, stderr)


def show(load, source, fragment):
    return done(stdout=f'FragmentPath={fragment}\nLoadState={load}\nSourcePath={source}\n')


def inspect(digest):
    return done(stdout=json.dumps([{'Id': I1, 'Digest': digest, 'RepoDigests': [f'{REPO}@{digest}'],
                                    'Labels': {'org.opencontainers.image.revision': X, 'wbb.content': 'e' * 64}}]))


class FakeRunner:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, argv, *, timeout, text=False, **kwargs):
        self.calls.append(list(argv))
        return self.responses.pop(0)


def directives(path):
    """(key, value) of each line of a unit file that is not a comment, a section or blank."""
    with open(path, encoding='utf-8') as f:
        lines = [line.strip() for line in f]
    return [tuple(line.split('=', 1)) for line in lines if line and not line.startswith(('#', ';', '['))]


class ShimCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        # Its own directory: what `activate` leaves there is all it wrote.
        self.quadlet_dir = os.path.join(self.dir, 'systemd')
        os.mkdir(self.quadlet_dir)
        self.quadlet = os.path.join(self.quadlet_dir, 'wbb-rehearsal.container')

    def host(self, runner):
        return dataclasses.replace(shim.REHEARSAL, podman=PODMAN, systemctl=SYSTEMCTL, run=runner,
                                   quadlet_path=self.quadlet, snapshot_root=os.path.join(self.dir, 'snap'),
                                   scratch_root=os.path.join(self.dir, 'scratch'), bot_ids=lambda: (UID, GID),
                                   free_bytes=lambda path: 100 * 1024 ** 3, pid=lambda: 4242)

    def main(self, argv, runner, environ=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = shim.main(argv, self.host(runner), {} if environ is None else environ)
        return code, out.getvalue(), err.getvalue()

    def activate(self, digest, environ=None):
        runner = FakeRunner(inspect(digest), show('not-found', '', ''), done(),
                            show('loaded', self.quadlet, GENERATED), done())
        result = self.main(['activate', '--digest', digest], runner, environ)
        return result, runner.calls

    def written(self):
        with open(self.quadlet, encoding='utf-8') as f:
            return f.read()

    def rendered_kit_template(self, digest):
        """What the helper itself renders from the kit's template: the unit a healthy candidate gets."""
        with open(KIT_TEMPLATE, encoding='utf-8') as f:
            lines = f.read().splitlines(keepends=True)
        return wi.render_template(lines, digest, UID, GID)


class TheKitsHost(unittest.TestCase):
    def test_is_production_s_host_with_the_kit_s_quadlet_template_snapshots_and_scratch(self):
        self.assertEqual(shim.REHEARSAL, dataclasses.replace(
            wi.PRODUCTION, quadlet_path='/etc/containers/systemd/wbb-rehearsal.container',
            template_path=KIT_TEMPLATE, snapshot_root='/var/lib/wbb-rehearsal/data/deploy-snapshots',
            scratch_root='/var/lib/wbb-rehearsal/scratch'))

    def test_systemd_names_the_unit_the_shim_asks_for_after_the_quadlet_file(self):
        stem = os.path.basename(shim.REHEARSAL.quadlet_path)[:-len('.container')]
        self.assertEqual((stem, f'{stem}.service'), (shim.CONTAINER, shim.UNIT))

    def test_no_name_path_or_unit_of_the_kit_is_or_overlaps_production_s(self):
        production = [wi.PRODUCTION.quadlet_path, wi.PRODUCTION.template_path, wi.PRODUCTION.snapshot_root,
                      wi.PRODUCTION.scratch_root, '/var/lib/warsaw-beer-bot', '/etc/warsaw-beer-bot',
                      PRODUCTION_TEMPLATE]
        kit = [shim.REHEARSAL.quadlet_path, shim.REHEARSAL.template_path, shim.REHEARSAL.snapshot_root,
               shim.REHEARSAL.scratch_root, shim.KIT_ROOT] + [
            path for key, value in directives(KIT_TEMPLATE) if key == 'Volume' for path in value.split(':')[:2]]
        overlaps = [(k, p) for k in kit for p in production
                    if k == p or k.startswith(p.rstrip('/') + '/') or p.startswith(k.rstrip('/') + '/')]
        self.assertEqual(overlaps, [])
        self.assertEqual((shim.CONTAINER == wi.CONTAINER, shim.UNIT == wi.UNIT), (False, False))
        self.assertEqual((wi.CONTAINER, wi.UNIT), ('warsaw-beer-bot', 'warsaw-beer-bot.service'))


class TheKitsTemplate(unittest.TestCase):
    def test_has_production_s_keys_but_no_environment_file(self):
        self.assertEqual({key for key, _ in directives(KIT_TEMPLATE)},
                         {key for key, _ in directives(PRODUCTION_TEMPLATE)} - {'EnvironmentFile'})

    def test_runs_on_the_substitute_environment_of_the_trial_with_the_kit_s_port_copy_and_preload(self):
        env = [value.split('=', 1) for key, value in directives(KIT_TEMPLATE) if key == 'Environment']
        self.assertEqual(dict(env), {**dict(wi.TRIAL_ENV), 'API_PORT': '3917',
                                     'DATABASE_PATH': '/var/lib/wbb-rehearsal/data/bot.db',
                                     'NODE_OPTIONS': '--require=/app/deploy/image/offline-telegram.cjs'})
        # One line per key, and no space a systemd Environment= would split the value at.
        self.assertEqual((len(env), [v for _, v in env if ' ' in v]), (7, []))

    def test_mounts_only_the_kit_s_copy_and_names_the_kit_s_container_on_the_host_network(self):
        keys = dict(directives(KIT_TEMPLATE))
        self.assertEqual([value for key, value in directives(KIT_TEMPLATE) if key == 'Volume'],
                         ['/var/lib/wbb-rehearsal/data:/var/lib/wbb-rehearsal/data:rw'])
        self.assertEqual((keys['ContainerName'], keys['Network'], keys['PodmanArgs']),
                         ('wbb-rehearsal', 'host', '--stop-timeout=20 --add-host=api.telegram.org:127.0.0.1'))

    def test_runs_the_image_s_own_command_no_exec(self):
        self.assertEqual([key for key, _ in directives(KIT_TEMPLATE) if key == 'Exec'], [])

    def test_the_helper_takes_it_one_placeholder_each(self):
        with open(KIT_TEMPLATE, encoding='utf-8') as f:
            self.assertEqual(wi._read_template(shim.REHEARSAL), f.readlines())


class Activate(ShimCase):
    def test_writes_the_kit_s_unit_only_into_its_quadlet_file_and_restarts_wbb_rehearsal(self):
        (result, calls) = self.activate(D1)
        self.assertEqual(result, (0, f'ACTIVATED {D1}\n', ''))
        self.assertEqual(calls, [[PODMAN, 'image', 'inspect', f'{REPO}@{D1}', '--format', 'json'], SHOW_ARGV,
                                 RELOAD, SHOW_ARGV, RESTART])
        self.assertEqual((os.listdir(self.quadlet_dir), self.written()),
                         (['wbb-rehearsal.container'], self.rendered_kit_template(D1)))

    def test_the_written_unit_pins_the_digest_and_the_bot_s_ids(self):
        self.activate(D1)
        self.assertEqual([line for line in self.written().splitlines() if line.startswith(('Image=', 'User=', 'Group='))],
                         [f'Image={REPO}@{D1}', f'User={UID}', f'Group={GID}'])

    def test_a_foreign_wbb_rehearsal_is_refused_by_its_own_name(self):
        runner = FakeRunner(inspect(D1), show('loaded', '', '/etc/systemd/system/wbb-rehearsal.service'))
        self.assertEqual(self.main(['activate', '--digest', D1], runner),
                         (2, '', f'REFUSED: wbb-rehearsal.service is not generated from {self.quadlet} '
                                 '(a unit elsewhere shadows it?)\n'))
        self.assertEqual(os.listdir(self.quadlet_dir), [])


class Sick(ShimCase):
    def test_the_sick_digest_s_unit_runs_a_command_that_exits_1_as_the_first_line_of_container(self):
        (result, _) = self.activate(D1, {'REHEARSAL_SICK_DIGEST': D1})
        lines = self.written().splitlines()
        at = lines.index('[Container]')
        self.assertEqual((result[0], lines[at + 1], [line for line in lines if line.startswith('Exec=')]),
                         (0, SICK, [SICK]))
        self.assertEqual(lines[:at + 1] + lines[at + 2:], self.rendered_kit_template(D1).splitlines())

    def test_another_digest_is_rendered_unchanged(self):
        (result, _) = self.activate(D2, {'REHEARSAL_SICK_DIGEST': D1})
        self.assertEqual((result, self.written()), ((0, f'ACTIVATED {D2}\n', ''), self.rendered_kit_template(D2)))

    def test_unset_or_empty_nothing_is_sick(self):
        for environ in ({}, {'REHEARSAL_SICK_DIGEST': ''}):
            with self.subTest(environ=environ):
                (result, _) = self.activate(D1, environ)
                self.assertEqual((result, self.written()), ((0, f'ACTIVATED {D1}\n', ''),
                                                            self.rendered_kit_template(D1)))

    def test_a_value_that_is_not_a_digest_is_refused_before_anything_runs(self):
        for bad in ('1' * 64, D1.upper(), D1 + '\n', f'{REPO}@{D1}', 'sha256:' + '1' * 63):
            with self.subTest(bad=bad):
                runner = FakeRunner()
                self.assertEqual(self.main(['activate', '--digest', D1], runner, {'REHEARSAL_SICK_DIGEST': bad}),
                                 (2, '', f'REFUSED: REHEARSAL_SICK_DIGEST={bad!r} is not a sha256:<64 lowercase '
                                         'hex> digest\n'))
                self.assertEqual((runner.calls, os.listdir(self.quadlet_dir)), ([], []))

    def test_a_kit_template_without_a_container_section_is_an_internal_error(self):
        render = shim.sick_render(lambda lines, digest, uid, gid: '[Unit]\nDescription=x\n', D1)
        with self.assertRaises(ValueError):
            render([], D1, UID, GID)


class Current(ShimCase):
    def test_asks_podman_and_systemd_about_wbb_rehearsal(self):
        runner = FakeRunner(done(stdout=f'{I1} {D1}\n'), show('loaded', self.quadlet, GENERATED))
        with open(self.quadlet, 'w', encoding='utf-8') as f:
            f.write(f'Image={REPO}@{D1}\n')
        self.assertEqual(self.main(['current'], runner),
                         (0, f'CURRENT quadlet={D1} container-image={I1} container-digest={D1} unit=quadlet\n', ''))
        self.assertEqual(runner.calls, [CONTAINER_ARGV, SHOW_ARGV])

    def test_production_s_unit_in_etc_is_not_the_kit_s_unit(self):
        # The kit's unit is foreign only when a file of its own name shadows it; production's is never asked.
        runner = FakeRunner(done(125, stderr='Error: no such container wbb-rehearsal\n'),
                            show('loaded', '', '/etc/systemd/system/wbb-rehearsal.service'))
        self.assertEqual(self.main(['current'], runner),
                         (0, 'CURRENT quadlet=none container-image=none container-digest=none unit=foreign\n', ''))
        self.assertEqual(runner.calls, [CONTAINER_ARGV, SHOW_ARGV])


class TheHelperIsLeftAsItWas(ShimCase):
    PRODUCTION_NAMES = ('warsaw-beer-bot', 'warsaw-beer-bot.service')

    def names(self):
        return (wi.CONTAINER, wi.UNIT), wi.render_template is self.render

    def setUp(self):
        super().setUp()
        self.render = wi.render_template

    def test_after_a_command(self):
        self.activate(D1, {'REHEARSAL_SICK_DIGEST': D1})
        self.assertEqual(self.names(), (self.PRODUCTION_NAMES, True))

    def test_after_a_usage_error(self):
        self.assertEqual(self.main(['no-such-command'], FakeRunner())[0], 64)
        self.assertEqual(self.names(), (self.PRODUCTION_NAMES, True))

    def test_after_an_exception_inside(self):
        with self.assertRaises(RuntimeError):
            with shim.rehearsal_names(D1):
                raise RuntimeError('inside')
        self.assertEqual(self.names(), (self.PRODUCTION_NAMES, True))


class AsAScript(unittest.TestCase):
    """The shim run as root runs it: `python3 -I <checkout>/scripts/ops/rehearsal/wbb_image_rehearsal.py`."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.kit = os.path.join(self.dir, 'scripts', 'ops', 'rehearsal')
        self.helper = os.path.join(self.dir, 'deploy', 'image', 'helper')
        os.makedirs(self.kit)
        shutil.copy(os.path.join(HERE, 'wbb_image_rehearsal.py'), self.kit)

    def run_copy(self, *args):
        r = subprocess.run([sys.executable, '-I', os.path.join(self.kit, 'wbb_image_rehearsal.py'), *args],
                           capture_output=True, text=True, timeout=60, cwd=tempfile.gettempdir())
        return r.returncode, r.stdout, r.stderr

    def test_imports_the_checkout_s_helper_and_leaves_no_bytecode_in_it(self):
        os.makedirs(self.helper)
        for name in ('wbb_image.py', 'bounded.py'):
            shutil.copy(os.path.join(ROOT, 'deploy', 'image', 'helper', name), self.helper)
        self.assertEqual(self.run_copy('--no-such-option')[:2], (64, ''))
        self.assertEqual(sorted(os.listdir(self.helper)), ['bounded.py', 'wbb_image.py'])

    def test_without_the_helper_it_exits_70_not_1(self):
        code, out, err = self.run_copy('current')
        self.assertEqual((code, out, err.splitlines()[-1]), (70, '', "ModuleNotFoundError: No module named 'wbb_image'"))


if __name__ == '__main__':
    unittest.main()
