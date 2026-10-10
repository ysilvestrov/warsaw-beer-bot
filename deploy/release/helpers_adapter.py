"""The tick's real Helpers: the private clone, GitHub through the operator's `gh`, the root helper, the DB snapshots.

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-b-core.md, "Рішення" п.2,
Task 2. The protocol is helpers.Helpers; the commands mirror merge-deploy's (deploy/autodeploy.sh):

  fetch_main          git -C <clone> fetch -q --prune origin; git rev-parse --verify origin/main^{commit}
  is_ancestor         git cat-file -e <a>, <b> (1: not in the clone -> False); git merge-base --is-ancestor
  changed_paths       git -c core.quotePath=false diff --no-renames --name-only -z <a> <b>
  commits             git rev-list <a>..<b>
  pr_labels           gh api repos/<repo>/commits/<sha>/pulls?per_page=100
  trusted / download  github_trust over GitHubApi(`gh auth token`); the ZIP into <data>/artifacts (0700)
  publish verify probe trial   sudo -n /usr/local/libexec/wbb-release <verb> --sha <sha> [...]
  audit               /usr/local/libexec/wbb-release audit --sha <sha>     (the operator, never root)
  snapshot_pre        wbb-db-snapshot snapshot <db> <dir>/<UTC>-<sha7>-pre.db as the bot user, then its .sha256
  discard_pre         wbb-db-snapshot discard <pre> as the bot user
  manifest            releases/<sha>/tree-manifest.json, read by the operator (root-owned 0644)
  installed_stale     every installed copy (installed.installed_path) against `git show origin/main:<path>`

wbb_release exit codes ("Рішення" п.2): 0, 1 and 2 come back as a Run — the caller decides — but exit 1 only with
the verdict line of this verb for this SHA: sudo exits 1 for its own failures, and that is no verdict. Anything
else (64, 70, 75, a signal, sudo's 1 without our line) is HelperError. The GitHub token never appears in argv,
in output or in an exception: it goes from `gh auth token` straight into GitHubApi.
"""
import json
import errno
import os
import re
import stat
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounded  # noqa: E402
import gates  # noqa: E402
import github_trust as gt  # noqa: E402
import installed as ins  # noqa: E402
from deploy_state import Pre  # noqa: E402
from helpers import HelperError, Run  # noqa: E402
from host_adapter import as_bot, call, reason  # noqa: E402
from host_audit import MAX_MANIFEST_BYTES  # noqa: E402
from trial import SNAPSHOT_NAME, SNAPSHOT_SUM  # noqa: E402
from tree_manifest import MANIFEST_NAME  # noqa: E402
from wbb_release import PRODUCTION_ROOTS, SNAPSHOT_ROOT  # noqa: E402
from zip_admission import ZipCaps  # noqa: E402

REF = 'origin/main'
FETCH_TIMEOUT_S = 300
GIT_TIMEOUT_S = 60
GH_TIMEOUT_S = 60
SNAPSHOT_TIMEOUT_S = 600
SMALL_TIMEOUT_S = 30
RELEASE_TIMEOUT_S = {'publish': 900, 'verify': 300, 'audit': 300, 'probe': 300, 'trial': 600}
PR_PAGE = 100
VERDICT = {
    'publish': re.compile(r'(ACCEPTED|ALREADY-ACCEPTED) ([0-9a-f]{40}): .*'),
    'verify': re.compile(r'(VERIFIED) ([0-9a-f]{40}): tree ([0-9a-f]{64})(?: .*)?'),
    'audit': re.compile(r'AUDIT (CLEAN|ADVISORY|UNRUNNABLE) ([0-9a-f]{40}) tree (\S+)'),
    'probe': re.compile(r'PROBE (OK|FAILED|TRANSIENT) ([0-9a-f]{40}): .*'),
    'trial': re.compile(r'TRIAL (OK|FAILED|TRANSIENT) ([0-9a-f]{40}): .*'),
}
HEX64 = re.compile(r'[0-9a-f]{64}')


def _sha(sha):
    if not isinstance(sha, str) or not gt.SHA.fullmatch(sha):
        raise HelperError(f'not a full lowercase SHA: {sha!r}')
    return sha


def _out(result):
    return result.stdout.decode('utf-8', 'surrogateescape')


def _whole(result, what):
    """stdout of a successful command, all of it (bounded.run keeps a head and a tail of a flood)."""
    if result.returncode != 0:
        raise HelperError(f'{what}: exit {result.returncode}: {reason(result)}')
    if getattr(result, 'truncated', False):
        raise HelperError(f'{what}: output too large')
    return result.stdout


def parse_run(verb, sha, result):
    """helpers.Run of one wbb_release call; HelperError for what is not its answer ("Рішення" п.2)."""
    code = result.returncode
    lines = _out(result).splitlines()
    m = VERDICT[verb].fullmatch(lines[0]) if lines else None
    kind = m.group(1) if m is not None and m.group(2) == sha else None
    if code not in (0, 1, 2) or (code == 1 and kind is None):
        raise HelperError(f'wbb-release {verb}: exit {code}: {reason(result)}')
    tree = m.group(3) if kind is not None and m.lastindex >= 3 and HEX64.fullmatch(m.group(3)) else None
    text = (_out(result) + result.stderr.decode('utf-8', 'replace')).strip()
    return Run(code, kind, text, tree)


class RealHelpers:
    def __init__(self, data_dir, run=bounded.run, api_factory=gt.GitHubApi, clock=time.time, roots=PRODUCTION_ROOTS,
                 snapshot_root=SNAPSHOT_ROOT, db=ins.DB_PATH, locate=ins.installed_path, repo=gt.REPO,
                 installed_owner=0, lib_dir=ins.LIB_DIR):
        self._repo_dir = os.path.join(data_dir, 'repo')
        self._artifacts = os.path.join(data_dir, 'artifacts')
        self._installed_owner, self._lib_dir = installed_owner, lib_dir
        self._run, self._api_factory, self._clock = run, api_factory, clock
        self._roots, self._snapshots, self._db, self._locate, self._repo = roots, snapshot_root, db, locate, repo
        self._api = None

    # --- git (the private clone) --------------------------------------------------------------------------------
    def _git(self, *args, timeout=GIT_TIMEOUT_S):
        return call(self._run, ['git', '-C', self._repo_dir, *args], timeout, HelperError)

    def fetch_main(self):
        r = self._git('fetch', '-q', '--prune', 'origin', timeout=FETCH_TIMEOUT_S)
        if r.returncode != 0:
            raise HelperError(f'git fetch: exit {r.returncode}: {reason(r)}')
        got = _whole(self._git('rev-parse', '--verify', f'{REF}^{{commit}}'), 'git rev-parse').decode('ascii', 'replace')
        return _sha(got.strip())

    def is_ancestor(self, a, b):
        for sha in (_sha(a), _sha(b)):
            r = self._git('cat-file', '-e', sha)
            if r.returncode == 1:
                return False  # not in the clone: not reachable from main (helpers.Helpers.is_ancestor)
            if r.returncode != 0:
                raise HelperError(f'git cat-file: exit {r.returncode}: {reason(r)}')
        r = self._git('merge-base', '--is-ancestor', a, b)
        if r.returncode not in (0, 1):
            raise HelperError(f'git merge-base: exit {r.returncode}: {reason(r)}')
        return r.returncode == 0

    def changed_paths(self, a, b):
        out = _whole(self._git('-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', '-z',
                               _sha(a), _sha(b)), 'git diff')
        return tuple(p.decode('utf-8', 'surrogateescape') for p in out.split(b'\0') if p)

    def commits(self, a, b):
        out = _whole(self._git('rev-list', f'{_sha(a)}..{_sha(b)}'), 'git rev-list').decode('ascii', 'replace')
        return tuple(_sha(line) for line in out.split())

    # --- GitHub ---------------------------------------------------------------------------------------------------
    def pr_labels(self, sha):
        r = call(self._run, ['gh', 'api', f'repos/{self._repo}/commits/{_sha(sha)}/pulls?per_page={PR_PAGE}'],
                 GH_TIMEOUT_S, HelperError)
        try:
            prs = json.loads(_whole(r, 'gh api pulls'))
            if not isinstance(prs, list):
                raise TypeError('not a list')
            got = tuple(gates.Pr(p['number'], tuple(lb['name'] for lb in p['labels'])) for p in prs)
            if any(type(p.number) is not int or not all(isinstance(n, str) for n in p.labels) for p in got):
                raise TypeError('a number or label name of the wrong type')
        except (ValueError, TypeError, KeyError) as e:
            raise HelperError(f'gh api pulls of {sha[:7]}: unexpected JSON ({type(e).__name__})') from None
        if len(got) >= PR_PAGE:
            raise HelperError(f'gh api pulls of {sha[:7]}: {len(got)} PRs, the listing may be partial')
        return got

    def _github(self):
        if self._api is None:
            r = call(self._run, ['gh', 'auth', 'token'], SMALL_TIMEOUT_S, HelperError)
            # stderr only: stdout is the token
            why = r.stderr.decode('utf-8', 'replace').strip().splitlines()[:1]
            token = r.stdout.decode('ascii', 'replace').strip() if r.returncode == 0 else ''
            if not token or len(token.split()) != 1:
                raise HelperError(f'gh auth token: exit {r.returncode}, no token' + (f': {why[0][:200]}' if why else ''))
            self._api = self._api_factory(token)
        return self._api

    def trusted(self, sha):
        # RunFailed and NoRunYet pass through as they are (stage A review S2): ci_of reads them.
        return gt.fetch_trusted(self._github(), self._repo, sha)

    def _private_dir(self):
        os.makedirs(self._artifacts, mode=0o700, exist_ok=True)
        st = os.lstat(self._artifacts)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise HelperError(f'{self._artifacts}: must be a directory of this user, 0700')
        return self._artifacts

    def download(self, sha, trusted):
        if trusted.sha != _sha(sha):
            raise HelperError(f'the trusted identity is of {trusted.sha[:7]}, not {sha[:7]}')
        api = self._github()
        path = os.path.join(self._private_dir(), f'{sha}.zip')
        part = path + '.partial'
        try:
            fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as f:
                # #828 AI review: a left-over .partial keeps its old mode through O_CREAT; the ZIP is private.
                os.fchmod(f.fileno(), 0o600)
                api.download(trusted.repo, trusted.artifact_id, f, ZipCaps().zip_bytes)
            os.replace(part, path)
        except BaseException:
            try:
                os.unlink(part)
            except OSError:
                pass
            raise
        return path

    # --- wbb_release ----------------------------------------------------------------------------------------------
    def _release(self, verb, sha, *extra, sudo=True):
        argv = (['sudo', '-n'] if sudo else []) + [ins.ROOT_HELPER, verb, '--sha', _sha(sha), *extra]
        return parse_run(verb, sha, call(self._run, argv, RELEASE_TIMEOUT_S[verb], HelperError))

    def publish(self, sha, zip_path):
        if not os.path.isabs(zip_path):
            raise HelperError(f'not an absolute path: {zip_path!r}')
        return self._release('publish', sha, '--archive', zip_path)

    def verify(self, sha):
        return self._release('verify', sha)

    def audit(self, sha):
        return self._release('audit', sha, sudo=False)

    def probe(self, sha):
        return self._release('probe', sha)

    def trial(self, sha, pre_name):
        if not isinstance(pre_name, str) or not SNAPSHOT_NAME.fullmatch(pre_name):
            raise HelperError(f'not a pre snapshot name: {pre_name!r}')
        return self._release('trial', sha, '--snapshot', pre_name)

    def manifest(self, sha):
        path = os.path.join(self._roots.releases, _sha(sha), MANIFEST_NAME)
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as f:
                if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                    raise HelperError(f'{path}: not a regular file')
                data = f.read(MAX_MANIFEST_BYTES + 1)
        except OSError as e:
            raise HelperError(f'{path}: {type(e).__name__}: {e.strerror}') from None
        if len(data) > MAX_MANIFEST_BYTES:
            raise HelperError(f'{path}: over {MAX_MANIFEST_BYTES} bytes')
        return data

    # --- the database, as the bot user --------------------------------------------------------------------------
    def _as_bot(self, argv, timeout, what):
        r = call(self._run, as_bot(argv), timeout, HelperError)
        return _whole(r, what)

    def snapshot_pre(self, sha):
        taken_at = self._clock()
        name = f'{time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(taken_at))}-{_sha(sha)[:7]}-pre.db'
        path = os.path.join(self._snapshots, name)
        self._as_bot([ins.SNAPSHOT_BIN, 'snapshot', self._db, path], SNAPSHOT_TIMEOUT_S, 'snapshot')
        try:
            raw = self._as_bot(['/usr/bin/cat', f'{path}.sha256'], SMALL_TIMEOUT_S, 'snapshot checksum')
            m = SNAPSHOT_SUM.fullmatch(raw.decode('ascii', 'replace'))
            if m is None:
                raise HelperError(f'{path}.sha256: not a sha256 hex digest')
        except HelperError:
            # A pre nobody will use must not count as a settled snapshot (Helpers.discard_pre).
            try:
                self.discard_pre(Pre(path, '0' * 64, taken_at))
            except HelperError:
                pass
            raise
        return Pre(path, m.group(1), taken_at)

    def discard_pre(self, pre):
        head, name = os.path.split(pre.path)
        if head != self._snapshots or not SNAPSHOT_NAME.fullmatch(name):
            raise HelperError(f'not a pre snapshot of {self._snapshots}: {pre.path!r}')
        self._as_bot([ins.SNAPSHOT_BIN, 'discard', pre.path], SMALL_TIMEOUT_S, 'discard')

    # --- installed copies -----------------------------------------------------------------------------------------
    def _orphans(self, paths):
        """Files in LIB_DIR that no file of origin/main installs there (#828 AI review: a module deleted from the
        repository keeps running from its old installed copy). Other destinations (/etc/...) are shared with other
        software and cannot be listed as ours; the installer removes what it stops installing (stage В)."""
        if not os.path.isdir(self._lib_dir):
            return []
        wanted = {self._locate(p) for p in paths}
        out = []
        for root, _, names in os.walk(self._lib_dir):
            for name in names:
                full = os.path.join(root, name)
                if full not in wanted and '__pycache__' not in full.split(os.sep):
                    out.append(f'{full} (installed, but nothing in {REF} installs it)')
        return sorted(out)

    def installed_stale(self, patterns):
        listing = _whole(self._git('ls-tree', '-r', '-z', '--name-only', REF), 'git ls-tree')
        paths = [p.decode('utf-8', 'surrogateescape') for p in listing.split(b'\0') if p]
        stale = []
        for path in paths:
            dest = self._locate(path)
            if dest is None or not any(gates.matches(path, p) for p in patterns):
                continue
            want = _whole(self._git('show', f'{REF}:{path}'), f'git show {path}')
            try:
                fd = os.open(dest, os.O_RDONLY | os.O_NOFOLLOW)
            except FileNotFoundError:
                stale.append(f'{path} (not installed at {dest})')
                continue
            except OSError as e:
                if e.errno == errno.ELOOP:
                    stale.append(f'{path} ({dest} is a symlink)')
                    continue
                raise HelperError(f'{dest}: {type(e).__name__}: {e.strerror}') from None
            try:
                with os.fdopen(fd, 'rb') as f:
                    st = os.fstat(f.fileno())
                    got = f.read(len(want) + 1)
            except OSError as e:
                raise HelperError(f'{dest}: {type(e).__name__}: {e.strerror}') from None
            # #828 AI review: the right bytes in a file the operator could rewrite later are not an installed
            # copy — what sudo runs must be root's and writable by nobody else.
            if st.st_uid != self._installed_owner or st.st_mode & 0o022:
                stale.append(f'{path} ({dest} is not {self._installed_owner}-owned and closed to group/other writes)')
            elif got != want:
                stale.append(path)
        stale += self._orphans(paths)
        if not stale:
            return None
        return f'STALE: {len(stale)} installed file(s) differ from {REF}:\n' + '\n'.join(f'  {s}' for s in stale)
