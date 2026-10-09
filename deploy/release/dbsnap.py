#!/usr/bin/env python3
"""Durable post capture and crash-safe pre restore of the bot database (host, bot user).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §8 (pre/post DB),
§10a (rollback post/pre), §10b rows `save post` and `restore pre`.
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2c.md, Task 2.

Replaces `db-snapshot.sh post|restore` for the rollback engine (plan 2v, premise probe):
- post: the shell version copied straight into the target directory, without fsync or a
  receipt, so a crash half-way left an incomplete directory that looked like a finished
  post and that a retry refused to touch. Here the copy goes into `<out>.partial`; only
  after every file and `post.json` (size and sha256 of each file) are fsynced does it
  become `<out>` by one rename. `<out>` therefore exists only complete, and is never
  rewritten.
- restore: the shell version replaced the database and only then removed -wal/-shm; a
  crash in between left pre next to the post-state WAL, which SQLite replays on open.
  Here the WAL/SHM go first.
The `pre` snapshot and its `.sha256` sidecar are what `db-snapshot.sh snapshot` writes.

The writers (bot, Litestream) must be stopped before either runs; that is the engine's
step, observed there, not assumed here.

Usage: dbsnap.py post <db> <out-dir>
       dbsnap.py restore <pre.db> <db> <post-dir>
Output: `POST <out-dir>` or `RESTORED|ALREADY <db>`.
Exit: 0 done; 2 refused (`REFUSED:` on stderr: no complete post, pre does not match its
checksum, an <out-dir> that is not a complete post) — nothing was changed; 64 usage;
70 internal error (traceback); 75 an OS error (disk, permissions) — retry.
"""
import errno
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tree_manifest as tm  # noqa: E402
from publish import fsync_dir  # noqa: E402
from safe_tar import Refused  # noqa: E402
from trial import SNAPSHOT_SUM  # noqa: E402

POST_MANIFEST = 'post.json'
POST_MANIFEST_MAX_BYTES = 64 * 1024
SUFFIXES = ('', '-wal', '-shm')
HEX64 = re.compile(r'[0-9a-f]{64}')
EX_REFUSED = 2
EX_USAGE = 64
EX_SOFTWARE = 70
EX_TEMPFAIL = 75


def _open_regular(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        if e.errno == errno.ELOOP:
            raise Refused(f'{path}: is a symlink') from None
        raise
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Refused(f'{path}: not a regular file')
    return os.fdopen(fd, 'rb')


def _digest(path):
    """(size, sha256 hex) of a regular file, not following a final symlink."""
    h, size = hashlib.sha256(), 0
    with _open_regular(path) as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
            size += len(chunk)
    return size, h.hexdigest()


def _copy(src, dst, mode=0o600):
    """Copy src into a new dst, fsync it; return (size, sha256) of the bytes written."""
    h, size = hashlib.sha256(), 0
    with _open_regular(src) as f:
        out_fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(out_fd, 'wb') as out:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                out.write(chunk)
                h.update(chunk)
                size += len(chunk)
            out.flush()
            os.fsync(out.fileno())
    return size, h.hexdigest()


def _remove(path):
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    elif os.path.lexists(path):
        os.unlink(path)


def _names(db):
    return [os.path.basename(db) + s for s in SUFFIXES]


def _entry_ok(e):
    return (isinstance(e, dict) and sorted(e) == ['sha256', 'size'] and type(e['size']) is int and e['size'] >= 0
            and isinstance(e['sha256'], str) and HEX64.fullmatch(e['sha256']) is not None)


def _files(manifest, names):
    """manifest['files'] if it is exactly {files: {<db>[, <db>-wal][, <db>-shm]: {size, sha256}}}, else None."""
    if not isinstance(manifest, dict) or list(manifest) != ['files'] or not isinstance(manifest['files'], dict):
        return None
    files = manifest['files']
    if names[0] not in files or not set(files) <= set(names) or not all(map(_entry_ok, files.values())):
        return None
    return files


def read_post(post_dir, db):
    """The manifest of the complete post of db at post_dir; Refused naming why it is not one."""
    path = os.path.join(post_dir, POST_MANIFEST)
    try:
        with _open_regular(path) as f:
            raw = f.read(POST_MANIFEST_MAX_BYTES + 1)
    except (FileNotFoundError, NotADirectoryError):
        raise Refused(f'{post_dir}: no {POST_MANIFEST} — not a complete post') from None
    try:
        manifest = json.loads(raw) if len(raw) <= POST_MANIFEST_MAX_BYTES else None
    except ValueError:
        manifest = None
    names = _names(db)
    files = _files(manifest, names)
    if files is None:
        raise Refused(f'{path}: not a post manifest of {names[0]}')
    listing = sorted(os.listdir(post_dir))
    if listing != sorted([*files, POST_MANIFEST]):
        raise Refused(f'{post_dir}: holds {listing}, its {POST_MANIFEST} names {sorted(files)}')
    for name, want in sorted(files.items()):
        size, digest = _digest(os.path.join(post_dir, name))
        if (size, digest) != (want['size'], want['sha256']):
            raise Refused(f'{post_dir}/{name}: {size} bytes sha256 {digest}, {POST_MANIFEST} says '
                          f'{want["size"]} bytes sha256 {want["sha256"]}')
    return manifest


def post(db, out_dir):
    """Capture db, -wal and -shm (those present) into out_dir once. Returns its manifest.

    An out_dir that is already a complete post of db is returned as it is (a retry after
    a crash past the rename); one that is not is refused, never rewritten.
    """
    if os.path.lexists(out_dir):
        return read_post(out_dir, db)
    if not os.path.isfile(db):
        raise Refused(f'no database at {db}')
    partial = out_dir + '.partial'
    # Left by a crash before the rename: never a post, whatever it holds.
    _remove(partial)
    os.mkdir(partial, 0o700)
    files = {}
    for suffix, name in zip(SUFFIXES, _names(db)):
        try:
            size, digest = _copy(db + suffix, os.path.join(partial, name))
        except FileNotFoundError:
            if not suffix:
                raise Refused(f'no database at {db}') from None
            continue
        files[name] = {'size': size, 'sha256': digest}
    manifest = {'files': files}
    fd = os.open(os.path.join(partial, POST_MANIFEST), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(tm.canonical_bytes(manifest))
        f.flush()
        os.fsync(f.fileno())
    fsync_dir(partial)
    os.rename(partial, out_dir)
    fsync_dir(os.path.dirname(os.path.abspath(out_dir)))
    return manifest


def _expected_pre(pre):
    try:
        with _open_regular(pre + '.sha256') as f:
            raw = f.read(129).decode('ascii', 'replace')
    except FileNotFoundError:
        raise Refused(f'no checksum for {pre}') from None
    m = SNAPSHOT_SUM.fullmatch(raw)
    if not m:
        raise Refused(f'{pre}.sha256: not a single sha256 line')
    return m.group(1)


def _digest_or_none(path):
    try:
        return _digest(path)[1]
    except FileNotFoundError:
        return None


def restore(pre, db, post_dir):
    """Make db exactly pre, with no -wal/-shm. Returns 'restored' or 'already' (nothing to do).

    Runs only after a complete post of db (what the rollback would otherwise destroy) and
    only from a pre that matches its checksum; every check comes before the first change.
    """
    read_post(post_dir, db)
    want = _expected_pre(pre)
    try:
        got = _digest(pre)[1]
    except FileNotFoundError:
        raise Refused(f'no snapshot at {pre}') from None
    if got != want:
        raise Refused(f'checksum mismatch for {pre}: want {want}, got {got}')
    side = [db + s for s in SUFFIXES[1:] if os.path.lexists(db + s)]
    if not side and _digest_or_none(db) == want:
        return 'already'
    directory = os.path.dirname(os.path.abspath(db))
    # The WAL/SHM go BEFORE the database is replaced. They belong to the post-state db (and
    # are kept in the complete post): left next to the restored pre, SQLite would replay
    # that WAL onto pre on the next open. Crashing after this point leaves the post-state
    # db without its WAL — nobody runs on it (writers are stopped) and the retry restores.
    for path in side:
        os.unlink(path)
    fsync_dir(directory)
    tmp = db + '.restore-partial'
    _remove(tmp)
    try:
        mode = stat.S_IMODE(os.stat(db).st_mode)
    except FileNotFoundError:
        mode = 0o600
    _, copied = _copy(pre, tmp, mode)
    if copied != want:
        os.unlink(tmp)
        raise Refused(f'{pre} changed while it was copied: {copied}, want {want}')
    os.replace(tmp, db)
    fsync_dir(directory)
    return 'restored'


def _run(argv):
    if argv[0] == 'post':
        post(argv[1], argv[2])
        return f'POST {argv[2]}'
    return f'{restore(argv[1], argv[2], argv[3]).upper()} {argv[2]}'


def main(argv):
    if (argv[:1], len(argv)) not in ((['post'], 3), (['restore'], 4)):
        print('usage: dbsnap.py post <db> <out-dir> | restore <pre.db> <db> <post-dir>', file=sys.stderr)
        return EX_USAGE
    try:
        print(_run(argv))
        return 0
    except Refused as e:
        print(f'REFUSED: {e}', file=sys.stderr)
        return EX_REFUSED
    except OSError as e:
        print(f'TRANSIENT: {e}', file=sys.stderr)
        return EX_TEMPFAIL
    except Exception:
        traceback.print_exc()
        return EX_SOFTWARE


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
