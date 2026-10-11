"""installer.py: the release control plane's install under a temporary root, with a real git checkout and a
scripted runner for useradd/visudo/systemctl and a recording chown.

Plan: docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md, Task 4 (а)–(ж).
"""
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import installed as ins  # noqa: E402
import installer as inst  # noqa: E402
from fake_run import FakeRun, done  # noqa: E402
from test_installed import repo_files  # noqa: E402

UID, GID = os.getuid(), os.getgid()
DEPLOY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRIAL = 'wbb-trial'
TICK_FAILED = ins.installed_path('deploy/wbb-tick-failed.sh')

# A checkout with every kind of file the map knows: this installer's, other installers', test-only ones.
REPO_FILES = {
    'deploy/release/wbb_release.py': b'# helper\n',
    'deploy/release/tick.py': b'# tick\n',
    'deploy/release/payload-probe.cjs': b'// probe\n',
    'deploy/release/sub/inner.py': b'# nested\n',
    'deploy/release/test_tick.py': b'# test only\n',
    'deploy/release/fake_run.py': b'# test only\n',
    'deploy/release/release_testkit.py': b'# test only\n',
    'deploy/wbb-release.sh': b'#!/bin/sh\nexit 70\n',
    'deploy/wbb-tick.sh': b'#!/bin/sh\nexit 71\n',
    'deploy/wbb-tick-failed.sh': b'#!/bin/bash\nexit 0\n',
    'deploy/sudoers.d/wbb-release': b'ysi ALL=(root) NOPASSWD: /usr/local/libexec/wbb-release verify --sha *\n',
    'deploy/sudoers.d/warsaw-beer-bot': b'# merge-deploy rules\n',
    'deploy/wbb-tick.service': b'[Service]\nType=oneshot\n',
    'deploy/wbb-tick.timer': b'[Timer]\nOnActiveSec=5min\n',
    'deploy/wbb-tick-failed.service': b'[Service]\nType=oneshot\n',
    'deploy/wbb-autodeploy.service': b'[Service]\n',
    'deploy/wbb-autodeploy.timer': b'[Timer]\n',
    'deploy/warsaw-beer-bot.service': b'[Service]\n',
    'deploy/autodeploy.sh': b'#!/bin/bash\n',
    'deploy/litestream.yml': b'dbs: []\n',
}
# What the installer must put there, mode by mode (written out, not derived from installer.py).
EXPECTED = {
    '/usr/local/lib/wbb-release/wbb_release.py': ('deploy/release/wbb_release.py', 0o644),
    '/usr/local/lib/wbb-release/tick.py': ('deploy/release/tick.py', 0o644),
    '/usr/local/lib/wbb-release/payload-probe.cjs': ('deploy/release/payload-probe.cjs', 0o644),
    '/usr/local/lib/wbb-release/sub/inner.py': ('deploy/release/sub/inner.py', 0o644),
    '/usr/local/libexec/wbb-release': ('deploy/wbb-release.sh', 0o755),
    '/usr/local/bin/wbb-tick': ('deploy/wbb-tick.sh', 0o755),
    '/usr/local/libexec/wbb-tick-failed': ('deploy/wbb-tick-failed.sh', 0o755),
    '/etc/sudoers.d/wbb-release': ('deploy/sudoers.d/wbb-release', 0o440),
    '/etc/systemd/system/wbb-tick.service': ('deploy/wbb-tick.service', 0o644),
    '/etc/systemd/system/wbb-tick.timer': ('deploy/wbb-tick.timer', 0o644),
    '/etc/systemd/system/wbb-tick-failed.service': ('deploy/wbb-tick-failed.service', 0o644),
}
DIRS = {
    '/usr/local/lib/wbb-release': 0o755,
    '/usr/local/lib/wbb-release/sub': 0o755,
    '/var/lib/wbb-trial': 0o755,
    '/var/lib/wbb-deploy': 0o700,
    '/var/lib/wbb-deploy/receipts': 0o700,
    '/etc/wbb-deploy': 0o700,
}
NOLOGIN_USER = SimpleNamespace(pw_name=TRIAL, pw_uid=998, pw_gid=998, pw_shell='/usr/sbin/nologin')
TRIAL_GROUP = SimpleNamespace(gr_name=TRIAL, gr_gid=998, gr_mem=[])


def git(repo, *args):
    subprocess.run(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', *args], check=True,
                   capture_output=True)


class FakeUsers:
    def __init__(self, user=None, groups=()):
        self.user, self.groups = user, list(groups)

    def getpwnam(self, name):
        if self.user is None or name != self.user.pw_name:
            raise KeyError(name)
        return self.user

    def getgrall(self):
        return list(self.groups)


class Host:
    """The runner: git runs for real against the temporary checkout, everything else is scripted (FakeRun);
    useradd also adds the user to the fake account database, as the real one would."""

    def __init__(self, users, visudo=0, timer=b'disabled\n'):
        self.users = users
        self.fake = FakeRun()
        self.visudo_code, self.timer = visudo, timer
        self.order = []
        self.git_argvs = []

    def script(self, root):
        sudoers_tmp = os.path.join(root, 'etc/sudoers.d/.wbb-release.installing')
        self.fake.answers = {
            tuple(inst.USERADD_ARGV): done(),
            (inst.VISUDO, '-cf', sudoers_tmp): done(self.visudo_code, b'', b'parse error' if self.visudo_code else b''),
            (inst.SYSTEMCTL, 'daemon-reload'): done(),
            (inst.SYSTEMCTL, 'is-enabled', 'wbb-tick.timer'): done(1, self.timer),
        }

    def __call__(self, argv, *, timeout):
        if argv[0] == inst.GIT:
            self.git_argvs.append(tuple(argv))
            return subprocess.run(['git', *argv[1:]], timeout=timeout, capture_output=True)
        self.order.append(('run', tuple(argv)))
        result = self.fake(argv, timeout=timeout)
        if tuple(argv) == inst.USERADD_ARGV:
            self.users.user, self.users.groups = NOLOGIN_USER, [TRIAL_GROUP]
        return result

    def argvs(self):
        return [tuple(a) for a in self.fake.argvs()]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = os.path.join(self.tmp.name, 'repo')
        self.root = os.path.join(self.tmp.name, 'root')
        os.makedirs(self.root)
        subprocess.run(['git', 'init', '-q', self.repo], check=True)
        for rel, data in REPO_FILES.items():
            path = os.path.join(self.repo, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as f:
                f.write(data)
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'one')
        self.users = FakeUsers()
        self.host = Host(self.users)
        self.chowned = {}  # inode -> (uid, gid)
        self.chown_order = []  # inodes, in call order
        self.chown_name = {}  # inode -> the name the file had when it was chowned

    def chown(self, target, uid, gid):
        st = os.stat(target)
        self.chowned[st.st_ino] = (uid, gid)
        self.chown_order.append(st.st_ino)
        self.chown_name[st.st_ino] = os.readlink(f'/proc/self/fd/{target}') if isinstance(target, int) else target

    def main(self, *argv):
        self.host.script(self.root)
        out, err = io.StringIO(), io.StringIO()
        old = sys.stderr
        sys.stderr = err
        try:
            code = inst.main(list(argv), repo=self.repo, root=self.root, run=self.host, chown=self.chown,
                             users=self.users, owner=(UID, GID), out=out)
        finally:
            sys.stderr = old
        return code, out.getvalue(), err.getvalue()

    def p(self, path):
        return os.path.join(self.root, path.lstrip('/'))

    def tree(self):
        """Every path under the root with its (type, mode, inode, mtime_ns, bytes)."""
        out = {}
        for d, dirs, files in os.walk(self.root):
            for name in dirs + files:
                full = os.path.join(d, name)
                st = os.lstat(full)
                data = None
                if stat.S_ISREG(st.st_mode):
                    with open(full, 'rb') as f:
                        data = f.read()
                out['/' + os.path.relpath(full, self.root)] = (stat.S_IFMT(st.st_mode), stat.S_IMODE(st.st_mode),
                                                               st.st_ino, st.st_mtime_ns, data)
        return out


class FreshInstall(Base):
    def test_a_creates_every_file_with_its_mode_owner_and_bytes_and_every_directory(self):
        code, out, err = self.main()
        self.assertEqual((code, err), (0, ''), out)
        for dest, (src, mode) in EXPECTED.items():
            st = os.lstat(self.p(dest))
            with self.subTest(dest=dest):
                self.assertEqual(stat.S_IMODE(st.st_mode), mode)
                self.assertEqual(self.chowned[st.st_ino], (0, 0))
                with open(self.p(dest), 'rb') as f:
                    self.assertEqual(f.read(), REPO_FILES[src])
        for d, mode in DIRS.items():
            st = os.lstat(self.p(d))
            with self.subTest(dir=d):
                self.assertEqual((stat.S_ISDIR(st.st_mode), stat.S_IMODE(st.st_mode)), (True, mode))
                self.assertEqual(self.chowned[st.st_ino], (0, 0))
        self.assertIn(f'HEAD {subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()}', out)

    def test_a_installs_exactly_the_expected_files_and_nothing_test_only(self):
        self.main()
        files = {k for k, v in self.tree().items() if v[0] == stat.S_IFREG}
        self.assertEqual(files, set(EXPECTED))

    def test_a_creates_wbb_trial_as_the_plan_spells_it(self):
        self.main()
        self.assertEqual(self.host.argvs()[0], ('/usr/sbin/useradd', '--system', '--no-create-home', '--home-dir',
                                                '/nonexistent', '--shell', '/usr/sbin/nologin', '--user-group',
                                                'wbb-trial'))

    def test_a_order_is_library_wrappers_sudoers_units_then_daemon_reload(self):
        self.main()
        at = {dest: self.chown_order.index(os.lstat(self.p(dest)).st_ino) for dest in EXPECTED}
        lib = [at[d] for d in EXPECTED if d.startswith(ins.LIB_DIR + '/')]
        wrappers = [at[d] for d in (ins.ROOT_HELPER, ins.TICK_BIN, TICK_FAILED)]
        units = [at[d] for d in EXPECTED if d.startswith(ins.UNIT_DIR + '/')]
        self.assertLess(max(lib), min(wrappers))
        self.assertLess(max(wrappers), at['/etc/sudoers.d/wbb-release'])
        self.assertLess(at['/etc/sudoers.d/wbb-release'], min(units))
        self.assertEqual(len(lib) + len(wrappers) + 1 + len(units), len(EXPECTED))
        self.assertEqual(self.host.argvs()[-2:], [(inst.SYSTEMCTL, 'daemon-reload'),
                                                  (inst.SYSTEMCTL, 'is-enabled', 'wbb-tick.timer')])

    def test_a_every_file_is_written_as_a_dotted_temporary_in_its_directory_then_renamed(self):
        self.main()
        names = {dest: self.chown_name[os.lstat(self.p(dest)).st_ino] for dest in EXPECTED}
        want = {dest: self.p(os.path.join(os.path.dirname(dest), '.' + os.path.basename(dest) + '.installing'))
                for dest in EXPECTED}
        self.assertEqual(names, want)

    def test_a_leaves_no_temporary_file(self):
        self.main()
        self.assertEqual([p for p in self.tree() if p.endswith(inst.TMP_SUFFIX)], [])

    def test_a_reports_an_absent_token_without_failing(self):
        code, out, _ = self.main()
        self.assertEqual(code, 0)
        self.assertIn('token: /etc/wbb-deploy/github.env absent', out)


class Rerun(Base):
    def test_b_second_run_changes_nothing_and_exits_0(self):
        self.assertEqual(self.main()[0], 0)
        before = self.tree()
        code, out, err = self.main()
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(self.tree(), before)
        self.assertIn('installed: 0 change(s)', out)
        self.assertEqual(self.host.argvs().count(tuple(inst.USERADD_ARGV)), 1)


class Orphans(Base):
    def test_c_an_orphan_in_lib_dir_is_removed_and_nothing_outside_it(self):
        self.main()
        for rel in ('usr/local/lib/wbb-release/gone.py', 'etc/sudoers.d/other', 'etc/systemd/system/other.service',
                    'usr/local/bin/wbb-autodeploy'):
            with open(self.p(rel), 'wb') as f:
                f.write(b'x')
        code, out, _ = self.main()
        self.assertEqual(code, 0, out)
        self.assertFalse(os.path.lexists(self.p('usr/local/lib/wbb-release/gone.py')))
        self.assertIn('removed /usr/local/lib/wbb-release/gone.py', out)
        for rel in ('etc/sudoers.d/other', 'etc/systemd/system/other.service', 'usr/local/bin/wbb-autodeploy'):
            with open(self.p(rel), 'rb') as f:
                self.assertEqual(f.read(), b'x', rel)

    def test_c_another_installers_files_are_never_written(self):
        self.main()
        for dest in ('/etc/sudoers.d/warsaw-beer-bot', '/etc/systemd/system/wbb-autodeploy.service',
                     '/etc/systemd/system/warsaw-beer-bot.service', '/usr/local/bin/wbb-autodeploy',
                     '/etc/litestream.yml'):
            self.assertFalse(os.path.lexists(self.p(dest)), dest)


    def test_c_the_directory_of_a_removed_orphan_is_synced(self):
        # #834 AI review: an unlink not on disk can bring the module back after a power loss.
        self.main()
        with open(self.p('usr/local/lib/wbb-release/gone.py'), 'wb') as f:
            f.write(b'x')
        synced = []
        real = inst.Installer.fsync_dir
        with mock.patch.object(inst.Installer, 'fsync_dir', staticmethod(lambda d: (synced.append(d), real(d)))):
            code, out, _ = self.main()
        self.assertEqual(code, 0, out)
        self.assertEqual(synced, [self.p('usr/local/lib/wbb-release')])

class Visudo(Base):
    def test_d_rejected_sudoers_keeps_the_old_file_refuses_and_installs_no_unit(self):
        os.makedirs(self.p('etc/sudoers.d'))
        with open(self.p('etc/sudoers.d/wbb-release'), 'wb') as f:
            f.write(b'# old\n')
        os.chmod(self.p('etc/sudoers.d/wbb-release'), 0o440)
        self.host.visudo_code = 1
        code, out, err = self.main()
        self.assertEqual(code, 1)
        self.assertIn('REFUSED: visudo -cf rejected the new sudoers file (exit 1): parse error', err)
        with open(self.p('etc/sudoers.d/wbb-release'), 'rb') as f:
            self.assertEqual(f.read(), b'# old\n')
        self.assertEqual(os.listdir(self.p('etc/sudoers.d')), ['wbb-release'])
        self.assertFalse(os.path.lexists(self.p('etc/systemd/system/wbb-tick.service')))
        self.assertNotIn((inst.SYSTEMCTL, 'daemon-reload'), self.host.argvs())
        # Dependencies first: the library and the wrappers are already in place, and that is fine.
        for dest, src in (('usr/local/libexec/wbb-release', 'deploy/wbb-release.sh'),
                          ('usr/local/lib/wbb-release/tick.py', 'deploy/release/tick.py')):
            with open(self.p(dest), 'rb') as f:
                self.assertEqual(f.read(), REPO_FILES[src], dest)

    def test_d_visudo_checks_the_finished_dotted_temporary_file(self):
        self.main()
        self.assertIn((inst.VISUDO, '-cf', self.p('etc/sudoers.d/.wbb-release.installing')), self.host.argvs())


class Preconditions(Base):
    def test_e_dirty_checkout_is_refused_before_any_write(self):
        with open(os.path.join(self.repo, 'deploy/release/tick.py'), 'ab') as f:
            f.write(b'# local edit\n')
        code, _, err = self.main()
        self.assertEqual(code, 1)
        self.assertIn('REFUSED: the checkout', err)
        self.assertIn('M deploy/release/tick.py', err)
        self.assertEqual(self.tree(), {})
        self.assertEqual(self.host.argvs(), [])

    def test_f_existing_wbb_trial_with_a_login_shell_is_refused_and_left_alone(self):
        user = SimpleNamespace(pw_name=TRIAL, pw_uid=998, pw_gid=998, pw_shell='/bin/bash')
        self.users.user, self.users.groups = user, [TRIAL_GROUP]
        code, _, err = self.main()
        self.assertEqual(code, 1)
        self.assertIn('REFUSED: user wbb-trial exists but is not fit for the sandbox: shell /bin/bash', err)
        self.assertEqual(self.tree(), {})
        self.assertEqual(self.host.argvs(), [])
        self.assertIs(self.users.user, user)

    def test_f_existing_wbb_trial_with_a_supplementary_group_or_a_human_uid_is_refused(self):
        cases = (
            (NOLOGIN_USER, [TRIAL_GROUP, SimpleNamespace(gr_name='sudo', gr_gid=27, gr_mem=[TRIAL])],
             'supplementary groups sudo (want none)'),
            (SimpleNamespace(pw_name=TRIAL, pw_uid=1000, pw_gid=998, pw_shell='/usr/sbin/nologin'), [TRIAL_GROUP],
             'uid 1000 (want a system uid, 1..999 by /etc/login.defs)'),
            (SimpleNamespace(pw_name=TRIAL, pw_uid=0, pw_gid=998, pw_shell='/usr/sbin/nologin'), [TRIAL_GROUP],
             'uid 0 (want a system uid, 1..999 by /etc/login.defs)'),
        )
        for user, groups, why in cases:
            with self.subTest(why=why):
                self.users.user, self.users.groups = user, groups
                code, _, err = self.main()
                self.assertEqual(code, 1)
                self.assertIn(why, err)
                self.assertEqual(self.tree(), {})

    def test_f_sys_uid_max_comes_from_login_defs(self):
        os.makedirs(self.p('etc'))
        with open(self.p('etc/login.defs'), 'w') as f:
            f.write('# comment\nSYS_UID_MAX\t\t500\n')
        self.users.user, self.users.groups = NOLOGIN_USER, [TRIAL_GROUP]
        code, _, err = self.main()
        self.assertEqual(code, 1)
        self.assertIn('uid 998 (want a system uid, 1..500 by /etc/login.defs)', err)

    def test_f_existing_fit_wbb_trial_is_kept_without_useradd(self):
        self.users.user, self.users.groups = NOLOGIN_USER, [TRIAL_GROUP]
        self.assertEqual(self.main()[0], 0)
        self.assertNotIn(tuple(inst.USERADD_ARGV), self.host.argvs())


class FromGitObjects(Base):
    """e2e review N1: what is installed is HEAD's objects, never the worktree's files."""

    def test_the_bytes_are_head_s_even_where_the_worktree_differs_unseen(self):
        # assume-unchanged hides the edit from `git status`: only HEAD's object can be what gets installed.
        git(self.repo, 'update-index', '--assume-unchanged', 'deploy/release/tick.py')
        with open(os.path.join(self.repo, 'deploy/release/tick.py'), 'wb') as f:
            f.write(b'# worktree only\n')
        code, out, err = self.main()
        self.assertEqual((code, err), (0, ''), out)
        with open(self.p('usr/local/lib/wbb-release/tick.py'), 'rb') as f:
            self.assertEqual(f.read(), REPO_FILES['deploy/release/tick.py'])

    def test_a_cut_git_answer_is_never_installed(self):
        """bounded.run keeps a head and a tail of a flood: a truncated blob is an internal error, not a copy."""
        real = self.host.__call__

        def cut(argv, *, timeout):
            r = real(argv, timeout=timeout)
            r.truncated = argv[-2:-1] == ['blob']
            return r
        self.host.script(self.root)
        err = io.StringIO()
        old, sys.stderr = sys.stderr, err
        try:
            code = inst.main([], repo=self.repo, root=self.root, run=cut, chown=self.chown, users=self.users,
                             owner=(UID, GID), out=io.StringIO())
        finally:
            sys.stderr = old
        first = subprocess.run(['git', '-C', self.repo, 'rev-parse', 'HEAD:deploy/release/payload-probe.cjs'],
                               capture_output=True, text=True).stdout.strip()
        self.assertEqual((code, err.getvalue().splitlines()[-1]),
                         (70, f'helpers.HelperError: cat-file blob {first}: output too large'))
        self.assertEqual(self.tree(), {})

    def test_a_tracked_symlink_in_scope_is_refused_before_any_write(self):
        os.symlink('tick.py', os.path.join(self.repo, 'deploy/release/alias.py'))
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'link')
        head = subprocess.run(['git', '-C', self.repo, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout
        code, _, err = self.main()
        self.assertEqual((code, err), (1, f'REFUSED: HEAD {head.strip()} tracks what is not a regular file where this '
                                          'installer installs: deploy/release/alias.py (120000) (a symlink is '
                                          '120000, a submodule 160000) — not installing\n'))
        self.assertEqual((self.tree(), self.host.argvs()), ({}, []))

    def test_a_tracked_submodule_in_scope_is_refused(self):
        head = subprocess.run(['git', '-C', self.repo, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout
        git(self.repo, 'update-index', '--add', '--cacheinfo', f'160000,{head.strip()},deploy/release/vendored')
        git(self.repo, 'commit', '-q', '-m', 'submodule')
        os.mkdir(os.path.join(self.repo, 'deploy/release/vendored'))  # an uninitialised submodule: status is clean
        code, _, err = self.main()
        self.assertEqual(code, 1)
        self.assertIn('deploy/release/vendored (160000)', err)
        self.assertEqual(self.tree(), {})

    def test_a_tracked_symlink_outside_the_scope_is_not_this_installer_s_business(self):
        os.symlink('autodeploy.sh', os.path.join(self.repo, 'deploy/other-link.sh'))
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'link elsewhere')
        code, out, err = self.main()
        self.assertEqual((code, err), (0, ''), out)


class WhatIsAlreadyThere(Base):
    """e2e review S4: links and leftovers at the destinations are replaced or removed, never followed."""

    def outside(self, name):
        """A file outside the root that a followed link would reach."""
        path = os.path.join(self.tmp.name, name)
        with open(path, 'wb') as f:
            f.write(b'outside\n')
        os.chmod(path, 0o600)
        return path

    def assert_untouched(self, path):
        st = os.lstat(path)
        with open(path, 'rb') as f:
            self.assertEqual((f.read(), stat.S_IMODE(st.st_mode)), (b'outside\n', 0o600))

    def test_a_symlink_at_the_destination_is_replaced_by_the_file_and_its_target_untouched(self):
        target = self.outside('x')
        os.makedirs(self.p('etc/sudoers.d'))
        os.symlink(target, self.p('etc/sudoers.d/wbb-release'))
        code, out, err = self.main()
        self.assertEqual((code, err), (0, ''), out)
        st = os.lstat(self.p('etc/sudoers.d/wbb-release'))
        with open(self.p('etc/sudoers.d/wbb-release'), 'rb') as f:
            self.assertEqual((stat.S_ISREG(st.st_mode), stat.S_IMODE(st.st_mode), f.read()),
                             (True, 0o440, REPO_FILES['deploy/sudoers.d/wbb-release']))
        self.assert_untouched(target)

    def test_a_leftover_temporary_file_or_link_of_an_aborted_run_is_neither_kept_nor_followed(self):
        target = self.outside('x')
        os.makedirs(self.p('etc/sudoers.d'))
        os.makedirs(self.p('usr/local/libexec'))
        with open(self.p('etc/sudoers.d/.wbb-release.installing'), 'wb') as f:
            f.write(b'half a file')
        os.symlink(target, self.p('usr/local/libexec/.wbb-release.installing'))
        code, out, err = self.main()
        self.assertEqual((code, err), (0, ''), out)
        self.assertEqual(sorted(os.listdir(self.p('etc/sudoers.d'))), ['wbb-release'])
        self.assertEqual(sorted(os.listdir(self.p('usr/local/libexec'))), ['wbb-release', 'wbb-tick-failed'])
        with open(self.p('usr/local/libexec/wbb-release'), 'rb') as f:
            self.assertEqual(f.read(), REPO_FILES['deploy/wbb-release.sh'])
        self.assert_untouched(target)

    def test_a_symlinked_directory_inside_the_library_is_removed_not_followed(self):
        outside = os.path.join(self.tmp.name, 'elsewhere')
        os.makedirs(outside)
        kept = os.path.join(outside, 'gone.py')
        with open(kept, 'wb') as f:
            f.write(b'outside\n')
        os.chmod(kept, 0o600)
        self.main()
        os.symlink(outside, self.p('usr/local/lib/wbb-release/linked'))
        code, out, err = self.main()
        self.assertEqual((code, err), (0, ''), out)
        self.assertIn('removed /usr/local/lib/wbb-release/linked (a symlink)', out)
        self.assertEqual(os.path.lexists(self.p('usr/local/lib/wbb-release/linked')), False)
        self.assertEqual(os.listdir(outside), ['gone.py'])
        self.assert_untouched(kept)

    def test_a_directory_at_a_destination_is_refused_before_any_write(self):
        os.makedirs(self.p('etc/sudoers.d/wbb-release/inner'))
        code, _, err = self.main()
        self.assertEqual((code, err), (1, 'REFUSED: a directory where a file is installed: /etc/sudoers.d/wbb-release; '
                                          'not touching it\n'))
        self.assertEqual(sorted(self.tree()), ['/etc', '/etc/sudoers.d', '/etc/sudoers.d/wbb-release',
                                               '/etc/sudoers.d/wbb-release/inner'])
        self.assertEqual(self.host.argvs(), [])


    def test_a_symlinked_directory_on_the_way_is_refused_before_any_write(self):
        # #834 AI review: os.path.isdir followed the link, and the write landed in its target.
        outside = os.path.join(self.tmp.name, 'elsewhere')
        os.makedirs(outside)
        os.makedirs(self.p('etc'))
        os.symlink(outside, self.p('etc/sudoers.d'))
        code, _, err = self.main()
        self.assertEqual((code, err), (1, 'REFUSED: a symlink or a non-directory on the way to an installed file: '
                                          '/etc/sudoers.d; not touching it\n'))
        self.assertEqual((sorted(self.tree()), os.listdir(outside), self.host.argvs()),
                         (['/etc', '/etc/sudoers.d'], [], []))

    def test_a_symlink_higher_up_the_path_is_refused_too(self):
        outside = os.path.join(self.tmp.name, 'elsewhere')
        os.makedirs(outside)
        os.symlink(outside, self.p('usr'))
        code, _, err = self.main()
        self.assertEqual((code, err), (1, 'REFUSED: a symlink or a non-directory on the way to an installed file: '
                                          '/usr; not touching it\n'))
        self.assertEqual(os.listdir(outside), [])

class RootLeavesNothingInTheCheckout(Base):
    """e2e review S3: run as root in the operator's checkout, the installer must not leave root-owned files there."""
    GIT_PREFIX = ('/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
                  '-C')

    def test_every_git_call_takes_no_optional_locks_no_fsmonitor_and_no_hooks(self):
        self.main()
        self.main('--check')
        self.assertEqual(sorted({a[:8] for a in self.host.git_argvs}), [self.GIT_PREFIX + (self.repo,)])

    def test_the_launcher_runs_the_installer_isolated_and_without_bytecode(self):
        with open(os.path.join(DEPLOY, 'install-release.sh'), encoding='utf-8') as f:
            lines = f.read().splitlines()
        self.assertEqual([x for x in lines if x.startswith('exec ')],
                         ['exec /usr/bin/python3 -I -B deploy/release/installer.py "$@"'])

    def test_running_the_launcher_writes_no_pycache_into_the_checkout(self):
        """A copy of install-release.sh and the library, the root check replaced (sed-like) so a non-root test
        runs it; --help imports every module of the installer and exits before any work."""
        copy = os.path.join(self.tmp.name, 'checkout')
        shutil.copytree(os.path.join(DEPLOY, 'release'), os.path.join(copy, 'deploy', 'release'),
                        ignore=shutil.ignore_patterns('__pycache__', 'test_*'))
        with open(os.path.join(DEPLOY, 'install-release.sh'), encoding='utf-8') as f:
            text = f.read()
        self.assertIn('"$(id -u)"', text)
        with open(os.path.join(copy, 'deploy', 'install-release.sh'), 'w', encoding='utf-8') as f:
            f.write(text.replace('"$(id -u)"', '0'))
        r = subprocess.run(['bash', os.path.join(copy, 'deploy', 'install-release.sh'), '--help'],
                           capture_output=True, text=True, timeout=60, cwd=self.tmp.name)
        self.assertEqual((r.returncode, r.stderr), (0, ''))
        self.assertEqual([d for d, _, _ in os.walk(copy) if os.path.basename(d) == '__pycache__'], [])


class NoSwitching(Base):
    def test_g_the_only_systemctl_verbs_are_daemon_reload_and_is_enabled(self):
        self.main()
        self.main('--check')
        verbs = {a[1] for a in self.host.argvs() if a[0] == inst.SYSTEMCTL}
        self.assertEqual(verbs, {'daemon-reload', 'is-enabled'})
        self.assertEqual({a[0] for a in self.host.argvs()}, {inst.USERADD, inst.VISUDO, inst.SYSTEMCTL})

    def test_zh_nothing_is_written_under_opt(self):
        os.makedirs(self.p('opt/warsaw-beer-bot'))
        self.main()
        self.assertEqual(os.listdir(self.p('opt/warsaw-beer-bot')), [])
        self.assertEqual([p for p in self.tree() if p.startswith('/opt/') and p != '/opt/warsaw-beer-bot'], [])

    def test_zh_the_timer_state_is_printed_for_information(self):
        _, out, _ = self.main()
        self.assertIn('wbb-tick.timer: disabled (information only', out)


class Check(Base):
    def test_ie_check_on_an_empty_host_writes_nothing_and_exits_1(self):
        code, out, _ = self.main('--check')
        self.assertEqual(code, 1)
        self.assertEqual(self.tree(), {})
        self.assertIn('DIFF /usr/local/libexec/wbb-release: missing (deploy/wbb-release.sh)', out)
        self.assertIn('DIFF user wbb-trial: absent', out)
        self.assertIn('DIFF /var/lib/wbb-deploy/receipts: missing', out)
        self.assertEqual({a[0] for a in self.host.argvs()}, {inst.SYSTEMCTL})

    def test_ie_check_after_install_is_0(self):
        self.main()
        code, out, _ = self.main('--check')
        self.assertEqual(code, 0, out)
        self.assertIn('0 difference(s)', out)

    def test_ie_check_names_a_changed_file_a_wrong_mode_and_an_orphan_and_writes_nothing(self):
        self.main()
        with open(self.p('usr/local/lib/wbb-release/tick.py'), 'ab') as f:
            f.write(b'# drift\n')
        os.chmod(self.p('etc/systemd/system/wbb-tick.timer'), 0o664)
        with open(self.p('usr/local/lib/wbb-release/gone.py'), 'wb') as f:
            f.write(b'x')
        before = self.tree()
        code, out, _ = self.main('--check')
        self.assertEqual(code, 1)
        self.assertEqual(self.tree(), before)
        self.assertIn('DIFF /usr/local/lib/wbb-release/tick.py: content differs from the checkout', out)
        self.assertIn(f'DIFF /etc/systemd/system/wbb-tick.timer: owner {UID}:{GID} mode 0664 '
                      f'(want {UID}:{GID} 0644)', out)
        self.assertIn('DIFF /usr/local/lib/wbb-release/gone.py: installed, but nothing in the checkout installs it',
                      out)
        self.assertIn('3 difference(s)', out)

    def test_ie_check_flags_an_unusable_token_and_accepts_a_good_one(self):
        self.main()
        token = self.p('etc/wbb-deploy/github.env')
        with open(token, 'w') as f:
            f.write('WBB_GITHUB_TOKEN=a\nWBB_GITHUB_TOKEN=b\n')
        os.chmod(token, 0o600)
        code, out, _ = self.main('--check')
        self.assertEqual(code, 1)
        self.assertIn('expected exactly one non-empty WBB_GITHUB_TOKEN=', out)
        with open(token, 'w') as f:
            f.write('WBB_GITHUB_TOKEN=secret-value\n')
        code, out, _ = self.main('--check')
        self.assertEqual(code, 0, out)
        self.assertIn('token: /etc/wbb-deploy/github.env present', out)
        self.assertNotIn('secret-value', out)


    def test_ie_install_counts_an_unusable_token_as_a_difference_like_check(self):
        # #834 AI review: install printed it and still exited 0.
        self.main()
        token = self.p('etc/wbb-deploy/github.env')
        with open(token, 'w') as f:
            f.write('WBB_GITHUB_TOKEN=a\nWBB_GITHUB_TOKEN=b\n')
        os.chmod(token, 0o600)
        code, out, _ = self.main()
        self.assertEqual(code, 1)
        self.assertIn('1 difference(s) remain', out)

class Usage(Base):
    def test_unknown_argument_is_64(self):
        with self.assertRaises(SystemExit) as e:
            self.main('--enable')
        self.assertEqual(e.exception.code, 64)


class Scope(unittest.TestCase):
    def test_the_real_repo_installs_exactly_the_library_the_wrappers_the_sudoers_file_and_the_tick_units(self):
        files = repo_files('deploy', 'scripts')
        got = {dest for _, _, dest in inst.plan(files)}
        library = {ins.installed_path(f) for f in repo_files('deploy/release') if ins.installed_path(f) is not None}
        others = {ins.ROOT_HELPER, ins.TICK_BIN, TICK_FAILED, '/etc/sudoers.d/wbb-release',
                  '/etc/systemd/system/wbb-tick.service', '/etc/systemd/system/wbb-tick.timer',
                  '/etc/systemd/system/wbb-tick-failed.service'}
        self.assertEqual(got, library | others)
        self.assertIn('/usr/local/lib/wbb-release/wbb_release.py', library)
        self.assertEqual({d for d in library if not d.startswith(ins.LIB_DIR + '/')}, set())


if __name__ == '__main__':
    unittest.main()
