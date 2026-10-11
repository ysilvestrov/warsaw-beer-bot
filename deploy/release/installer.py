"""Install the release control plane on the host, switching nothing (stage В core, run as root by a human).

Plan: docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md, "Рішення" п.1, п.2, п.4,
п.5, п.7, п.8, Task 4. Entry point: `sudo bash deploy/install-release.sh [--check]`.

What it installs is an explicit part of installed.installed_path's map (SCOPE below), each copy from the git objects
of HEAD of the clean checkout it runs in (never the worktree's files; a symlink or a submodule HEAD tracks in scope
is a refusal):

  deploy/release/** (no test modules)  -> LIB_DIR                  root:root 0644, directories 0755
  the two wrappers, wbb-tick-failed    -> ROOT_HELPER, TICK_BIN, … root:root 0755
  deploy/sudoers.d/wbb-release         -> SUDOERS_DIR/wbb-release  root:root 0440, `visudo -cf` before the rename
  the tick's three units               -> UNIT_DIR                 root:root 0644, then `systemctl daemon-reload`

The rest of the map is NOT this installer's: /etc/sudoers.d/warsaw-beer-bot, warsaw-beer-bot.service, litestream.*,
wbb-autodeploy.* and merge-deploy's /usr/local/bin copies (install-autodeploy.sh, deploy/README), the host-patch and
reboot-request units and scripts (their install-*.sh). Those run production today; п.1 says nothing switches here,
and a second installer of the same file would make "who installed this" a race.

It also creates the system user wbb-trial (п.4; an existing one it only checks, never fixes) and the root-private
directories TRIAL_ROOT, the receipts and the token's directory. The token file itself it only checks.

Never: enable/disable/start/stop a unit, write under /opt, touch .env. Every write is a dotted temporary file in the
destination's directory (sudo skips dotted names) -> fchown 0:0 -> fchmod -> fsync -> rename, then read back.
Order is dependencies first (M2 #527): library -> wrappers -> sudoers -> units -> daemon-reload. Files in LIB_DIR
that the checkout no longer installs are removed (helpers_adapter.lib_orphans, the tick's own notion).

--check writes nothing: it prints every difference and exits 1 if there is one.
Exit codes: 0 done / no difference; 1 a difference (--check) or a refused precondition; 64 usage; 70 internal.
All absolute paths are taken under `root` (tests pass a temporary directory; the host is '/').
"""
import argparse
import errno
import grp
import os
import posixpath
import pwd
import re
import stat
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounded  # noqa: E402
import installed as ins  # noqa: E402
import sandbox as sb  # noqa: E402
from helpers import HelperError  # noqa: E402
from helpers_adapter import lib_orphans, unsafe_copy  # noqa: E402
from safe_tar import Refused  # noqa: E402
from wbb_release import PRODUCTION_ROOTS, TOKEN_FILE, TOKEN_KEY, TRIAL_ROOT, read_token  # noqa: E402

EX_OK, EX_DIFF, EX_USAGE, EX_SOFTWARE = 0, 1, 64, 70
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
CMD_TIMEOUT_S = 120

# The files of the map this installer owns (besides everything installed_path puts in LIB_DIR), by repo path:
# the installed path is installed_path's, never spelled here.
WRAPPERS = ('deploy/wbb-release.sh', 'deploy/wbb-tick.sh', 'deploy/wbb-tick-failed.sh')
SUDOERS = ('deploy/sudoers.d/wbb-release',)
UNITS = ('deploy/wbb-tick.service', 'deploy/wbb-tick.timer', 'deploy/wbb-tick-failed.service')
TIMER_UNIT = posixpath.basename(UNITS[1])
# Install order (dependencies first) and the mode of each kind.
KINDS = (('lib', 0o644), ('wrapper', 0o755), ('sudoers', 0o440), ('unit', 0o644))
MODE = dict(KINDS)
DIR_MODE = 0o755
# п.4: (directory, mode), parents first; all root:root. The names come from the helper's own constants.
PRIVATE_DIRS = (
    (TRIAL_ROOT, 0o755),
    (posixpath.dirname(PRODUCTION_ROOTS.receipts), 0o700),
    (PRODUCTION_ROOTS.receipts, 0o700),
    (posixpath.dirname(TOKEN_FILE), 0o700),
)
FORBIDDEN = '/opt'  # п.1: the live tree; nothing of this installer goes there

GIT, USERADD, VISUDO, SYSTEMCTL = '/usr/bin/git', '/usr/sbin/useradd', '/usr/sbin/visudo', '/usr/bin/systemctl'
# e2e review S3: git runs as root in the operator's checkout and must write nothing there (a root-owned
# .git/index or index.lock breaks the operator's next git command). --no-optional-locks: `git status` does not
# refresh and rewrite the index; core.fsmonitor=false: no fsmonitor hook or daemon (with its cookie files and
# .git/fsmonitor--daemon state) started as root; core.hooksPath=/dev/null: none of the commands used runs a hook
# today, but a hook is code from the checkout's config — whatever git command is added here, it never runs as root.
GIT_ARGV = (GIT, '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null')
USERADD_ARGV = (USERADD, '--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin',
                '--user-group', sb.TRIAL_USER)
NOLOGIN = ('/usr/sbin/nologin', '/sbin/nologin')
LOGIN_DEFS = '/etc/login.defs'
DEFAULT_SYS_UID_MAX = 999
TMP_SUFFIX = '.installing'


class Refusal(Exception):
    """A precondition the human must fix; nothing after it was done."""


class Users:
    """The account database: pwd/grp on the host, a fake in tests."""
    getpwnam = staticmethod(pwd.getpwnam)
    getgrall = staticmethod(grp.getgrall)


def kind_of(repo_path):
    """The installer's kind of repo_path, or None when the file is not this installer's (SCOPE)."""
    dest = ins.installed_path(repo_path)
    if dest is None:
        return None
    if dest.startswith(ins.LIB_DIR + '/'):
        return 'lib'
    for kind, paths in (('wrapper', WRAPPERS), ('sudoers', SUDOERS), ('unit', UNITS)):
        if repo_path in paths:
            return kind
    return None


def plan(repo_files):
    """[(kind, repo_path, installed_path)] in install order for the repo's tracked files."""
    entries = sorted((kind_of(f), f) for f in repo_files if kind_of(f) is not None)
    out = [(k, f, ins.installed_path(f)) for kind, _ in KINDS for k, f in entries if k == kind]
    missing = [f for f in WRAPPERS + SUDOERS + UNITS if f not in repo_files]
    if missing:
        raise Refusal(f'the checkout lacks {", ".join(missing)} — not the warsaw-beer-bot repo at a stage-В commit')
    bad = [d for _, _, d in out if d == FORBIDDEN or d.startswith(FORBIDDEN + '/')]
    if bad:
        raise HelperError(f'refusing to install under {FORBIDDEN}: {bad}')
    return out


class Installer:
    def __init__(self, repo=REPO, root='/', run=bounded.run, chown=os.chown, users=Users, owner=(0, 0), out=None):
        self.repo, self.root, self.run, self.chown, self.users, self.owner = repo, root, run, chown, users, owner
        self.out = out if out is not None else sys.stdout
        self.changed = 0

    # --- helpers ----------------------------------------------------------------------------------------------
    def p(self, path):
        """path (absolute on the host) under self.root."""
        return os.path.join(self.root, path.lstrip('/'))

    def say(self, line):
        print(line, file=self.out)

    def raw(self, argv):
        r = self.run(list(argv), timeout=CMD_TIMEOUT_S)
        if getattr(r, 'truncated', False):
            # bounded.run keeps a head and a tail of a flood: never install or compare a cut copy.
            raise HelperError(f'{" ".join(argv[-3:])}: output too large')
        return r.returncode, r.stdout, r.stderr.decode('utf-8', 'replace').strip()

    def cmd(self, argv):
        code, out, err = self.raw(argv)
        return code, out.decode('utf-8', 'replace'), err

    def git_bytes(self, *args):
        code, out, err = self.raw([*GIT_ARGV, '-C', self.repo, *args])
        if code != 0:
            raise Refusal(f'git {args[0]}: exit {code}: {err}')
        return out

    def git(self, *args):
        return self.git_bytes(*args).decode('utf-8', 'replace')

    def tracked(self, head):
        """{repo path: (mode, type, object id)} of every entry of the commit head (git ls-tree -r)."""
        out = {}
        for entry in self.git_bytes('ls-tree', '-r', '-z', '--full-tree', head).split(b'\0'):
            if not entry:
                continue
            meta, _, path = entry.partition(b'\t')
            mode, kind, oid = meta.decode('ascii').split(' ')
            out[path.decode('utf-8', 'surrogateescape')] = (mode, kind, oid)
        return out

    # --- preconditions ----------------------------------------------------------------------------------------
    def checkout(self):
        """(HEAD, [(kind, repo path, installed path, bytes)]) of a clean checkout; Refusal otherwise.

        e2e review N1: the bytes come from HEAD's git objects, never from the worktree — no window between the
        clean check and the read, no symlinked directory of the worktree followed. The clean check stays a
        requirement: what the human sees in the checkout is what gets installed.
        """
        dirty = self.git('status', '--porcelain')
        if dirty.strip():
            raise Refusal(f'the checkout {self.repo} is not clean (git status --porcelain):\n{dirty.rstrip()}')
        head = self.git('rev-parse', '--verify', 'HEAD^{commit}').strip()
        tracked = self.tracked(head)
        files = plan(list(tracked))
        links = [f'{f} ({tracked[f][0]})' for _, f, _ in files
                 if tracked[f][:2] not in (('100644', 'blob'), ('100755', 'blob'))]
        if links:
            raise Refusal(f'HEAD {head} tracks what is not a regular file where this installer installs: '
                          f'{", ".join(links)} (a symlink is 120000, a submodule 160000) — not installing')
        return head, [(k, f, d, self.git_bytes('cat-file', 'blob', tracked[f][2])) for k, f, d in files]

    def sys_uid_max(self):
        try:
            with open(self.p(LOGIN_DEFS), encoding='utf-8', errors='replace') as f:
                text = f.read()
        except FileNotFoundError:
            return DEFAULT_SYS_UID_MAX
        values = re.findall(r'^\s*SYS_UID_MAX\s+(\d+)\s*$', text, re.M)
        return int(values[-1]) if values else DEFAULT_SYS_UID_MAX

    def trial_user(self):
        """None when wbb-trial is absent, [] when fit, else what is wrong with it (п.4)."""
        try:
            pw = self.users.getpwnam(sb.TRIAL_USER)
        except KeyError:
            return None
        groups = self.users.getgrall()
        wrong = []
        if pw.pw_shell not in NOLOGIN:
            wrong.append(f'shell {pw.pw_shell} (want {NOLOGIN[0]})')
        top = self.sys_uid_max()
        if pw.pw_uid == 0 or pw.pw_uid > top:
            wrong.append(f'uid {pw.pw_uid} (want a system uid, 1..{top} by {LOGIN_DEFS})')
        extra = sorted(g.gr_name for g in groups if sb.TRIAL_USER in g.gr_mem)
        if extra:
            wrong.append(f'supplementary groups {", ".join(extra)} (want none)')
        primary = [g.gr_name for g in groups if g.gr_gid == pw.pw_gid]
        if primary != [sb.TRIAL_USER]:
            wrong.append(f'primary group {primary or pw.pw_gid} (want its own group {sb.TRIAL_USER}, sandbox Group=)')
        return wrong

    # --- what is there ----------------------------------------------------------------------------------------
    def file_problem(self, dest, mode, data):
        """None when the installed copy at dest is exactly what this installer writes, else why not."""
        try:
            fd = os.open(self.p(dest), os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return 'missing'
        except OSError as e:
            if e.errno == errno.ELOOP:
                return 'a symlink'
            raise
        with os.fdopen(fd, 'rb') as f:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode):
                return 'not a regular file'
            got = f.read(len(data) + 1)
        # The tick's condition first (helpers_adapter.unsafe_copy), then the exact owner and mode promised here.
        if unsafe_copy(st.st_uid, st.st_mode, self.owner[0]) or (st.st_uid, st.st_gid) != self.owner \
                or stat.S_IMODE(st.st_mode) != mode:
            return f'owner {st.st_uid}:{st.st_gid} mode {stat.S_IMODE(st.st_mode):04o} ' \
                   f'(want {self.owner[0]}:{self.owner[1]} {mode:04o})'
        return None if got == data else 'content differs from the checkout'

    def dir_problem(self, path, mode):
        try:
            st = os.lstat(self.p(path))
        except FileNotFoundError:
            return 'missing'
        if not stat.S_ISDIR(st.st_mode):
            return 'not a directory (or a symlink)'
        if (st.st_uid, st.st_gid) != self.owner or stat.S_IMODE(st.st_mode) != mode:
            return f'owner {st.st_uid}:{st.st_gid} mode {stat.S_IMODE(st.st_mode):04o} ' \
                   f'(want {self.owner[0]}:{self.owner[1]} {mode:04o})'
        return None

    def lib_dirs(self, files):
        """LIB_DIR and every directory of it that holds an installed file."""
        out = {ins.LIB_DIR}
        for kind, _, dest, _ in files:
            d = posixpath.dirname(dest)
            while kind == 'lib' and d != ins.LIB_DIR:
                out.add(d)
                d = posixpath.dirname(d)
        return sorted(out)

    def orphans(self, files):
        wanted = {self.p(dest) for kind, _, dest, _ in files if kind == 'lib'}
        return lib_orphans(self.p(ins.LIB_DIR), wanted)

    def token_status(self):
        """(ok?, line). Absent is fine for this stage (п.4): only the transition needs it."""
        path = self.p(TOKEN_FILE)
        try:
            read_token(path)  # the helper's own reader: owner = this (root) user, 0600-ish, exactly one key
        except FileNotFoundError:
            return True, f'token: {TOKEN_FILE} absent (publish refuses until a human puts it there; transition step)'
        except (Refused, OSError, UnicodeDecodeError) as e:
            return False, f'token: {TOKEN_FILE} unusable: {e}'
        st = os.lstat(path)
        if stat.S_IMODE(st.st_mode) != 0o600 or st.st_uid != self.owner[0]:
            return False, f'token: {TOKEN_FILE} mode {stat.S_IMODE(st.st_mode):04o} uid {st.st_uid} (want 0600 root)'
        return True, f'token: {TOKEN_FILE} present (root, 0600, one {TOKEN_KEY}=)'

    def differences(self, files):
        diffs = []
        for d in self.lib_dirs(files):
            why = self.dir_problem(d, DIR_MODE)
            if why:
                diffs.append(f'{d}: {why}')
        for kind, f, dest, data in files:
            why = self.file_problem(dest, MODE[kind], data)
            if why:
                diffs.append(f'{dest}: {why} ({f})')
        diffs += [f'{self.unp(full)}: ' + ('a symlink inside the installed library' if linked
                                           else 'installed, but nothing in the checkout installs it')
                  for full, linked in self.orphans(files)]
        for d, mode in PRIVATE_DIRS:
            why = self.dir_problem(d, mode)
            if why:
                diffs.append(f'{d}: {why}')
        wrong = self.trial_user()
        if wrong is None:
            diffs.append(f'user {sb.TRIAL_USER}: absent')
        elif wrong:
            diffs.append(f'user {sb.TRIAL_USER}: ' + '; '.join(wrong))
        return diffs

    def unp(self, full):
        return '/' + os.path.relpath(full, self.root)

    def timer_state(self):
        try:
            code, out, err = self.cmd([SYSTEMCTL, 'is-enabled', TIMER_UNIT])
        except OSError as e:  # information only: a missing systemctl is not the installer's failure
            code, out, err = None, '', f'{type(e).__name__}: {e.strerror}'
        return f'{TIMER_UNIT}: {(out.strip() or err or f"exit {code}")} (information only: this installer never ' \
               f'enables it)'

    # --- writes -----------------------------------------------------------------------------------------------
    def mkdir(self, path, mode):
        """path (and missing parents, 0755) as root:root `mode`; an existing directory is set to it."""
        full = self.p(path)
        parent = posixpath.dirname(path)
        if parent != path and not os.path.lexists(self.p(parent)):
            self.mkdir(parent, DIR_MODE)
        try:
            os.mkdir(full, 0o700)
            self.say(f'created {path}/')
            self.changed += 1
        except FileExistsError:
            st = os.lstat(full)
            if not stat.S_ISDIR(st.st_mode):
                raise Refusal(f'{path}: exists and is not a directory (or is a symlink); not touching it') from None
            if (st.st_uid, st.st_gid) == self.owner and stat.S_IMODE(st.st_mode) == mode:
                return
            self.say(f'fixed {path}/ to {self.owner[0]}:{self.owner[1]} {mode:04o}')
            self.changed += 1
        self.chown(full, 0, 0)
        os.chmod(full, mode)

    def write(self, dest, data, mode, check=None):
        """Atomically put data at dest as root:root `mode`; unchanged copies are left alone. check(tmp) runs on
        the finished temporary file before the rename and may raise Refusal (the old copy then stays)."""
        if self.file_problem(dest, mode, data) is None:
            return False
        full = self.p(dest)
        head, name = os.path.split(full)
        tmp = os.path.join(head, f'.{name}{TMP_SUFFIX}')  # dotted: sudo and systemd ignore it; an orphan if left
        try:
            os.unlink(tmp)  # a previous run cut short
        except FileNotFoundError:
            pass
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            try:
                view = memoryview(data)
                while view:
                    view = view[os.write(fd, view):]
                self.chown(fd, 0, 0)
                os.fchmod(fd, mode)
                os.fsync(fd)
            finally:
                os.close(fd)
            if check is not None:
                check(tmp)
            os.rename(tmp, full)
        except BaseException:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise
        dfd = os.open(head, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
        why = self.file_problem(dest, mode, data)  # read back what the rename put there
        if why:
            raise HelperError(f'{dest}: after the rename: {why}')
        self.say(f'installed {dest} ({mode:04o})')
        self.changed += 1
        return True

    def visudo(self, tmp):
        code, out, err = self.cmd([VISUDO, '-cf', tmp])
        if code != 0:
            raise Refusal(f'visudo -cf rejected the new sudoers file (exit {code}): {(out + err).strip()}; '
                          f'the installed one is unchanged and no unit was installed')

    def ensure_trial_user(self):
        wrong = self.trial_user()
        if wrong is None:
            code, out, err = self.cmd(USERADD_ARGV)
            if code != 0:
                raise Refusal(f'useradd {sb.TRIAL_USER}: exit {code}: {(out + err).strip()}')
            self.say(f'created system user {sb.TRIAL_USER}')
            self.changed += 1
            wrong = self.trial_user()
            if wrong is None:
                raise HelperError(f'useradd succeeded but {sb.TRIAL_USER} is not in the account database')
        if wrong:
            raise Refusal(f'user {sb.TRIAL_USER} exists but is not fit for the sandbox: {"; ".join(wrong)}. '
                          f'Not changing an existing user; fix or remove it by hand and run again')

    # --- the two modes ----------------------------------------------------------------------------------------
    def check(self):
        head, files = self.checkout()
        self.say(f'checkout {self.repo} HEAD {head}')
        diffs = self.differences(files)
        ok, line = self.token_status()
        if not ok:
            diffs.append(line)
        for d in diffs:
            self.say(f'DIFF {d}')
        if ok:
            self.say(line)
        self.say(self.timer_state())
        self.say(f'{len(diffs)} difference(s)')
        return EX_DIFF if diffs else EX_OK

    def directories_in_the_way(self, files):
        """e2e review S4: a directory where a file goes cannot be renamed over; refuse before the first write
        rather than fail half-way (a library installed, the sudoers file not)."""
        return [dest for _, _, dest, _ in files
                if os.path.isdir(self.p(dest)) and not os.path.islink(self.p(dest))]

    def install(self):
        head, files = self.checkout()
        self.say(f'installing from {self.repo} HEAD {head}')
        in_the_way = self.directories_in_the_way(files)
        if in_the_way:
            raise Refusal(f'a directory where a file is installed: {", ".join(in_the_way)}; not touching it')
        # Refused before any write when an existing wbb-trial is unfit (п.4).
        self.ensure_trial_user()
        for d, mode in PRIVATE_DIRS:
            self.mkdir(d, mode)
        for d in self.lib_dirs(files):
            self.mkdir(d, DIR_MODE)
        for kind, _ in KINDS:
            for k, _, dest, data in files:
                if k != kind:
                    continue
                parent = posixpath.dirname(dest)
                if not os.path.isdir(self.p(parent)):
                    self.mkdir(parent, DIR_MODE)
                self.write(dest, data, MODE[kind], check=self.visudo if kind == 'sudoers' else None)
            if kind == 'lib':
                # New modules are in place before the old ones go (dependencies first).
                for full, linked in self.orphans(files):
                    os.unlink(full)
                    self.say(f'removed {self.unp(full)}' + (' (a symlink)' if linked else ''))
                    self.changed += 1
        code, out, err = self.cmd([SYSTEMCTL, 'daemon-reload'])
        if code != 0:
            raise HelperError(f'systemctl daemon-reload: exit {code}: {(out + err).strip()}')
        diffs = self.differences(files)
        for d in diffs:
            self.say(f'DIFF {d}')
        self.say(self.token_status()[1])
        self.say(self.timer_state())
        self.say(f'installed: {self.changed} change(s)' if not diffs else f'{len(diffs)} difference(s) remain')
        return EX_DIFF if diffs else EX_OK


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f'{self.prog}: {message}', file=sys.stderr)
        sys.exit(EX_USAGE)


def main(argv, **kwargs):
    ap = _Parser(prog='install-release.sh', description='Install the release control plane (switches nothing).')
    ap.add_argument('--check', action='store_true', help='write nothing; print differences, exit 1 on any')
    args = ap.parse_args(argv)
    inst = Installer(**kwargs)
    try:
        return inst.check() if args.check else inst.install()
    except Refusal as e:
        print(f'REFUSED: {e}', file=sys.stderr)
        return EX_DIFF
    except Exception:  # noqa: BLE001 — anything else is the installer's own failure, never a "difference"
        traceback.print_exc()
        return EX_SOFTWARE


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
