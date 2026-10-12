#!/usr/bin/env python3
"""Root helper `wbb-image`: the bot's OCI image on the host — pull, trial, audit, activate, inspect, prune.

Spec: docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §3.2, §3.3, §5, §9.
Plan: docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md, "Рішення" п.1–3, 5–9, Tasks 2–3.

Meant to be installed root-owned as /usr/local/lib/wbb-image/wbb_image.py and run as root through
/usr/local/libexec/wbb-image (deploy/image/helper/wbb-image.sh) under fixed sudo rules. The trust boundary is
argv: `*` in sudoers matches spaces too, so every value is checked here (a full lowercase SHA, a `sha256:`
digest, a snapshot NAME — never a path) and nothing the operator passes reaches podman but a checked digest.
Everything that depends on the host (paths, binaries, the bot's ids, free space) lives in `Host`, which
`main()` takes as a parameter: tests pass a fake one.

Usage: wbb_image.py pull     --sha <40 hex> --digest sha256:<64 hex>
       wbb_image.py trial    --digest D --previous S --snapshot <YYYYMMDD>T<HHMMSS>Z-<sha>-pre.db
       wbb_image.py audit    --digest D
       wbb_image.py activate --digest D
       wbb_image.py current
       wbb_image.py prune    --keep sha256:<64 hex> [--keep …]
D, S: local images of our repository (`inspect_ours`). The snapshot is a NAME in the snapshot root, never a path.

Output: the verdict is the last line on stdout —
  `PULLED <D> <image id> content=<wbb.content> revision=<sha>`
  trial, one line per step: `TRIAL OK: …` (trial-migrate's own line), `START OK <revision of D>`,
  `COMPAT OK <S>`; or, ending it, `TRIAL FAILED: …`, `START FAILED: …` or `COMPAT FAILED: <S's start-check line>`
  (exit 1). The containers' output tails go to stderr. Each step runs in a container of its own on the same
  private copy of the snapshot: TRIAL migrates it with D, START starts D on it, COMPAT starts S on what D left.
  `AUDIT CLEAN <D>`; or `AUDIT ADVISORY <D>` followed by the verdict's own lines (exit 1)
  `ACTIVATED <D>`
  `CURRENT quadlet=<D|none> container-image=<id|none> container-digest=<D|none> unit=quadlet|foreign|absent`
  `PRUNED <n> skipped <m> kept <digest …>`
Exit (as deploy/release/wbb_release.py):
   0  done
   1  ONLY with a verdict on the candidate on stdout: TRIAL FAILED, START FAILED, COMPAT FAILED, AUDIT ADVISORY
   2  refused: an input or a precondition (`REFUSED: …` on stderr) — not a verdict on the candidate
  64  usage
  70  internal error (a traceback on stderr); also a module of the helper that fails to import
  75  could not judge now — retry (`TEMPFAIL: …` on stderr): podman failed or timed out, a registry is down
"""
import argparse
import dataclasses
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
    # os.chown's signature; a test running unprivileged records the call instead.
    chown: Callable
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
    chown=os.chown,
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
            raise Refused(f'{ref} is not a local image')
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
    content = image['Labels'].get(CONTENT_LABEL)
    if not (isinstance(content, str) and CONTENT.fullmatch(content)):
        raise Refused(f'{ref}: label {CONTENT_LABEL} is {content!r}, not 64 hex')
    return f'PULLED {digest} {image["Id"]} content={content} revision={sha}'


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
        try:
            host.run([host.podman, 'rm', '-f', '-i', name], timeout=REMOVE_TIMEOUT_S, text=True)
        except subprocess.TimeoutExpired:
            print(f'wbb-image: podman rm -f -i {name} timed out', file=sys.stderr)


def _first_line(text):
    lines = (text or '').splitlines()
    return lines[0][:LINE_CHARS] if lines else ''


def _said(first):
    return f': {first}' if first else ''


def _report(step, r):
    """A step's output tail on stderr, for a human; never parsed."""
    print(f'[{step} exited {r.returncode}]', file=sys.stderr)
    for stream in (r.stdout, r.stderr):
        if _tail(stream):
            print(_tail(stream), file=sys.stderr)


def _open_snapshot(host, name):
    """A descriptor of the pre snapshot `name` in the snapshot root: a regular file, never through a symlink."""
    check_snapshot_name(name)
    path = os.path.join(host.snapshot_root, name)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
    except FileNotFoundError:
        raise TempFail(f'no snapshot {name} in {host.snapshot_root}') from None
    except OSError as e:
        raise Refused(f'{path}: {e.strerror}') from None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Refused(f'{path}: not a regular file')
    return fd


def _copy_snapshot(host, fd, scratch):
    uid, gid = host.bot_ids()
    host.chown(scratch, uid, gid)
    os.chmod(scratch, 0o700)
    db = os.path.join(scratch, 'app.db')
    out = os.open(db, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(out, 'wb') as dst, os.fdopen(os.dup(fd), 'rb') as src:
        shutil.copyfileobj(src, dst, 1 << 20)
    host.chown(db, uid, gid)
    os.chmod(db, 0o600)


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
    elif r.returncode == 1:
        print(f'TRIAL FAILED: {first.removeprefix("TRIAL FAILED: ")}')
        _report('trial', r)
        return EX_FAILED
    else:
        _report('trial', r)
        if r.returncode == 0:
            raise Refused(f'trial-migrate in {digest} exited 0 with {first!r}, not TRIAL OK')
        raise TempFail(f'trial-migrate in {digest} exited {r.returncode}')

    # START (D): the candidate starts on the migrated copy.
    r = _start_check(host, 'start', digest, scratch)
    first = _first_line(r.stdout)
    if r.returncode == 0 and first == f'START OK {revision}':
        print(first)
    elif r.returncode == 1:
        print(f'START FAILED: {first.removeprefix("START FAILED: ")}')
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
    if r.returncode == 1:
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
    revision = inspect_ours(host, digest)['Labels'][REVISION_LABEL]
    previous_revision = inspect_ours(host, previous)['Labels'][REVISION_LABEL]
    fd = _open_snapshot(host, snapshot)
    scratch = None
    try:
        scratch = tempfile.mkdtemp(prefix='trial-', dir=host.scratch_root)
        _copy_snapshot(host, fd, scratch)
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


def _write_atomically(path, text):
    """`path` holds `text` or what it held before, never a part: a 0644 temp file in the same directory, fsync,
    rename over it, fsync of the directory."""
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
            f.write(text.encode('utf-8'))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    dfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def activate(host, digest):
    inspect_ours(host, digest)
    before = unit_type(host)
    if before == 'foreign':
        raise Refused(f'{UNIT} is not generated from {host.quadlet_path} (a unit elsewhere shadows it?)')
    lines = _read_template(host)
    uid, gid = host.bot_ids()
    _write_atomically(host.quadlet_path, render_template(lines, digest, uid, gid))
    _must(host, [host.systemctl, 'daemon-reload'], DAEMON_RELOAD_TIMEOUT_S, 'systemctl daemon-reload')
    after = unit_type(host)
    if after != 'quadlet':
        raise Refused(f'after daemon-reload {UNIT} is {after}, not generated from {host.quadlet_path}; not restarted')
    _must(host, [host.systemctl, 'restart', UNIT], RESTART_TIMEOUT_S, f'systemctl restart {UNIT}')
    return f'ACTIVATED {digest}'


# --- retention (spec §9) ---

def prune(host, keep):
    keep = {check_digest(d) for d in keep}
    pinned = quadlet_digest(host)
    if pinned is not None:
        keep.add(pinned)
    r = _must(host, [host.podman, 'images', '--filter', f'reference={REPOSITORY}', '--format', '{{.Id}} {{.Digest}}'],
              INSPECT_TIMEOUT_S, 'podman images')
    rows = []
    for line in r.stdout.splitlines():
        if not line.strip():
            continue
        fields = line.split()
        if not (len(fields) == 2 and IMAGE_ID.fullmatch(fields[0]) and DIGEST.fullmatch(fields[1])):
            # Nothing is removed on a listing this helper cannot read.
            raise Refused(f'podman images: unexpected line {line!r}')
        rows.append((fields[0], fields[1]))
    # An image listed under a kept digest is kept under every other name too: rmi takes the image, not a name.
    kept_ids = {image_id for image_id, d in rows if d in keep}
    removed = skipped = 0
    for image_id in dict.fromkeys(image_id for image_id, _ in rows if image_id not in kept_ids):
        rr = _call(host, [host.podman, 'rmi', image_id], RMI_TIMEOUT_S, f'podman rmi {image_id}')
        if rr.returncode == 0:
            removed += 1
        else:
            # In use by a container, or podman failed: left for the next prune, never fatal.
            skipped += 1
    return f'PRUNED {removed} skipped {skipped} kept {" ".join(sorted(keep))}'


# --- entry point ---

def _parser():
    ap = argparse.ArgumentParser(prog='wbb-image', description='Pull, trial, audit, activate, inspect or prune the bot image on this host.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('pull')
    p.add_argument('--sha', required=True)
    p.add_argument('--digest', required=True)
    t = sub.add_parser('trial')
    t.add_argument('--digest', required=True)
    t.add_argument('--previous', required=True)
    t.add_argument('--snapshot', required=True)
    sub.add_parser('audit').add_argument('--digest', required=True)
    sub.add_parser('activate').add_argument('--digest', required=True)
    sub.add_parser('current')
    sub.add_parser('prune').add_argument('--keep', action='append', required=True)
    return ap


def _run(a, host):
    if a.cmd == 'trial':
        return trial(host, a.digest, a.previous, a.snapshot)
    if a.cmd == 'audit':
        return audit(host, a.digest)
    if a.cmd == 'pull':
        print(pull(host, a.sha, a.digest))
    elif a.cmd == 'activate':
        print(activate(host, a.digest))
    elif a.cmd == 'current':
        print(current(host))
    else:
        print(prune(host, a.keep))
    return 0


def main(argv, host=PRODUCTION):
    try:
        a = _parser().parse_args(argv)
    except SystemExit as e:
        return EX_USAGE if e.code else 0
    try:
        return _run(a, host)
    except Refused as e:
        print(f'REFUSED: {e}', file=sys.stderr)
        return EX_REFUSED
    except TempFail as e:
        print(f'TEMPFAIL: {e}', file=sys.stderr)
        return EX_TEMPFAIL
    except Exception:
        traceback.print_exc()
        return EX_SOFTWARE


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
