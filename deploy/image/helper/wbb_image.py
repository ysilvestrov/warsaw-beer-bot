#!/usr/bin/env python3
"""Root helper `wbb-image`: the bot's OCI image on the host — pull, inspect, prune (and, next, trial/audit/activate).

Spec: docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §3.2, §3.3, §5, §9.
Plan: docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md, "Рішення" п.5–9, Task 2.

Meant to be installed root-owned as /usr/local/lib/wbb-image/wbb_image.py and run as root through
/usr/local/libexec/wbb-image (deploy/image/helper/wbb-image.sh) under fixed sudo rules. The trust boundary is
argv: `*` in sudoers matches spaces too, so every value is checked here (a full lowercase SHA, a `sha256:`
digest, a snapshot NAME — never a path) and nothing the operator passes reaches podman but a checked digest.
Everything that depends on the host (paths, binaries, the bot's ids, free space) lives in `Host`, which
`main()` takes as a parameter: tests pass a fake one.

Usage: wbb_image.py pull --sha <40 hex> --digest sha256:<64 hex>
       wbb_image.py current
       wbb_image.py prune --keep sha256:<64 hex> [--keep …]

Output: one verdict line on stdout —
  `PULLED <D> <image id> content=<wbb.content> revision=<sha>`
  `CURRENT quadlet=<D|none> container-image=<id|none> container-digest=<D|none> unit=quadlet|foreign|absent`
  `PRUNED <n> skipped <m> kept <digest …>`
Exit (as deploy/release/wbb_release.py):
   0  done
   1  ONLY with a verdict on the candidate (TRIAL FAILED, COMPAT FAILED, AUDIT ADVISORY; the next actions)
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
    ap = argparse.ArgumentParser(prog='wbb-image', description='Pull, inspect or prune the bot image on this host.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('pull')
    p.add_argument('--sha', required=True)
    p.add_argument('--digest', required=True)
    sub.add_parser('current')
    sub.add_parser('prune').add_argument('--keep', action='append', required=True)
    return ap


def _run(a, host):
    if a.cmd == 'pull':
        print(pull(host, a.sha, a.digest))
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
