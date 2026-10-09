import hashlib
import os
import stat
import struct
import sys
import tempfile
import unittest
import warnings
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zip_admission as za  # noqa: E402
from safe_tar import Refused  # noqa: E402

TAR = b'pretend this is a tarball'
TAR_SHA = hashlib.sha256(TAR).hexdigest()
CHECK = f'{TAR_SHA}  runtime.tar.gz\n'.encode()


def info(name, attr=stat.S_IFREG | 0o644, method=zipfile.ZIP_STORED):
    """An entry shaped like the real artifact's (gate G1): STORED, unix mode 0o100644."""
    i = zipfile.ZipInfo(name, date_time=(2026, 10, 9, 0, 0, 0))
    i.compress_type = method
    i.external_attr = attr << 16
    return i


class Tmp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = self._tmp.name
        self.out = os.path.join(self.base, 'out')

    def tearDown(self):
        self._tmp.cleanup()

    def make(self, entries):
        path = os.path.join(self.base, 'a.zip')
        with zipfile.ZipFile(path, 'w') as z:
            for zi, data in entries:
                z.writestr(zi, data)
        return path

    def good(self):
        return self.make([(info('runtime.tar.gz'), TAR), (info('runtime.tar.gz.sha256'), CHECK)])

    def refused(self, path, digest=None, caps=za.ZipCaps()):
        with self.assertRaises(Refused) as cm:
            za.admit_zip(path, digest or za.sha256_file(path), self.out, caps)
        return str(cm.exception)


class Admit(Tmp):
    def test_good_zip(self):
        path = self.good()
        self.assertEqual(za.admit_zip(path, za.sha256_file(path), self.out),
                         (os.path.join(self.out, 'runtime.tar.gz'), TAR_SHA))
        self.assertEqual(sorted(os.listdir(self.out)), ['runtime.tar.gz', 'runtime.tar.gz.sha256'])
        self.assertEqual(stat.S_IMODE(os.stat(self.out).st_mode), 0o700)

    def test_deflated_entry_is_refused(self):
        path = self.make([(info('runtime.tar.gz', method=zipfile.ZIP_DEFLATED), TAR), (info('runtime.tar.gz.sha256'), CHECK)])
        self.assertEqual(self.refused(path), 'ZIP entry runtime.tar.gz uses compression method 8')

    def test_entry_without_a_unix_mode_is_refused(self):
        path = self.make([(info('runtime.tar.gz', attr=0), TAR), (info('runtime.tar.gz.sha256'), CHECK)])
        self.assertEqual(self.refused(path), 'ZIP entry runtime.tar.gz is not a regular file')

    def test_data_descriptor_flag_as_in_the_real_artifact(self):
        path = self.good()
        patch_central(path, 'runtime.tar.gz', 'flags', 0x8)
        patch_central(path, 'runtime.tar.gz.sha256', 'flags', 0x8)
        self.assertEqual(za.admit_zip(path, za.sha256_file(path), self.out)[1], TAR_SHA)

    def test_strong_encryption_flag(self):
        path = self.good()
        patch_central(path, 'runtime.tar.gz', 'flags', 0x40)
        self.assertEqual(self.refused(path), 'ZIP entry runtime.tar.gz is encrypted')

    def test_wrong_digest_unpacks_nothing(self):
        path = self.good()
        self.assertEqual(self.refused(path, '0' * 64),
                         f'artifact ZIP sha256 {za.sha256_file(path)} != trusted digest {"0" * 64}')
        self.assertEqual(os.path.exists(self.out), False)

    def test_zip_size_cap(self):
        path = self.good()
        size = os.path.getsize(path)
        self.assertEqual(self.refused(path, caps=za.ZipCaps(zip_bytes=size - 1)),
                         f'artifact ZIP is {size} bytes, over the cap of {size - 1}')

    def test_third_entry(self):
        path = self.make([(info('runtime.tar.gz'), TAR), (info('runtime.tar.gz.sha256'), CHECK), (info('x'), b'')])
        self.assertEqual(self.refused(path), "artifact ZIP must hold exactly runtime.tar.gz and runtime.tar.gz.sha256, "
                                             "holds ['runtime.tar.gz', 'runtime.tar.gz.sha256', 'x']")

    def test_duplicate_entry(self):
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            path = self.make([(info('runtime.tar.gz'), TAR), (info('runtime.tar.gz'), TAR),
                              (info('runtime.tar.gz.sha256'), CHECK)])
        self.assertEqual(self.refused(path), "artifact ZIP must hold exactly runtime.tar.gz and runtime.tar.gz.sha256, "
                                             "holds ['runtime.tar.gz', 'runtime.tar.gz', 'runtime.tar.gz.sha256']")

    def test_directory_entry(self):
        path = self.make([(info('runtime.tar.gz/'), b''), (info('runtime.tar.gz.sha256'), CHECK)])
        self.assertEqual(self.refused(path), "artifact ZIP must hold exactly runtime.tar.gz and runtime.tar.gz.sha256, "
                                             "holds ['runtime.tar.gz.sha256', 'runtime.tar.gz/']")

    def test_symlink_entry(self):
        path = self.make([(info('runtime.tar.gz', stat.S_IFLNK | 0o777), b'/etc/passwd'),
                          (info('runtime.tar.gz.sha256'), CHECK)])
        self.assertEqual(self.refused(path), 'ZIP entry runtime.tar.gz is not a regular file')

    def test_encrypted_flag(self):
        # zipfile rewrites flag_bits on write, so the bit is set in the central directory afterwards.
        path = self.good()
        patch_central(path, 'runtime.tar.gz', 'flags', 0x1)
        self.assertEqual(self.refused(path), 'ZIP entry runtime.tar.gz is encrypted')

    def test_expanded_cap_boundary(self):
        path = self.good()
        exact = len(TAR) + len(CHECK)
        self.assertEqual(za.admit_zip(path, za.sha256_file(path), self.out, za.ZipCaps(expanded_bytes=exact))[1], TAR_SHA)
        self.assertEqual(self.refused(path, caps=za.ZipCaps(expanded_bytes=exact - 1)),
                         f'artifact ZIP expands past {exact - 1} bytes')

    def test_checksum_file_cap(self):
        path = self.make([(info('runtime.tar.gz'), TAR), (info('runtime.tar.gz.sha256'), CHECK + b' ' * 200)])
        self.assertEqual(self.refused(path), 'runtime.tar.gz.sha256 is over 256 bytes')

    def test_inner_checksum_mismatch(self):
        path = self.make([(info('runtime.tar.gz'), TAR + b'!'), (info('runtime.tar.gz.sha256'), CHECK)])
        bad = hashlib.sha256(TAR + b'!').hexdigest()
        self.assertEqual(self.refused(path), f'runtime.tar.gz sha256 {bad} != {TAR_SHA}')


def patch_central(path, name, field, value):
    """Rewrite one little-endian field of `name`'s central directory header (offsets per APPNOTE 4.3.12)."""
    offsets = {'flags': (8, '<H'), 'crc': (16, '<I'), 'file_size': (24, '<I')}
    with open(path, 'r+b') as f:
        data = bytearray(f.read())
        at = data.find(b'PK\x01\x02')
        while at != -1:
            nlen = struct.unpack_from('<H', data, at + 28)[0]
            if data[at + 46:at + 46 + nlen] == name.encode():
                off, fmt = offsets[field]
                struct.pack_into(fmt, data, at + off, value)
                f.seek(0)
                f.write(data)
                return
            at = data.find(b'PK\x01\x02', at + 4)
    raise AssertionError(f'{name} not found')


class LyingHeaders(Tmp):
    def test_damaged_crc(self):
        path = self.good()
        patch_central(path, 'runtime.tar.gz', 'crc', 0)
        self.assertEqual(self.refused(path), "artifact ZIP is damaged: Bad CRC-32 for file 'runtime.tar.gz'")

    def test_header_claims_more_than_the_stream_holds(self):
        path = self.make([(info('runtime.tar.gz'), TAR), (info('runtime.tar.gz.sha256'), CHECK)])
        patch_central(path, 'runtime.tar.gz', 'file_size', len(TAR) + 5)
        self.assertEqual(self.refused(path), 'ZIP entry runtime.tar.gz is 25 bytes, header says 30')


if __name__ == '__main__':
    unittest.main()
