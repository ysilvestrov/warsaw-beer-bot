"""Checked unpacking of runtime.tar.gz, shared by CI (verify_payload) and the host (publish).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §4.
Moved out of verify_payload.py in Ядро-2а (plan .../plans/2026-10/
2026-10-09-wbb-artifact-deployment-core-2a.md, Task 2) so the host does not grow a
second copy of the same rules.
"""
import hashlib
import os
import re
import stat
import sys
import tarfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tree_manifest as tm  # noqa: E402
from package_runtime import ARCHIVE, Caps  # noqa: E402

CHECKSUM_LINE = re.compile(r'([0-9a-f]{64})  ' + re.escape(ARCHIVE) + r'\n')
CHECKSUM_MAX_BYTES = 256


class Refused(Exception):
    pass


def check_checksum(archive, checksum_file):
    with open(checksum_file, 'rb') as f:
        raw = f.read(CHECKSUM_MAX_BYTES + 1)
    m = CHECKSUM_LINE.fullmatch(raw.decode('ascii', 'replace')) if len(raw) <= CHECKSUM_MAX_BYTES else None
    if not m:
        raise Refused(f'{checksum_file}: not a single "<sha256>  {ARCHIVE}" line')
    h = hashlib.sha256()
    with open(archive, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    if h.hexdigest() != m.group(1):
        raise Refused(f'{ARCHIVE} sha256 {h.hexdigest()} != {m.group(1)}')
    return m.group(1)


def extract(archive, dest, caps=Caps()):
    """Unpack into dest (must not exist) after checking every member; never over an existing tree."""
    if os.path.getsize(archive) > caps.archive_bytes:
        raise Refused(f'{ARCHIVE} is over the cap of {caps.archive_bytes} bytes')
    os.makedirs(dest)
    with tarfile.open(archive, 'r:gz') as tar:
        members = []
        names = set()
        total = 0
        for m in tar:
            why = tm.path_problem(m.name)
            if why:
                raise Refused(f'archive member {m.name!r}: {why}')
            if m.name in names:
                raise Refused(f'archive member {m.name}: duplicate')
            if not (m.isreg() or m.isdir() or m.issym()):
                raise Refused(f'archive member {m.name}: type {m.type!r} is not file, directory or symlink')
            if m.mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
                raise Refused(f'archive member {m.name}: special mode bits')
            names.add(m.name)
            members.append(m)
            total += m.size if m.isreg() else 0
            if len(members) > caps.entries + 1:
                raise Refused(f'archive has more than {caps.entries} entries')
            if total > caps.file_bytes:
                raise Refused(f'archive expands past {caps.file_bytes} bytes')
        try:
            tar.extractall(dest, members=members, filter='data')
        except tarfile.FilterError as e:
            raise Refused(f'archive member refused by the data filter: {e}')
