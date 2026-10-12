#!/usr/bin/env python3
"""Root helper `wbb-image`: the bot's OCI image on the host — pull, local, trial, audit, activate, inspect, prune.

Spec: docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §3.2, §3.3, §5, §9.
Plan: docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md, "Рішення" п.1–3, 5–9, Tasks 2–3;
      docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md, "Рішення" п.9–10, Task 0 (`local`).

Meant to be installed root-owned as /usr/local/lib/wbb-image/wbb_image.py and run as root through
/usr/local/libexec/wbb-image (deploy/image/helper/wbb-image.sh) under fixed sudo rules. The trust boundary is
argv: `*` in sudoers matches spaces too, so every value is checked here (a full lowercase SHA, a `sha256:`
digest, a snapshot NAME — never a path) and nothing the operator passes reaches podman but a checked digest.
Everything that depends on the host (paths, binaries, the bot's ids, free space) lives in `Host`, which
`main()` takes as a parameter: tests pass a fake one.

Usage: wbb_image.py pull     --sha <40 hex> --digest sha256:<64 hex>
       wbb_image.py local    --digest D
       wbb_image.py trial    --digest D --previous S --snapshot <YYYYMMDD>T<HHMMSS>Z-<sha>-pre.db
       wbb_image.py audit    --digest D
       wbb_image.py activate --digest D
       wbb_image.py current
       wbb_image.py prune    --keep sha256:<64 hex> [--keep …]
D, S: local images of our repository (`inspect_ours`). The snapshot is a NAME in the snapshot root, never a path.

Output on stdout — the only line, except: `trial` prints a line per step and its verdict is the LAST one;
`audit` prints its verdict FIRST and npm's details after it (plan b-core "Рішення" п.9) —
  `PULLED <D> <image id> content=<wbb.content> revision=<sha>`
  `LOCAL <D> <image id> content=<wbb.content> revision=<sha>` — D is already here (no network, no pull, no
  free-space check); or `NOT LOCAL <D>` (exit 3): no local image at D, the caller pulls it
  trial, one line per step: `TRIAL OK: …` (trial-migrate's own line), `START OK <revision of D>`,
  `COMPAT OK <S>`; or, ending it, `TRIAL FAILED: …`, `START FAILED: …` or `COMPAT FAILED: <S's start-check line>`
  (exit 1) — S's `START FAILED: …`, or `START TIMEOUT: …` (S did not answer on the copy D has just started
  on, under the same confinement: spec §6.3). An exit 1 is a verdict only with its FAILED line; START (D)
  TIMEOUT, START KILLED (OOM) and anything else are 75. The containers' output tails go to stderr, after
  the REFUSED/TEMPFAIL line when there is one. Each step runs in a container of its own on the same private
  copy of the snapshot, checked against its .sha256: TRIAL migrates it with D, START starts D on it, COMPAT
  starts S on what D left.
  `AUDIT CLEAN <D>`; or `AUDIT ADVISORY <D>` followed by the verdict's own lines (exit 1)
  `ACTIVATED <D>`; or `ACTIVATE FAILED: restart exited <n>: <stderr tail>` (exit 1: the Quadlet file names D and
  systemd could not start it)
  `CURRENT quadlet=<D|none> container-image=<id|none> container-digest=<D|none> unit=quadlet|foreign|absent`
  `PRUNED <n> skipped <m> kept <digest …>`
Exit (as deploy/release/wbb_release.py):
   0  done
   1  ONLY with a verdict on the candidate on stdout: TRIAL FAILED, START FAILED, COMPAT FAILED, AUDIT ADVISORY,
      ACTIVATE FAILED
   2  refused: an input or a precondition (`REFUSED: …` on stderr) — not a verdict on the candidate
   3  `local` only: `NOT LOCAL <D>` — a normal state, not an error
  64  usage
  70  internal error (a traceback on stderr); also a module of the helper that fails to import
  75  could not judge now — retry (`TEMPFAIL: …` on stderr): podman failed or timed out, a registry is down
On 2 and 75 the FIRST line of stderr is the one `REFUSED: …` / `TEMPFAIL: …` line (multi-line reasons are joined);
anything for a human (container output tails, a container left behind) comes after it.
"""
import argparse
import dataclasses
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import traceback
from typing import Callable

EX_SOFTWARE = 70

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import bounded  # noqa: E402
except Exception:
    # Python exits 1 on an uncaught exception at module level, and 1 from this helper is a bad candidate.
    if __name__ != '__main__':
        raise
    traceback.print_exc()
    sys.exit(EX_SOFTWARE)

EX_FAILED = 1
EX_REFUSED = 2
EX_NOT_LOCAL = 3
EX_USAGE = 64
EX_TEMPFAIL = 75

REPOSITORY = 'ghcr.io/ysilvestrov/warsaw-beer-bot'
CONTAINER = 'warsaw-beer-bot'
UNIT = 'warsaw-beer-bot.service'
REVISION_LABEL = 'org.opencontainers.image.revision'
CONTENT_LABEL = 'wbb.content'
# Spec §9: below this on the containers' filesystem `pull` refuses (with a message, never a silent prune).
MIN_FREE_BYTES = 5 * 1024 ** 3
PULL_TIMEOUT_S = 600
INSPECT_TIMEOUT_S = 60
SYSTEMCTL_TIMEOUT_S = 30
RMI_TIMEOUT_S = 120
REMOVE_TIMEOUT_S = 60
DAEMON_RELOAD_TIMEOUT_S = 60
# A restart waits for the new bot's readiness (Type=notify); its start takes ~21 s on the production DB (V13).
RESTART_TIMEOUT_S = 180
TRIAL_TIMEOUT_S = 180
# start-check's own limit, and the container's: start-check answers within START_CHECK_S plus its stop.
START_CHECK_S = 90
START_TIMEOUT_S = 150
AUDIT_TIMEOUT_S = 300
# The first line of a container's stdout that becomes a verdict line is cut to this.
LINE_CHARS = 1000
# The .sha256 sidecar db-snapshot.sh writes: 64 hex and a newline.
CHECKSUM_CAP = 256
PLACEHOLDERS = ('@@DIGEST@@', '@@UID@@', '@@GID@@')
# How much of a failing command's stderr a TEMPFAIL line carries.
TAIL_CHARS = 2000
GENERATOR_DIR = '/run/systemd/generator/'

SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
IMAGE_ID = re.compile(r'[0-9a-f]{64}')
CONTENT = re.compile(r'[0-9a-f]{64}')
SNAPSHOT = re.compile(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}-pre\.db')


class Refused(Exception):
    """An input or a precondition: exit 2, never a verdict on the candidate."""


class NotLocal(Refused):
    """No local image at the digest: a refusal everywhere but `local`, where it is the answer (exit 3)."""


class TempFail(Exception):
    """Could not judge now (podman failed, a timeout): exit 75, retry."""


@dataclasses.dataclass(frozen=True)
class Host:
    podman: str
    systemctl: str
    # bounded.run's signature: run(argv, *, timeout, text=...) -> CompletedProcess; may raise TimeoutExpired.
    run: Callable
    quadlet_path: str
    template_path: str
    snapshot_root: str
    scratch_root: str
    # Where podman keeps its images: the free-space check before a pull.
    containers_root: str
    free_bytes: Callable[[str], int]
    # (uid, gid) of the bot's user.
    bot_ids: Callable[[], tuple]
    # os.fchown's signature; a test running unprivileged records the call instead.
    fchown: Callable
    # Who must own scratch_root (root in production; the test's own uid in tests).
    scratch_owner: int
    # Part of the trial/audit container names: this process's pid.
    pid: Callable[[], int]


def _free_bytes(path):
    return shutil.disk_usage(path).free


def _bot_ids():
    import pwd
    pw = pwd.getpwnam('warsaw-beer-bot')
    return pw.pw_uid, pw.pw_gid


PRODUCTION = Host(
    podman='/usr/bin/podman',
    systemctl='/usr/bin/systemctl',
    run=bounded.run,
    quadlet_path='/etc/containers/systemd/warsaw-beer-bot.container',
    template_path='/usr/local/lib/wbb-image/warsaw-beer-bot.container',
    snapshot_root='/var/lib/warsaw-beer-bot/deploy-snapshots',
    scratch_root='/var/lib/wbb-image',
    containers_root='/var/lib/containers',
    free_bytes=_free_bytes,
    bot_ids=_bot_ids,
    fchown=os.fchown,
    scratch_owner=0,
    pid=os.getpid,
)


# --- argv: the trust boundary ("Рішення" п.6). An invalid value is REFUSED, not a usage error. ---

def check_sha(value):
    if not SHA.fullmatch(value):
        raise Refused(f'not a full lowercase commit SHA: {value!r}')
    return value


def check_digest(value):
    if not DIGEST.fullmatch(value):
        raise Refused(f'not a sha256:<64 lowercase hex> digest: {value!r}')
    return value


def check_snapshot_name(value):
    if not SNAPSHOT.fullmatch(value):
        raise Refused(f'not a pre snapshot name (<YYYYMMDD>T<HHMMSS>Z-<sha>-pre.db): {value!r}')
    return value


def image_ref(digest):
    """The only way this helper names an image: our repository at a checked digest."""
    return f'{REPOSITORY}@{check_digest(digest)}'


# --- running commands ---

def _tail(text):
    text = (text or '').strip()
    return text[-TAIL_CHARS:]


def _call(host, argv, timeout, what):
    """Run a command; a timeout is a TempFail. The caller judges the exit code."""
    try:
        return host.run(argv, timeout=timeout, text=True)
    except subprocess.TimeoutExpired:
        raise TempFail(f'{what} timed out after {timeout}s') from None


def _must(host, argv, timeout, what):
    r = _call(host, argv, timeout, what)
    if r.returncode != 0:
        raise TempFail(f'{what} exited {r.returncode}: {_tail(r.stderr)}')
    return r


# --- image identity (spec §3.3, "Рішення" п.7) ---

def inspect_ours(host, digest):
    """The inspect data of the local image `REPOSITORY@digest`, refused unless it is an image of our repository.

    Ours: RepoDigests names `REPOSITORY@digest` and the revision label is a full SHA ("Рішення" п.7). Its own
    `.Digest` is not required to be `digest` here (pull checks that; a locally re-tagged digest would differ).
    """
    ref = image_ref(digest)
    r = _call(host, [host.podman, 'image', 'inspect', ref, '--format', 'json'], INSPECT_TIMEOUT_S,
              'podman image inspect')
    if r.returncode != 0:
        err = r.stderr or ''
        if 'image not known' in err or 'no such image' in err.lower():
            raise NotLocal(f'{ref} is not a local image')
        raise TempFail(f'podman image inspect exited {r.returncode}: {_tail(err)}')
    try:
        data = json.loads(r.stdout)
    except ValueError:
        raise Refused(f'podman image inspect of {ref}: not JSON: {_tail(r.stdout)!r}') from None
    if not (isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict)):
        raise Refused(f'podman image inspect of {ref}: expected one image, got {_tail(r.stdout)!r}')
    image = data[0]
    repo_digests = image.get('RepoDigests') or []
    if ref not in repo_digests:
        raise Refused(f'{ref}: RepoDigests {repo_digests!r} do not name it — not an image of {REPOSITORY}')
    labels = image.get('Labels') or {}
    revision = labels.get(REVISION_LABEL)
    if not (isinstance(revision, str) and SHA.fullmatch(revision)):
        raise Refused(f'{ref}: label {REVISION_LABEL} is {revision!r}, not a full SHA')
    image_id = image.get('Id')
    if not (isinstance(image_id, str) and IMAGE_ID.fullmatch(image_id)):
        raise Refused(f'{ref}: image Id {image_id!r} is not 64 hex')
    return image


def pull(host, sha, digest):
    check_sha(sha)
    ref = image_ref(digest)
    free = host.free_bytes(host.containers_root)
    if free < MIN_FREE_BYTES:
        raise Refused(f'{free} bytes free on {host.containers_root}, a pull needs {MIN_FREE_BYTES} '
                      '(prune old images; nothing was removed)')
    _must(host, [host.podman, 'pull', ref], PULL_TIMEOUT_S, f'podman pull {ref}')
    image = inspect_ours(host, digest)
    if image.get('Digest') != digest:
        raise Refused(f'{ref}: pulled image has Digest {image.get("Digest")!r}, expected {digest}')
    revision = image['Labels'][REVISION_LABEL]
    if revision != sha:
        raise Refused(f'{ref}: label {REVISION_LABEL} is {revision}, expected {sha}')
    return f'PULLED {digest} {image["Id"]} content={_content(ref, image)} revision={sha}'


def _content(ref, image):
    content = image['Labels'].get(CONTENT_LABEL)
    if not (isinstance(content, str) and CONTENT.fullmatch(content)):
        raise Refused(f'{ref}: label {CONTENT_LABEL} is {content!r}, not 64 hex')
    return content


def local(host, digest):
    """Whether D is here already, by `image inspect` alone: the rollback target is checked without the registry
    (plan b-core "Рішення" п.10). The same identity as `inspect_ours`: RepoDigests name REPOSITORY@D."""
    ref = image_ref(digest)
    try:
        image = inspect_ours(host, digest)
    except NotLocal:
        print(f'NOT LOCAL {digest}')
        return EX_NOT_LOCAL
    print(f'LOCAL {digest} {image["Id"]} content={_content(ref, image)} revision={image["Labels"][REVISION_LABEL]}')
    return 0


# --- what runs now (spec §3.2, "Рішення" п.9) ---

QUADLET_IMAGE = re.compile(r'Image=' + re.escape(REPOSITORY) + r'@(sha256:[0-9a-f]{64})')


def quadlet_digest(host):
    """The digest the Quadlet file pins, or None when there is no file. Anything else in its Image= is refused."""
    try:
        fd = os.open(host.quadlet_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise Refused(f'{host.quadlet_path}: {e.strerror}') from None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Refused(f'{host.quadlet_path}: not a regular file')
    with os.fdopen(fd, 'r', encoding='utf-8') as f:
        lines = [line.strip() for line in f.read(1 << 20).splitlines() if line.strip().startswith('Image=')]
    if len(lines) != 1:
        raise Refused(f'{host.quadlet_path}: expected exactly one Image= line, found {len(lines)}')
    m = QUADLET_IMAGE.fullmatch(lines[0])
    if not m:
        raise Refused(f'{host.quadlet_path}: {lines[0]!r} is not Image={REPOSITORY}@sha256:<64 hex>')
    return m.group(1)


def unit_type(host):
    """'quadlet' when warsaw-beer-bot.service is generated from our Quadlet file, 'absent' when systemd knows no
    such unit, 'foreign' otherwise (an /etc/systemd/system unit shadowing it, a masked unit, …)."""
    r = _must(host, [host.systemctl, 'show', UNIT, '-p', 'LoadState,SourcePath,FragmentPath'], SYSTEMCTL_TIMEOUT_S,
              'systemctl show')
    props = {}
    for line in r.stdout.splitlines():
        key, sep, value = line.partition('=')
        if sep:
            props[key] = value
    if 'LoadState' not in props:
        raise Refused(f'systemctl show {UNIT}: no LoadState in {_tail(r.stdout)!r}')
    if props['LoadState'] == 'not-found':
        return 'absent'
    if (props.get('SourcePath') == host.quadlet_path
            and props.get('FragmentPath', '').startswith(GENERATOR_DIR)):
        return 'quadlet'
    return 'foreign'


def container_identity(host):
    """(image id, image digest) of the container `warsaw-beer-bot`, or (None, None) when there is none."""
    r = _call(host, [host.podman, 'container', 'inspect', CONTAINER, '--format', '{{.Image}} {{.ImageDigest}}'],
              INSPECT_TIMEOUT_S, 'podman container inspect')
    if r.returncode != 0:
        if 'no such container' in (r.stderr or '').lower():
            return None, None
        raise TempFail(f'podman container inspect exited {r.returncode}: {_tail(r.stderr)}')
    fields = r.stdout.split()
    if not (len(fields) == 2 and IMAGE_ID.fullmatch(fields[0]) and DIGEST.fullmatch(fields[1])):
        raise Refused(f'podman container inspect {CONTAINER}: unexpected {_tail(r.stdout)!r}')
    return fields[0], fields[1]


def current(host):
    quadlet = quadlet_digest(host)
    image_id, image_digest = container_identity(host)
    unit = unit_type(host)
    return (f'CURRENT quadlet={quadlet or "none"} container-image={image_id or "none"} '
            f'container-digest={image_digest or "none"} unit={unit}')


# --- trial and audit containers ("Рішення" п.1–3, 8; spec §5, §6.3) ---

# The substitute environment of the compat check (spec §6.3), as scripts/image-smoke.sh: required keys only, fake
# but well-formed; every optional feature stays off. No .env is mounted.
TRIAL_ENV = (
    ('TELEGRAM_BOT_TOKEN', '123456:abcdefghij'),
    ('OSRM_BASE_URL', 'http://x'),
    ('NOMINATIM_USER_AGENT', 'x'),
    ('DATABASE_PATH', '/data/app.db'),
    ('WBB_RELEASE_REQUIRED', 'true'),
    ('API_PORT', '3000'),
)
# Audit: the same, with no database (it mounts nothing).
AUDIT_ENV = tuple(kv for kv in TRIAL_ENV if kv[0] != 'DATABASE_PATH')
TRIAL_COMMAND = ['node', 'deploy/trial-migrate.cjs', '/app', '/data/app.db']
START_COMMAND = ['node', 'deploy/image/start-check.cjs', '--leave-running', '--timeout', str(START_CHECK_S)]
# The CI audit step's command (.github/workflows/ci.yml), run in the image itself.
AUDIT_COMMAND = ['sh', '-c',
                 'cd /app && npm audit --omit=dev --json | node_modules/.bin/tsx scripts/autodeploy/audit-verdict-cli.ts']


def container_name(host, action, step):
    return f'wbb-image-{action}-{host.pid()}-{step}'


def container_argv(host, action, step, digest, command, *, network, volume, env):
    """`podman run` of one step: the confinement every trial/audit container runs under ("Рішення" п.8)."""
    uid, gid = host.bot_ids()
    argv = [host.podman, 'run', '--name', container_name(host, action, step), '--rm', '--pull=never',
            f'--network={network}', '--read-only', '--tmpfs', '/tmp', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--user', f'{uid}:{gid}', '--memory=1g', '--pids-limit=256']
    if volume is not None:
        argv += ['-v', f'{volume}:/data']
    for key, value in env:
        argv += ['-e', f'{key}={value}']
    return argv + [image_ref(digest), *command]


def _in_container(host, action, step, digest, command, timeout, *, network, volume, env):
    """Run one step; its container is removed afterwards whatever happened.

    On a timeout bounded.run stops the podman client, and the container may outlive it ("Рішення" п.8).
    """
    name = container_name(host, action, step)
    argv = container_argv(host, action, step, digest, command, network=network, volume=volume, env=env)
    try:
        return _call(host, argv, timeout, f'{step} in {digest}')
    finally:
        # The verdict stands either way (the step itself ran); a container left behind is said, not hidden
        # (#858 AI review): the next run uses another name, and a human sees it in the tick's log.
        try:
            r = host.run([host.podman, 'rm', '-f', '-i', name], timeout=REMOVE_TIMEOUT_S, text=True)
        except subprocess.TimeoutExpired:
            _note(f'wbb-image: podman rm -f -i {name} timed out')
        else:
            if r.returncode != 0:
                _note(f'wbb-image: podman rm -f -i {name} exited {r.returncode}: {_one_line(_tail(r.stderr))}')


def _first_line(text):
    lines = (text or '').splitlines()
    return lines[0][:LINE_CHARS] if lines else ''


def _said(first):
    return f': {first}' if first else ''


# Lines for a human that go to stderr only after the verdict: a caller reads `REFUSED:` / `TEMPFAIL:` as the FIRST
# line of stderr (plan b-core "Рішення" п.9), so no container output may come before it. main() empties it.
_NOTES = []


def _note(text):
    _NOTES.append(text)


def _report(step, r):
    """A step's output tail, for a human, after the verdict; never parsed."""
    _note(f'[{step} exited {r.returncode}]')
    for stream in (r.stdout, r.stderr):
        if _tail(stream):
            _note(_tail(stream))


def _check_scratch_root(host):
    """The parent of the trial copies: a directory only its owner (root) can enter."""
    try:
        st = os.lstat(host.scratch_root)
    except FileNotFoundError:
        raise Refused(f'{host.scratch_root}: missing (sudo bash deploy/install-image.sh)') from None
    if not (stat.S_ISDIR(st.st_mode) and st.st_uid == host.scratch_owner and stat.S_IMODE(st.st_mode) == 0o700):
        raise Refused(f'{host.scratch_root}: must be a directory owned by uid {host.scratch_owner} with mode 0700, '
                      f'is uid {st.st_uid} mode {stat.S_IMODE(st.st_mode):04o}'
                      f'{"" if stat.S_ISDIR(st.st_mode) else " (not a directory)"}')


def _open_regular(path, missing):
    """A descriptor and fstat of a regular file at `path`, never through a symlink; O_NONBLOCK, so a FIFO put in
    its place is refused instead of hanging the open. A missing file raises `missing`."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
    except FileNotFoundError:
        raise missing from None
    except OSError as e:
        raise Refused(f'{path}: {e.strerror}') from None
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        os.close(fd)
        raise Refused(f'{path}: not a regular file')
    return fd, st


def _open_snapshot(host, name):
    """The pre snapshot `name`: a descriptor, its fstat and the sha256 its sidecar records.

    db-snapshot.sh runs as the bot and writes `<name>.sha256` next to the snapshot; a snapshot of another owner or
    with another link to it is not one it made. A missing or unreadable sidecar is TEMPFAIL: the next tick takes a
    fresh pre.
    """
    check_snapshot_name(name)
    path = os.path.join(host.snapshot_root, name)
    fd, st = _open_regular(path, TempFail(f'no snapshot {name} in {host.snapshot_root}'))
    try:
        uid, _ = host.bot_ids()
        if st.st_uid != uid or st.st_nlink != 1:
            raise Refused(f'{path}: owned by uid {st.st_uid} with {st.st_nlink} link(s), expected uid {uid} and 1')
        sfd, _ = _open_regular(path + '.sha256', TempFail(f'no checksum {name}.sha256 in {host.snapshot_root}'))
        with os.fdopen(sfd, 'rb') as f:
            recorded = f.read(CHECKSUM_CAP).decode('ascii', 'replace').strip()
        if not IMAGE_ID.fullmatch(recorded):
            raise TempFail(f'{path}.sha256: not a sha256: {recorded[:80]!r}')
    except BaseException:
        os.close(fd)
        raise
    return fd, st, recorded


def _copy_snapshot(host, fd, recorded, scratch):
    """<scratch>/app.db: the snapshot's bytes, hashed as they are read from the same descriptor and compared with
    its sidecar; the copy and then (complete and closed) the scratch directory go to the bot."""
    uid, gid = host.bot_ids()
    db = os.path.join(scratch, 'app.db')
    h = hashlib.sha256()
    out = os.open(db, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            h.update(chunk)
            view = memoryview(chunk)
            while view:
                view = view[os.write(out, view):]
        host.fchown(out, uid, gid)
        os.fchmod(out, 0o600)
    finally:
        os.close(out)
    if h.hexdigest() != recorded:
        raise TempFail(f'snapshot copy has sha256 {h.hexdigest()}, its .sha256 says {recorded}')
    dfd = os.open(scratch, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        host.fchown(dfd, uid, gid)
        os.fchmod(dfd, 0o700)
    finally:
        os.close(dfd)


def _start_check(host, step, digest, scratch):
    return _in_container(host, 'trial', step, digest, START_COMMAND, START_TIMEOUT_S, network='none',
                         volume=scratch, env=TRIAL_ENV)


def _trial_steps(host, digest, previous, revision, previous_revision, scratch):
    # TRIAL: D's migrations on the copy.
    r = _in_container(host, 'trial', 'migrate', digest, TRIAL_COMMAND, TRIAL_TIMEOUT_S, network='none',
                      volume=scratch, env=TRIAL_ENV)
    first = _first_line(r.stdout)
    if r.returncode == 0 and first.startswith('TRIAL OK'):
        print(first)
    elif r.returncode == 1 and first.startswith('TRIAL FAILED:'):
        print(first)
        _report('trial', r)
        return EX_FAILED
    else:
        _report('trial', r)
        if r.returncode == 0:
            raise Refused(f'trial-migrate in {digest} exited 0 with {first!r}, not TRIAL OK')
        raise TempFail(f'trial-migrate in {digest} exited {r.returncode}' + _said(first))

    # START (D): the candidate starts on the migrated copy.
    r = _start_check(host, 'start', digest, scratch)
    first = _first_line(r.stdout)
    if r.returncode == 0 and first == f'START OK {revision}':
        print(first)
    elif r.returncode == 1 and first.startswith('START FAILED:'):
        print(first)
        _report('start', r)
        return EX_FAILED
    else:
        _report('start', r)
        if r.returncode == 0:
            raise Refused(f'start-check in {digest} exited 0 with {first!r}, expected START OK {revision}')
        if r.returncode == EX_USAGE:
            # Our own candidate not knowing --leave-running is this helper's error, not the candidate's.
            raise RuntimeError(f'start-check in {digest} refused its usage (64): {first!r}')
        raise TempFail(f'start-check in {digest} exited {r.returncode}' + _said(first))

    # COMPAT (S): the previous image starts on what D's migrations left — code-only rollback stays possible.
    r = _start_check(host, 'compat', previous, scratch)
    first = _first_line(r.stdout)
    if r.returncode == 0 and first == f'START OK {previous_revision}':
        print(f'COMPAT OK {previous}')
        return 0
    # Spec §6.3: S that fails or does not answer on the copy D has just started on, under the same confinement.
    if (r.returncode == 1 and first.startswith('START FAILED:')) or \
            (r.returncode == EX_TEMPFAIL and first.startswith('START TIMEOUT')):
        print(f'COMPAT FAILED: {first}')
        _report('compat', r)
        return EX_FAILED
    _report('compat', r)
    if r.returncode == 0:
        raise Refused(f'start-check in {previous} exited 0 with {first!r}, expected START OK {previous_revision}')
    if r.returncode == EX_USAGE:
        # "Рішення" п.3: a retry changes nothing.
        raise Refused(f'previous image {previous} predates start-check --leave-running')
    raise TempFail(f'start-check in {previous} exited {r.returncode}' + _said(first))


def trial(host, digest, previous, snapshot):
    check_digest(digest)
    check_digest(previous)
    check_snapshot_name(snapshot)
    _check_scratch_root(host)
    revision = inspect_ours(host, digest)['Labels'][REVISION_LABEL]
    previous_revision = inspect_ours(host, previous)['Labels'][REVISION_LABEL]
    fd, st, recorded = _open_snapshot(host, snapshot)
    scratch = None
    try:
        free = host.free_bytes(host.scratch_root)
        if free < 2 * st.st_size:
            raise TempFail(f'{free} bytes free on {host.scratch_root}, a trial of a {st.st_size}-byte snapshot '
                           f'needs {2 * st.st_size}')
        scratch = tempfile.mkdtemp(prefix='trial-', dir=host.scratch_root)
        _copy_snapshot(host, fd, recorded, scratch)
        os.close(fd)
        fd = None
        return _trial_steps(host, digest, previous, revision, previous_revision, scratch)
    finally:
        if fd is not None:
            os.close(fd)
        if scratch is not None:
            shutil.rmtree(scratch, ignore_errors=True)


def audit(host, digest):
    inspect_ours(host, digest)
    # --network=host: npm needs the registry; the bridge network of rootful podman is unproven on the host (§5).
    r = _in_container(host, 'audit', 'audit', digest, AUDIT_COMMAND, AUDIT_TIMEOUT_S, network='host', volume=None,
                      env=AUDIT_ENV)
    if r.returncode == 0:
        print(f'AUDIT CLEAN {digest}')
        return 0
    if r.returncode == 10:
        print(f'AUDIT ADVISORY {digest}')
        print((r.stdout or '').rstrip('\n'))
        return EX_FAILED
    _report('audit', r)
    raise TempFail(f'audit in {digest} exited {r.returncode}')


# --- activation (spec §3.2, "Рішення" п.9) ---

def _read_template(host):
    try:
        fd = os.open(host.template_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        raise Refused(f'{host.template_path}: {e.strerror} (sudo bash deploy/install-image.sh)') from None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Refused(f'{host.template_path}: not a regular file')
    with os.fdopen(fd, 'r', encoding='utf-8') as f:
        lines = f.read(1 << 20).splitlines(keepends=True)
    # Only the unit's own lines count and are filled in: the template's comments name the placeholders too.
    directives = ''.join(line for line in lines if not _is_comment(line))
    counts = {p: directives.count(p) for p in PLACEHOLDERS}
    if any(n != 1 for n in counts.values()):
        raise Refused(f'{host.template_path}: each placeholder must occur exactly once outside comments, '
                      f'found {counts}')
    return lines


def _is_comment(line):
    return line.lstrip().startswith(('#', ';'))


def render_template(lines, digest, uid, gid):
    """The template's lines with D, UID and GID filled in; comments are left as they are."""
    return ''.join(line if _is_comment(line) else
                   line.replace('@@DIGEST@@', digest).replace('@@UID@@', str(uid)).replace('@@GID@@', str(gid))
                   for line in lines)


def _fsync_dir(directory):
    dfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def _write_atomically(path, data):
    """`path` holds `data` (bytes) or what it held before, never a part: a 0644 temp file in the same directory,
    fsync, rename over it, fsync of the directory."""
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o755, exist_ok=True)
    tmp = path + '.tmp'
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    _fsync_dir(directory)


def _read_previous(host):
    """The Quadlet file's bytes before activate writes it, or None when there is none."""
    try:
        fd, _ = _open_regular(host.quadlet_path, FileNotFoundError())
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as f:
        return f.read(1 << 20)


def _restore_file(host, previous):
    """Put back what the Quadlet file held before this activate (or no file)."""
    if previous is None:
        try:
            os.unlink(host.quadlet_path)
        except FileNotFoundError:
            pass
        _fsync_dir(os.path.dirname(host.quadlet_path))
    else:
        _write_atomically(host.quadlet_path, previous)


def _restore(host, previous):
    """_restore_file, and let systemd see it."""
    _restore_file(host, previous)
    _must(host, [host.systemctl, 'daemon-reload'], DAEMON_RELOAD_TIMEOUT_S, 'systemctl daemon-reload (restore)')


def _one_line(text):
    return ' '.join((text or '').split())[-LINE_CHARS:]


def activate(host, digest):
    inspect_ours(host, digest)
    before = unit_type(host)
    if before == 'foreign':
        raise Refused(f'{UNIT} is not generated from {host.quadlet_path} (a unit elsewhere shadows it?)')
    lines = _read_template(host)
    previous = _read_previous(host)
    uid, gid = host.bot_ids()
    _write_atomically(host.quadlet_path, render_template(lines, digest, uid, gid).encode('utf-8'))
    try:
        _must(host, [host.systemctl, 'daemon-reload'], DAEMON_RELOAD_TIMEOUT_S, 'systemctl daemon-reload')
    except TempFail as failed:
        # Not left naming D on disk (#858 AI review): a later reload or a reboot would start it with nobody
        # watching. The file goes back first; then one more reload, best effort — a client that failed or timed
        # out does not prove systemd did not reload, and it must not keep a unit generated from D. Still 75:
        # nothing was activated, and stage б repeats activate (spec §7.2).
        # The second reload runs whatever the restore did: it may have replaced the file and failed only after
        # (the directory fsync), and systemd must see what is on disk now (#858 AI review, round 3). If systemd
        # fails twice, nothing here can prove more: 75, and stage б repeats activate (spec §7.2).
        notes = []
        try:
            _restore_file(host, previous)
        except OSError as e:
            notes.append(f'putting the previous {host.quadlet_path} back failed too: {e}')
        try:
            _must(host, [host.systemctl, 'daemon-reload'], DAEMON_RELOAD_TIMEOUT_S, 'systemctl daemon-reload (restore)')
        except TempFail as again:
            notes.append(f'then {again}' if notes else f'the previous file is back, {again}')
        if notes:
            raise TempFail('; '.join([str(failed), *notes])) from None
        raise
    after = unit_type(host)
    if after != 'quadlet':
        _restore(host, previous)
        raise Refused(f'after daemon-reload {UNIT} was {after}, not generated from {host.quadlet_path}; '
                      'the previous file is back, not restarted')
    r = _call(host, [host.systemctl, 'restart', UNIT], RESTART_TIMEOUT_S, f'systemctl restart {UNIT}')
    if r.returncode != 0:
        # The file names D and systemd could not start it: a verdict on D in production (stage б rolls back).
        print(f'ACTIVATE FAILED: restart exited {r.returncode}: {_one_line(_tail(r.stderr))}')
        return EX_FAILED
    print(f'ACTIVATED {digest}')
    return 0


# --- retention (spec §9) ---

def _listed_images(stdout):
    """(id, digests) of each image in `podman images --format json`; anything else refuses the prune."""
    try:
        data = json.loads(stdout or '[]')
    except ValueError:
        raise Refused(f'podman images: not JSON: {_tail(stdout)[:200]!r}') from None
    if not isinstance(data, list):
        raise Refused(f'podman images: not a list: {_tail(stdout)[:200]!r}')
    images = []
    for entry in data:
        image_id = entry.get('Id') if isinstance(entry, dict) else None
        repo_digests = entry.get('RepoDigests') if isinstance(entry, dict) else None
        digest = entry.get('Digest') if isinstance(entry, dict) else None
        names = repo_digests if repo_digests is not None else []
        if not (isinstance(image_id, str) and IMAGE_ID.fullmatch(image_id) and isinstance(names, list)
                and all(isinstance(n, str) and '@' in n and DIGEST.fullmatch(n.rsplit('@', 1)[1]) for n in names)
                and isinstance(digest, str) and DIGEST.fullmatch(digest)):
            raise Refused(f'podman images: unexpected entry {json.dumps(entry)[:300]}')
        images.append((image_id, {n.rsplit('@', 1)[1] for n in names} | {digest}))
    return images


def prune(host, keep):
    keep = {check_digest(d) for d in keep}
    pinned = quadlet_digest(host)
    if pinned is not None:
        keep.add(pinned)
    r = _must(host, [host.podman, 'images', '--filter', f'reference={REPOSITORY}', '--format', 'json'],
              INSPECT_TIMEOUT_S, 'podman images')
    images = _listed_images(r.stdout)
    # An image with any kept digest among its names is kept: rmi takes the image, not a name.
    kept_ids = {image_id for image_id, digests in images if digests & keep}
    removed = skipped = 0
    for image_id in dict.fromkeys(image_id for image_id, _ in images if image_id not in kept_ids):
        rr = _call(host, [host.podman, 'rmi', image_id], RMI_TIMEOUT_S, f'podman rmi {image_id}')
        if rr.returncode == 0:
            removed += 1
        else:
            # In use by a container, or podman failed: left for the next prune, never fatal.
            skipped += 1
    return f'PRUNED {removed} skipped {skipped} kept {" ".join(sorted(keep))}'


# --- entry point ---

def _parser():
    # No -h/--help: argparse would exit 0 on it, the code of "done" (an unknown option is 64 instead).
    ap = argparse.ArgumentParser(prog='wbb-image', add_help=False,
                                 description='Pull, check, trial, audit, activate, inspect or prune the bot image.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('pull', add_help=False)
    p.add_argument('--sha', required=True)
    p.add_argument('--digest', required=True)
    t = sub.add_parser('trial', add_help=False)
    t.add_argument('--digest', required=True)
    t.add_argument('--previous', required=True)
    t.add_argument('--snapshot', required=True)
    sub.add_parser('local', add_help=False).add_argument('--digest', required=True)
    sub.add_parser('audit', add_help=False).add_argument('--digest', required=True)
    sub.add_parser('activate', add_help=False).add_argument('--digest', required=True)
    sub.add_parser('current', add_help=False)
    sub.add_parser('prune', add_help=False).add_argument('--keep', action='append', required=True)
    return ap


def _run(a, host):
    if a.cmd == 'trial':
        return trial(host, a.digest, a.previous, a.snapshot)
    if a.cmd == 'audit':
        return audit(host, a.digest)
    if a.cmd == 'local':
        return local(host, a.digest)
    if a.cmd == 'pull':
        print(pull(host, a.sha, a.digest))
    elif a.cmd == 'activate':
        return activate(host, a.digest)
    elif a.cmd == 'current':
        print(current(host))
    else:
        print(prune(host, a.keep))
    return 0


def _verdict_line(kind, e):
    """`REFUSED: …` / `TEMPFAIL: …` as one line: a message may carry podman's multi-line stderr."""
    return f'{kind}: ' + ' '.join(str(e).splitlines())


def main(argv, host=PRODUCTION):
    try:
        a = _parser().parse_args(argv)
    except SystemExit as e:
        return EX_USAGE if e.code else 0
    _NOTES.clear()
    try:
        return _run(a, host)
    except Refused as e:
        print(_verdict_line('REFUSED', e), file=sys.stderr)
        return EX_REFUSED
    except TempFail as e:
        print(_verdict_line('TEMPFAIL', e), file=sys.stderr)
        return EX_TEMPFAIL
    except Exception:
        traceback.print_exc()
        return EX_SOFTWARE
    finally:
        for line in _NOTES:
            print(line, file=sys.stderr)
        _NOTES.clear()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
