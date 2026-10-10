"""Trusted GitHub metadata for one main SHA: which CI run, which artifact, which digest.

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §4 TRUST-001.
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2a.md, Task 1.

An artifact's name or checksum proves nothing about where it came from. What does:
a completed, successful push run of the fixed workflow path on main of this very
repository, for exactly this head SHA, whose `package` and `ci` jobs succeeded in
the same attempt, and an artifact listed under that run with the name that attempt
would have given it. Anything missing, mistyped or ambiguous is a refusal; there is
never a fallback to "the latest green one".

Stdlib only. The token goes to api.github.com and nowhere else; the signed storage
URL the artifact download redirects to is neither followed with credentials nor
printed.
"""
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

API = 'https://api.github.com'
REPO = 'ysilvestrov/warsaw-beer-bot'
WORKFLOW_PATH = '.github/workflows/ci.yml'
REQUIRED_JOBS = ('package', 'ci')
MAX_JSON_BYTES = 4 * 1024 * 1024
TIMEOUT_S = 30
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'sha256:([0-9a-f]{64})')


class Untrusted(Exception):
    """Not trusted: anything missing, mistyped, ambiguous or unreachable. On its own it says nothing about the
    CI run itself — a transport error, a 5xx, no token or a partial listing raise it too."""


class NoRunYet(Untrusted):
    """No completed push run of the workflow for this SHA is listed (yet): CI has not concluded."""


class RunFailed(Untrusted):
    """A verdict on CI (stage A review S2): the run for this SHA, otherwise the trusted one, concluded
    unsuccessfully, or a required job of its attempt completed unsuccessfully (failure, skipped, cancelled …).
    The only Untrusted a caller may read as "CI failed"; every other one is "cannot tell"."""


@dataclass(frozen=True)
class Trusted:
    repo: str
    sha: str
    workflow: str
    run_id: int
    run_attempt: int
    artifact_id: int
    artifact_name: str
    zip_sha256: str


def artifact_name(sha, run_id, run_attempt):
    return f'wbb-release-{sha}-{run_id}-{run_attempt}'


def _get(obj, path, typ):
    """obj[a][b]... of exactly type typ (bool is not an int), or None."""
    cur = obj
    for key in path.split('.'):
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    if typ is int and isinstance(cur, bool):
        return None
    return cur if isinstance(cur, typ) else None


def _items(listing, key):
    """The list under `key`, refusing a listing that does not show everything it counts."""
    items = _get(listing, key, list)
    total = _get(listing, 'total_count', int)
    if items is None or total is None or not all(isinstance(i, dict) for i in items):
        raise Untrusted(f'malformed {key} listing')
    if total != len(items):
        raise Untrusted(f'{key} listing shows {len(items)} of {total}; refusing to decide on a partial list')
    return items


def run_problems(run, repo, sha):
    """Why `run` is not a trusted main push run of this workflow for sha ([] if it is)."""
    want = {
        'path': (str, WORKFLOW_PATH),
        'event': (str, 'push'),
        'head_branch': (str, 'main'),
        'head_sha': (str, sha),
        'status': (str, 'completed'),
        'conclusion': (str, 'success'),
        'repository.full_name': (str, repo),
        'head_repository.full_name': (str, repo),
    }
    problems = [f'{k}={_get(run, k, object)!r}' for k, (typ, v) in want.items() if _get(run, k, typ) != v]
    for k in ('id', 'run_attempt'):
        value = _get(run, k, int)
        if value is None or value < 1:
            problems.append(f'{k}={_get(run, k, object)!r}')
    return problems


def select_run(runs_json, repo, sha):
    runs = _items(runs_json, 'workflow_runs')
    trusted = [r for r in runs if not run_problems(r, repo, sha)]
    if not runs:
        raise NoRunYet(f'no trusted CI run for {sha}')
    if not trusted:
        why = '; '.join(f'run {_get(r, "id", object)}: {", ".join(run_problems(r, repo, sha))}' for r in runs[:5])
        # A run that would be the trusted one but for its conclusion is CI's verdict (stage A review S2).
        failed = any(run_problems(r, repo, sha) == [f'conclusion={_get(r, "conclusion", object)!r}']
                     and isinstance(_get(r, 'conclusion', object), str) for r in runs)
        raise (RunFailed if failed else Untrusted)(f'no trusted CI run for {sha} ({why})')
    if len(trusted) > 1:
        raise Untrusted(f'{len(trusted)} trusted CI runs for {sha}: {sorted(r["id"] for r in trusted)}; refusing to choose')
    return trusted[0]


def check_jobs(jobs_json, run_id, attempt):
    """package and ci succeeded in exactly this run attempt."""
    jobs = _items(jobs_json, 'jobs')
    for name in REQUIRED_JOBS:
        same = [j for j in jobs if _get(j, 'name', str) == name]
        if len(same) != 1:
            raise Untrusted(f'run {run_id} attempt {attempt}: expected one {name!r} job, found {len(same)}')
        job = same[0]
        if (_get(job, 'run_id', int), _get(job, 'run_attempt', int)) != (run_id, attempt):
            raise Untrusted(f'run {run_id} attempt {attempt}: {name!r} job belongs to '
                            f'run {_get(job, "run_id", object)} attempt {_get(job, "run_attempt", object)}')
        if _get(job, 'status', str) != 'completed' or _get(job, 'conclusion', str) != 'success':
            # Completed with another conclusion is CI's verdict; anything else is not (stage A review S2).
            done = _get(job, 'status', str) == 'completed' and _get(job, 'conclusion', str) is not None
            raise (RunFailed if done else Untrusted)(f'run {run_id} attempt {attempt}: {name!r} is '
                            f'{_get(job, "status", object)}/{_get(job, "conclusion", object)}')


def select_artifact(artifacts_json, sha, run_id, attempt):
    """(artifact id, name, zip sha256) of the one artifact this run attempt published."""
    name = artifact_name(sha, run_id, attempt)
    arts = [a for a in _items(artifacts_json, 'artifacts') if _get(a, 'name', str) == name]
    if len(arts) != 1:
        raise Untrusted(f'run {run_id}: expected one artifact {name}, found {len(arts)}')
    art = arts[0]
    art_id = _get(art, 'id', int)
    if art_id is None or art_id < 1:
        raise Untrusted(f'{name}: no artifact id')
    if _get(art, 'expired', bool) is not False:
        raise Untrusted(f'{name}: expired or expiry unknown — re-run the main CI workflow for {sha} or push a new commit')
    if (_get(art, 'workflow_run.id', int), _get(art, 'workflow_run.head_sha', str)) != (run_id, sha):
        raise Untrusted(f'{name}: listed under a different run or SHA')
    m = DIGEST.fullmatch(_get(art, 'digest', str) or '')
    if not m:
        raise Untrusted(f'{name}: no valid sha256 digest ({_get(art, "digest", object)!r}); operator recovery required')
    return art_id, name, m.group(1)


def fetch_trusted(api, repo, sha):
    """Trusted identity of sha's artifact, from metadata fetched now through `api(path) -> dict`."""
    if not SHA.fullmatch(sha):
        raise Untrusted(f'not a full lowercase SHA: {sha!r}')
    query = urllib.parse.urlencode({'head_sha': sha, 'event': 'push', 'branch': 'main',
                                    'status': 'completed', 'per_page': 100})
    run = select_run(api(f'/repos/{repo}/actions/workflows/ci.yml/runs?{query}'), repo, sha)
    run_id, attempt = run['id'], run['run_attempt']
    check_jobs(api(f'/repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100'), run_id, attempt)
    art_id, name, digest = select_artifact(
        api(f'/repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100'), sha, run_id, attempt)
    return Trusted(repo, sha, WORKFLOW_PATH, run_id, attempt, art_id, name, digest)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHubApi:
    """`api(path) -> dict` over HTTPS, plus the two-step artifact download.

    `urlopen(request, timeout)` is injectable for tests; the default never follows
    redirects on its own, so credentials cannot ride one to another host.
    """

    def __init__(self, token, urlopen=None):
        if not token:
            raise Untrusted('no GitHub token')
        self._token = token
        self._urlopen = urlopen or urllib.request.build_opener(_NoRedirect).open

    def _headers(self):
        return {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                'Authorization': f'Bearer {self._token}', 'User-Agent': 'wbb-release'}

    def __call__(self, path):
        req = urllib.request.Request(API + path, headers=self._headers())
        try:
            with self._urlopen(req, timeout=TIMEOUT_S) as resp:
                body = resp.read(MAX_JSON_BYTES + 1)
        except urllib.error.HTTPError as e:
            raise Untrusted(f'GitHub API {e.code} for {path.split("?")[0]}') from None
        except OSError as e:
            raise Untrusted(f'GitHub API unreachable for {path.split("?")[0]}: {type(e).__name__}') from None
        if len(body) > MAX_JSON_BYTES:
            raise Untrusted(f'GitHub API response over {MAX_JSON_BYTES} bytes for {path.split("?")[0]}')
        try:
            data = json.loads(body)
        except ValueError:
            raise Untrusted(f'GitHub API returned non-JSON for {path.split("?")[0]}') from None
        if not isinstance(data, dict):
            raise Untrusted(f'GitHub API returned a non-object for {path.split("?")[0]}')
        return data

    def download(self, repo, artifact_id, out, cap):
        """Stream the artifact ZIP into binary file `out`; return the byte count (<= cap)."""
        req = urllib.request.Request(f'{API}/repos/{repo}/actions/artifacts/{artifact_id}/zip',
                                     headers=self._headers())
        location = None
        try:
            with self._urlopen(req, timeout=TIMEOUT_S):
                pass
            raise Untrusted('artifact download did not redirect to storage')
        except urllib.error.HTTPError as e:
            if e.code not in (301, 302, 303, 307, 308):
                raise Untrusted(f'artifact download: GitHub API {e.code}') from None
            location = e.headers.get('Location', '')
        if urllib.parse.urlsplit(location).scheme != 'https':
            raise Untrusted('artifact download: redirect is not https')
        # No Authorization header from here on, and the signed URL is never printed.
        storage = urllib.request.Request(location, headers={'User-Agent': 'wbb-release'})
        total = 0
        try:
            with self._urlopen(storage, timeout=TIMEOUT_S) as resp:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > cap:
                        raise Untrusted(f'artifact download exceeds {cap} bytes')
                    out.write(chunk)
        except urllib.error.HTTPError as e:
            raise Untrusted(f'artifact storage returned {e.code}') from None
        except OSError as e:
            raise Untrusted(f'artifact storage unreachable: {type(e).__name__}') from None
        return total
