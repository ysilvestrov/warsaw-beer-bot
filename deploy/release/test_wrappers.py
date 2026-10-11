"""The two installed entry points (deploy/wbb-release.sh, deploy/wbb-tick.sh) and what a broken import exits with.

Plan: docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md, "Рішення" п.5, п.6, Task 1.
A wrapper takes no parameter: the test copies it with its library directory replaced by a temp one (sed-like), as
scripts/deploy-rsync.test.ts does with the filter. The import tests run a temp copy of the controller's modules
under `python3 -I` (what the wrappers run), with one module replaced by one that raises on import.
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOY = os.path.dirname(HERE)
LIB = '/usr/local/lib/wbb-release'
# Prints its argv and whether it runs isolated, then exits with the code given as its first argument.
TARGET = 'import sys\nprint(sys.argv[1:], sys.flags.isolated)\nsys.exit(int(sys.argv[1]))\n'


class Wrapper(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)

    def copy(self, name):
        with open(os.path.join(DEPLOY, name), encoding='utf-8') as f:
            text = f.read()
        path = os.path.join(self.dir, name)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text.replace(LIB, os.path.join(self.dir, 'lib')))
        return text, path

    def run_sh(self, path, *args):
        r = subprocess.run(['sh', path, *args], capture_output=True, text=True, timeout=30)
        return r.returncode, r.stdout, r.stderr

    def target(self, script):
        os.makedirs(os.path.join(self.dir, 'lib'), exist_ok=True)
        with open(os.path.join(self.dir, 'lib', script), 'w', encoding='utf-8') as f:
            f.write(TARGET)

    def test_the_wrappers_run_the_installed_library_isolated(self):
        for name, script in (('wbb-release.sh', 'wbb_release.py'), ('wbb-tick.sh', 'tick.py')):
            with self.subTest(name):
                text, _ = self.copy(name)
                self.assertEqual(text.splitlines()[0], '#!/bin/sh')
                self.assertIn(f'exec /usr/bin/python3 -I -B {LIB}/{script} "$@"\n', text)

    def test_the_arguments_and_the_exit_code_pass_through_unchanged(self):
        for name, script in (('wbb-release.sh', 'wbb_release.py'), ('wbb-tick.sh', 'tick.py')):
            with self.subTest(name):
                _, path = self.copy(name)
                self.target(script)
                self.assertEqual(self.run_sh(path, '3', 'verify', '--sha', 'a b', ''),
                                 (3, "['3', 'verify', '--sha', 'a b', ''] 1\n", ''))

    def test_the_installed_library_gets_no_bytecode_written_into_it(self):
        """e2e review S3: run as root, the helper would leave root-owned __pycache__ in the library directory."""
        for name, script in (('wbb-release.sh', 'wbb_release.py'), ('wbb-tick.sh', 'tick.py')):
            with self.subTest(name):
                _, path = self.copy(name)
                lib = os.path.join(self.dir, 'lib')
                shutil.rmtree(lib, ignore_errors=True)
                shutil.copytree(HERE, lib, ignore=shutil.ignore_patterns('__pycache__', 'test_*'))
                code, out, _ = self.run_sh(path, '--no-such-option')
                self.assertEqual((code, out), (64, ''))
                self.assertEqual(os.path.exists(os.path.join(lib, '__pycache__')), False)

    def test_without_the_library_the_release_helper_exits_70_not_2(self):
        _, path = self.copy('wbb-release.sh')
        code, out, err = self.run_sh(path, 'verify', '--sha', 'x')
        self.assertEqual((code, out, err), (70, '', f'wbb-release: {self.dir}/lib/wbb_release.py is not installed '
                                                    '(sudo bash deploy/install-release.sh)\n'))

    def test_an_entry_script_that_does_not_compile_exits_70_or_71_not_1(self):
        """e2e review S2: its own SyntaxError comes before its import guard; Python alone would exit 1."""
        for name, script, code in (('wbb-release.sh', 'wbb_release.py', 70), ('wbb-tick.sh', 'tick.py', 71)):
            with self.subTest(name):
                _, path = self.copy(name)
                os.makedirs(os.path.join(self.dir, 'lib'), exist_ok=True)
                with open(os.path.join(self.dir, 'lib', script), 'w', encoding='utf-8') as f:
                    f.write('import sys\nmatch sys.argv:\n    case [_, *rest] if (x := 1:\n        pass\n')
                got, out, err = self.run_sh(path, 'verify')
                self.assertEqual((got, out, err.splitlines()[-1]),
                                 (code, '', f'{name[:-3]}: {self.dir}/lib/{script} does not compile under '
                                            '/usr/bin/python3'))
                self.assertIn('SyntaxError', err)

    def test_without_the_library_the_tick_exits_71(self):
        _, path = self.copy('wbb-tick.sh')
        code, out, err = self.run_sh(path, 'timer')
        self.assertEqual((code, out, err), (71, '', f'wbb-tick: {self.dir}/lib/tick.py is not installed '
                                                    '(sudo bash deploy/install-release.sh)\n'))


class BrokenImport(unittest.TestCase):
    """A module of the library that fails on import is an internal error of the entry point, never Python's 1."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        for name in os.listdir(HERE):
            if name.endswith('.py') and not name.startswith(('test_', 'fake_')):
                shutil.copy(os.path.join(HERE, name), self.dir)

    def run_broken(self, script, broken, *args):
        with open(os.path.join(self.dir, broken), 'w', encoding='utf-8') as f:
            f.write("raise ImportError('broken on purpose')\n")
        # From another directory, isolated: the module finds its siblings by its own path only.
        r = subprocess.run([sys.executable, '-I', os.path.join(self.dir, script), *args], capture_output=True,
                           text=True, timeout=60, cwd=tempfile.gettempdir())
        return r.returncode, r.stdout, r.stderr.splitlines()[-1]

    def test_the_release_helper_exits_70(self):
        self.assertEqual(self.run_broken('wbb_release.py', 'trial.py', 'verify', '--sha', '0' * 40),
                         (70, '', 'ImportError: broken on purpose'))

    def test_the_tick_exits_71(self):
        self.assertEqual(self.run_broken('tick.py', 'prepare.py', 'timer'), (71, '', 'ImportError: broken on purpose'))

    def test_imported_by_an_adapter_the_failure_stays_an_exception(self):
        """helpers_adapter imports wbb_release: inside tick's make_env the failure must be catchable (EnvFailed),
        not a SystemExit that skips the notice."""
        with open(os.path.join(self.dir, 'trial.py'), 'w', encoding='utf-8') as f:
            f.write("raise ImportError('broken on purpose')\n")
        code = ('import sys\nsys.path.insert(0, sys.argv[1])\n'
                'try:\n    import helpers_adapter\nexcept Exception as e:\n    print(type(e).__name__, e)\n')
        r = subprocess.run([sys.executable, '-I', '-c', code, self.dir], capture_output=True, text=True, timeout=60,
                           cwd=tempfile.gettempdir())
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, 'ImportError broken on purpose\n', ''))

    def test_a_whole_copy_imports_under_isolation(self):
        """The guard is not what makes the copy fail: intact, the entry point reaches its own usage error."""
        r = subprocess.run([sys.executable, '-I', os.path.join(self.dir, 'wbb_release.py')], capture_output=True,
                           text=True, timeout=60, cwd=tempfile.gettempdir())
        self.assertEqual((r.returncode, r.stdout), (64, ''))


class Executable(unittest.TestCase):
    def test_the_wrappers_are_executable_in_the_repo(self):
        for name in ('wbb-release.sh', 'wbb-tick.sh'):
            with self.subTest(name):
                self.assertEqual(stat.S_IMODE(os.stat(os.path.join(DEPLOY, name)).st_mode) & 0o111, 0o111)


if __name__ == '__main__':
    unittest.main()
