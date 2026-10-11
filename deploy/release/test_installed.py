"""installed.installed_path: every held installed-copy pattern has a map, and no test module is installed.

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-b-core.md, Task 1.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gates  # noqa: E402
import installed as ins  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


def repo_files(*tops):
    """The repo's files under tops, as repo-relative posix paths (bytecode caches left out)."""
    found = []
    for top in tops:
        for d, dirs, files in os.walk(os.path.join(REPO, top)):
            dirs[:] = [x for x in dirs if x != '__pycache__']
            found += [os.path.relpath(os.path.join(d, f), REPO).replace(os.sep, '/') for f in files]
    return sorted(found)


class Map(unittest.TestCase):
    def test_every_installed_copies_pattern_maps_at_least_one_repo_file(self):
        files = repo_files('deploy', 'scripts/ops')
        uncovered = [p for p in gates.INSTALLED_COPIES
                     if not any(gates.matches(f, p) and ins.installed_path(f) is not None for f in files)]
        self.assertEqual(uncovered, [])

    def test_no_test_module_of_deploy_release_is_installed(self):
        installed = [f for f in repo_files('deploy/release') if ins.installed_path(f) is not None]
        self.assertEqual([f for f in installed if os.path.basename(f).startswith(('test_', 'fake_'))], [])
        self.assertNotIn('deploy/release/release_testkit.py', installed)
        self.assertIn('deploy/release/tick.py', installed)

    def test_the_controller_goes_to_the_library_directory(self):
        self.assertEqual(ins.installed_path('deploy/release/wbb_release.py'), '/usr/local/lib/wbb-release/wbb_release.py')
        self.assertEqual(ins.installed_path('deploy/release/payload-probe.cjs'),
                         '/usr/local/lib/wbb-release/payload-probe.cjs')

    def test_test_only_files_have_no_copy(self):
        for path in ('deploy/release/test_activate.py', 'deploy/release/fake_host.py', 'deploy/release/fake_run.py',
                     'deploy/release/release_testkit.py', 'deploy/release/__pycache__/tick.cpython-312.pyc',
                     'deploy/release/sub/test_x.py'):
            with self.subTest(path):
                self.assertIsNone(ins.installed_path(path))

    def test_units_sudoers_and_merge_deploy_copies(self):
        cases = {
            'deploy/warsaw-beer-bot.service': '/etc/systemd/system/warsaw-beer-bot.service',
            'deploy/litestream.service': '/etc/systemd/system/litestream.service',
            'deploy/wbb-autodeploy.timer': '/etc/systemd/system/wbb-autodeploy.timer',
            'deploy/wbb-reboot-request.path': '/etc/systemd/system/wbb-reboot-request.path',
            'deploy/sudoers.d/warsaw-beer-bot': '/etc/sudoers.d/warsaw-beer-bot',
            'deploy/litestream.yml': '/etc/litestream.yml',
            'deploy/db-snapshot.sh': '/usr/local/bin/wbb-db-snapshot',
            'deploy/autodeploy.sh': '/usr/local/bin/wbb-autodeploy',
            'deploy/read-env.sh': '/usr/local/bin/wbb-read-env',
            'deploy/trial-migrate.cjs': '/usr/local/bin/wbb-trial-migrate',
            'scripts/ops/reboot_request.py': '/usr/local/libexec/wbb-reboot-request',
            'scripts/ops/host_patch_collect.py': '/usr/local/libexec/wbb-host-patch-collect',
            # plan C-core "Рішення" п.5, п.7: the control plane's entry points and the tick's failure notice
            'deploy/wbb-release.sh': '/usr/local/libexec/wbb-release',
            'deploy/wbb-tick.sh': '/usr/local/bin/wbb-tick',
            'deploy/wbb-tick-failed.sh': '/usr/local/libexec/wbb-tick-failed',
        }
        for path, want in cases.items():
            with self.subTest(path):
                self.assertEqual(ins.installed_path(path), want)

    def test_the_entry_points_are_the_names_the_adapters_call(self):
        self.assertEqual((ins.installed_path('deploy/wbb-release.sh'), ins.installed_path('deploy/wbb-tick.sh')),
                         (ins.ROOT_HELPER, ins.TICK_BIN))

    def test_every_repo_file_the_wrapper_pattern_holds_is_installed(self):
        """`deploy/wbb-*.sh` holds a merge (gates) only for what the installer copies: no unrelated script."""
        held = [f for f in repo_files('deploy') if gates.matches(f, 'deploy/wbb-*.sh')]
        self.assertIn('deploy/wbb-*.sh', gates.INSTALLED_COPIES)
        self.assertEqual([f for f in held if ins.installed_path(f) is None], [])

    def test_a_template_and_files_outside_the_patterns_have_no_copy(self):
        for path in ('deploy/litestream.env.example', 'deploy/README.md', 'deploy/deploy.sh',
                     'deploy/service.d/x.service', 'src/index.ts'):
            with self.subTest(path):
                self.assertIsNone(ins.installed_path(path))



class Digestable(unittest.TestCase):
    """installed.digestable: what `wbb-release digest` (root) may hash for the operator (plan C-core "Рішення" п.3)."""

    def test_installed_sudoers_files_and_the_litestream_config(self):
        for path in ('/etc/sudoers.d/wbb-release', '/etc/sudoers.d/warsaw-beer-bot', '/etc/sudoers.d/A_b-9',
                     '/etc/litestream.yml'):
            with self.subTest(path):
                self.assertIs(ins.digestable(path), True)

    def test_anything_else_is_refused(self):
        for path in ('/etc/shadow', '/etc/sudoers', '/etc/sudoers.d', '/etc/sudoers.d/', '/etc/sudoers.d/..',
                     '/etc/sudoers.d/.', '/etc/sudoers.d/../shadow', '/etc/sudoers.d/.hidden', '/etc/sudoers.d/a.b',
                     '/etc/sudoers.d/a~', '/etc/sudoers.d/a b', '/etc/sudoers.d/a\n', '/etc/sudoers.d/sub/x',
                     '/etc//sudoers.d/x', 'etc/sudoers.d/x', '/etc/sudoers.d/wbb-relеase', '/etc/litestream.yml/',
                     '/etc/litestream.yml.bak', '/etc/./litestream.yml', '/usr/local/libexec/wbb-release',
                     '/usr/local/lib/wbb-release/tick.py', '', None, b'/etc/litestream.yml'):
            with self.subTest(path):
                self.assertIs(ins.digestable(path), False)

    def test_every_digestable_destination_is_one_the_repo_installs_there(self):
        """The helper cannot see the repo: the rule it applies must only ever admit images of installed_path."""
        self.assertIn('/etc/litestream.yml', ins.COPIES.values())
        self.assertEqual(ins.installed_path('deploy/sudoers.d/A_b-9'), '/etc/sudoers.d/A_b-9')

    def test_every_installed_copy_root_must_digest_is_digestable(self):
        """What the operator may be unable to read (sudoers 0440; the litestream config, if closed) has the root path."""
        dests = [ins.installed_path(f) for f in repo_files('deploy')]
        self.assertEqual(sorted(d for d in dests if d is not None and ins.digestable(d)),
                         ['/etc/litestream.yml', '/etc/sudoers.d/warsaw-beer-bot'])


if __name__ == '__main__':
    unittest.main()
