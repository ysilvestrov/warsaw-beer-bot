"""GitHub artifact ZIP -> checked runtime.tar.gz (host side, before anything is unpacked).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §4 TRUST-001.
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2a.md, Task 2.

The ZIP is the outer wrapper GitHub builds around the two files CI uploaded. Its
SHA256 must equal the digest the REST API reports for the trusted artifact; it must
hold exactly runtime.tar.gz and runtime.tar.gz.sha256 as plain files; every entry is
read through a counter (zipfile checks the CRC), so neither a header that lies about
sizes nor a damaged stream gets past this step. The inner checksum then anchors the
tar the same way it does in CI.
"""
import hashlib
import os
import stat
import sys
import zipfile
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from package_runtime import ARCHIVE  # noqa: E402
from safe_tar import CHECKSUM_MAX_BYTES, Refused, check_checksum  # noqa: E402

CHECKSUM_NAME = ARCHIVE + '.sha256'
ALLOWED_METHODS = (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)


@dataclass(frozen=True)
class ZipCaps:
    zip_bytes: int = 257 * 1024 * 1024
    expanded_bytes: int = 256 * 1024 * 1024 + 1024
    checksum_bytes: int = CHECKSUM_MAX_BYTES


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _entry_problem(info):
    if info.is_dir():
        return 'is a directory'
    if info.flag_bits & 0x1:
        return 'is encrypted'
    if info.compress_type not in ALLOWED_METHODS:
        return f'uses compression method {info.compress_type}'
    kind = stat.S_IFMT(info.external_attr >> 16)
    if kind not in (0, stat.S_IFREG):
        return 'is not a regular file'
    return None


def _copy_entry(z, info, dest, limit):
    """Stream one entry into dest (created exclusively); the bytes read must equal the header size."""
    written = 0
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as out, z.open(info) as src:
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            written += len(chunk)
            if written > info.file_size or written > limit:
                raise Refused(f'ZIP entry {info.filename} expands past its declared size')
            out.write(chunk)
    if written != info.file_size:
        raise Refused(f'ZIP entry {info.filename} is {written} bytes, header says {info.file_size}')


def admit_zip(zip_path, zip_sha256, out_dir, caps=ZipCaps()):
    """Check the artifact ZIP and unpack its two files into out_dir (new, empty).

    Returns (path of runtime.tar.gz, its sha256). Nothing is unpacked unless the
    ZIP's own digest matches the trusted one.
    """
    size = os.path.getsize(zip_path)
    if size > caps.zip_bytes:
        raise Refused(f'artifact ZIP is {size} bytes, over the cap of {caps.zip_bytes}')
    actual = sha256_file(zip_path)
    if actual != zip_sha256:
        raise Refused(f'artifact ZIP sha256 {actual} != trusted digest {zip_sha256}')
    try:
        with zipfile.ZipFile(zip_path) as z:
            infos = z.infolist()
            names = [i.filename for i in infos]
            if sorted(names) != sorted([ARCHIVE, CHECKSUM_NAME]):
                raise Refused(f'artifact ZIP must hold exactly {ARCHIVE} and {CHECKSUM_NAME}, holds {sorted(names)}')
            for info in infos:
                why = _entry_problem(info)
                if why:
                    raise Refused(f'ZIP entry {info.filename} {why}')
            if sum(i.file_size for i in infos) > caps.expanded_bytes:
                raise Refused(f'artifact ZIP expands past {caps.expanded_bytes} bytes')
            by_name = {i.filename: i for i in infos}
            if by_name[CHECKSUM_NAME].file_size > caps.checksum_bytes:
                raise Refused(f'{CHECKSUM_NAME} is over {caps.checksum_bytes} bytes')
            os.makedirs(out_dir, mode=0o700)
            for name in (CHECKSUM_NAME, ARCHIVE):
                _copy_entry(z, by_name[name], os.path.join(out_dir, name), caps.expanded_bytes)
    except zipfile.BadZipFile as e:
        raise Refused(f'artifact ZIP is damaged: {e}') from None
    tar = os.path.join(out_dir, ARCHIVE)
    return tar, check_checksum(tar, os.path.join(out_dir, CHECKSUM_NAME))
