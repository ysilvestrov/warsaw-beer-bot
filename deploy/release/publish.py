"""Publish a trusted runtime artifact as an immutable release tree with a receipt (host, root).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §2, §4
("Publication TOCTOU boundary"), §10a, §10b row prepared/publish.
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2a.md, Task 3.
`current_sha`/`switch` (the `current` pointer): plan .../2026-10-09-wbb-artifact-deployment-core-2c.md, Task 2.

Every check runs on bytes this process copied into its own private scratch: the
operator's download is opened once, without following a final symlink, and copied
with a bounded read; after that the operator can change their file all they like.
The tree becomes releases/<sha> by one rename, and only then does the receipt
appear, written atomically. A release tree without a receipt is never activated;
the next publish re-verifies it in full before writing the receipt. Nothing from
the payload is executed here.
"""
import errno
import hashlib
import json
import os
import secrets
import shutil
import stat
import sys
import tempfile
import time
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tree_manifest as tm  # noqa: E402
from github_trust import SHA  # noqa: E402
from safe_tar import Refused, extract  # noqa: E402
from zip_admission import ZipCaps, admit_zip, sha256_file  # noqa: E402

RECEIPT_FORMAT = 1
RECEIPT_KEYS = ('formatVersion', 'repo', 'sourceSha', 'runId', 'runAttempt', 'artifactId',
                'zipSha256', 'tarSha256', 'treeSha256', 'acceptedAt')


@dataclass(frozen=True)
class Roots:
    releases: str
    receipts: str
    scratch: str
    # Who owns a published tree: root in production; tests pass their own ids.
    owner: tuple = (0, 0)


def _utc_now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def copy_operator_archive(src, dest, cap):
    """Copy src (a regular file, final component not a symlink) into dest (new, 0600), at most cap bytes."""
    try:
        fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        if e.errno == errno.ELOOP:
            raise Refused(f'{src}: is a symlink') from None
        raise Refused(f'{src}: cannot open ({e.strerror})') from None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Refused(f'{src}: not a regular file')
    with os.fdopen(fd, 'rb') as f:
        out_fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(out_fd, 'wb') as out:
            total = 0
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > cap:
                    raise Refused(f'{src}: over {cap} bytes')
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())


def check_identity(payload, trusted):
    """release.json must name exactly the trusted repo, SHA, workflow, run and attempt."""
    with open(os.path.join(payload, 'release.json'), encoding='utf-8') as f:
        rel = json.load(f)
    want = {'formatVersion': 1, 'repo': trusted.repo, 'sourceSha': trusted.sha, 'workflow': trusted.workflow,
            'runId': trusted.run_id, 'runAttempt': trusted.run_attempt}
    bad = [f'{k}={rel.get(k)!r}' for k, v in want.items() if rel.get(k) != v or type(rel.get(k)) is not type(v)]
    if bad:
        raise Refused(f'release.json does not match the trusted run: {", ".join(bad)}')


def normalize(tree, manifest, owner):
    """Every entry, the root and the manifest: owned by owner, modes exactly as the manifest says."""
    for e in manifest['entries']:
        path = os.path.join(tree, e['path'])
        os.lchown(path, *owner)
        if e['type'] != 'symlink':
            os.chmod(path, e['mode'])
    os.chown(os.path.join(tree, tm.MANIFEST_NAME), *owner)
    os.chmod(os.path.join(tree, tm.MANIFEST_NAME), 0o644)
    os.chown(tree, *owner)
    os.chmod(tree, tm.DIR_MODE)


def fsync_tree(tree):
    """fsync every regular file and directory under tree, children before parents, root last.

    A directory fsync makes its entries durable, not the data of the files they name
    (fsync(2)); the receipt must never become durable ahead of the bytes it vouches for.
    """
    for dirpath, dirnames, filenames in os.walk(tree, topdown=False):
        for name in filenames:
            path = os.path.join(dirpath, name)
            if os.path.islink(path):
                continue
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        fsync_dir(dirpath)


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_atomic(path, data, prefix):
    """Replace path with data (0600) durably: temp in the same directory, fsync it, rename, fsync the directory.

    A crash leaves either the old file or the new one, never a torn one; a failed write
    or rename leaves the old file as it was and no temp behind.
    """
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=prefix)
    try:
        with os.fdopen(fd, 'wb') as f:
            os.fchmod(f.fileno(), 0o600)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    fsync_dir(directory)


def write_receipt(path, receipt):
    write_atomic(path, tm.canonical_bytes(receipt), '.receipt-')


def read_receipt(path):
    """The receipt at path, None if absent; a malformed one is a refusal, never a blank slate."""
    try:
        with open(path, 'rb') as f:
            data = f.read(64 * 1024)
    except FileNotFoundError:
        return None
    try:
        receipt = json.loads(data)
    except ValueError:
        raise Refused(f'{path}: not JSON') from None
    if not isinstance(receipt, dict) or tuple(sorted(receipt)) != tuple(sorted(RECEIPT_KEYS)) \
            or receipt['formatVersion'] != RECEIPT_FORMAT:
        raise Refused(f'{path}: not a version-{RECEIPT_FORMAT} receipt')
    return receipt


def _paths(sha, roots):
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise Refused(f'not a full lowercase SHA: {sha!r}')
    return os.path.join(roots.releases, sha), os.path.join(roots.receipts, f'{sha}.json')


def _manifest_bytes(tree):
    with open(os.path.join(tree, tm.MANIFEST_NAME), 'rb') as f:
        return f.read()


def verify_release(sha, roots):
    """releases/<sha> is exactly the tree its receipt accepted. No network. Returns the receipt."""
    final, receipt_path = _paths(sha, roots)
    receipt = read_receipt(receipt_path)
    if receipt is None:
        raise Refused(f'{sha}: no receipt — not an accepted release')
    if receipt['sourceSha'] != sha:
        raise Refused(f'{sha}: receipt names {receipt["sourceSha"]}')
    try:
        data = _manifest_bytes(final)
    except OSError as e:
        raise Refused(f'{sha}: release tree unreadable ({e.strerror})') from None
    digest = hashlib.sha256(data).hexdigest()
    if digest != receipt['treeSha256']:
        raise Refused(f'{sha}: tree digest {digest} != receipt {receipt["treeSha256"]}')
    problems = tm.verify_tree(final, data, roots.owner)
    if problems:
        raise Refused(f'{sha}: release tree changed:\n' + '\n'.join(problems[:50]))
    return receipt


def current_path(roots):
    """The `current` symlink: next to releases/, so its target is the relative `releases/<sha>`."""
    return os.path.join(os.path.dirname(roots.releases), 'current')


def current_sha(roots):
    """The SHA `current` points at; None if there is no `current`. Anything but `releases/<sha>` is refused.

    This says where the NEXT start will run from, not what is running now: a started
    process keeps the tree it was started from (plan 2v, premise probe on realpath).
    """
    path = current_path(roots)
    try:
        target = os.readlink(path)
    except FileNotFoundError:
        return None
    except OSError as e:
        if e.errno == errno.EINVAL:
            raise Refused(f'{path}: not a symlink') from None
        raise
    prefix = os.path.basename(roots.releases) + '/'
    sha = target[len(prefix):]
    if not target.startswith(prefix) or not SHA.fullmatch(sha):
        raise Refused(f'{path} -> {target!r}: not {prefix}<full sha>')
    return sha


def switch(sha, roots):
    """Point `current` at releases/<sha> by one atomic rename. Returns 'switched' or 'current' (already there).

    The tree is verified against its receipt immediately before the rename; a `current`
    this does not understand (a directory, a foreign target) is refused, never replaced.
    """
    verify_release(sha, roots)
    path = current_path(roots)
    parent = os.path.dirname(path)
    if current_sha(roots) == sha:
        # 2v review: an attempt that renamed and died before its fsync left the rename not yet
        # durable; the no-op retry makes it so before it answers 'current'.
        fsync_dir(parent)
        return 'current'
    tmp = os.path.join(parent, f'current.tmp-{secrets.token_hex(8)}')
    os.symlink(os.path.join(os.path.basename(roots.releases), sha), tmp)
    try:
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise
    fsync_dir(parent)
    return 'switched'


def publish(trusted, operator_zip, roots, now=_utc_now):
    """Accept trusted.sha from the operator's ZIP. Returns 'accepted' or 'already-accepted'."""
    final, receipt_path = _paths(trusted.sha, roots)
    existing = read_receipt(receipt_path)
    if os.stat(roots.scratch).st_dev != os.stat(roots.releases).st_dev:
        raise Refused('scratch and releases are on different filesystems; publication needs one atomic rename')
    work = tempfile.mkdtemp(dir=roots.scratch, prefix=f'publish-{trusted.sha[:12]}-')
    try:
        zip_copy = os.path.join(work, 'artifact.zip')
        copy_operator_archive(operator_zip, zip_copy, ZipCaps().zip_bytes)
        tar, tar_sha = admit_zip(zip_copy, trusted.zip_sha256, os.path.join(work, 'zip'))
        tree = os.path.join(work, 'tree')
        extract(tar, tree)
        data = _manifest_bytes(tree)
        problems = tm.verify_tree(tree, data)
        if problems:
            raise Refused('tree does not match tree-manifest.json:\n' + '\n'.join(problems[:50]))
        check_identity(tree, trusted)
        tree_sha = hashlib.sha256(data).hexdigest()

        if existing is not None:
            if (existing['tarSha256'], existing['treeSha256']) != (tar_sha, tree_sha):
                raise Refused(f'{trusted.sha} was already accepted with tar {existing["tarSha256"]} / tree '
                              f'{existing["treeSha256"]}; this artifact has tar {tar_sha} / tree {tree_sha}. '
                              'Explicit operator recovery or a new commit is required.')
            verify_release(trusted.sha, roots)
            return 'already-accepted'

        if os.path.lexists(final):
            # A crash between rename and receipt: accept the tree only if it is exactly these bytes.
            if not os.path.isdir(final) or os.path.islink(final):
                raise Refused(f'{final} exists and is not a release directory')
            try:
                same = _manifest_bytes(final) == data
            except OSError:
                same = False
            if not same or tm.verify_tree(final, data, roots.owner):
                raise Refused(f'{final} exists without a receipt and does not match this artifact; operator recovery required')
            # The crash may have come before its bytes reached the disk.
            fsync_tree(final)
        else:
            normalize(tree, json.loads(data), roots.owner)
            problems = tm.verify_tree(tree, data, roots.owner)
            if problems:
                raise Refused('normalised tree is not exact:\n' + '\n'.join(problems[:50]))
            fsync_tree(tree)
            os.rename(tree, final)
        fsync_dir(roots.releases)

        write_receipt(receipt_path, {
            'formatVersion': RECEIPT_FORMAT, 'repo': trusted.repo, 'sourceSha': trusted.sha,
            'runId': trusted.run_id, 'runAttempt': trusted.run_attempt, 'artifactId': trusted.artifact_id,
            'zipSha256': trusted.zip_sha256, 'tarSha256': tar_sha, 'treeSha256': tree_sha, 'acceptedAt': now(),
        })
        return 'accepted'
    finally:
        shutil.rmtree(work, ignore_errors=True)
