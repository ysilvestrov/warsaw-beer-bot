import io
import os
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import package_runtime as pr  # noqa: E402
import verify_payload as vp  # noqa: E402
from release_testkit import SHA, packed, write  # noqa: E402


class Tmp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = self._tmp.name
        self.work = os.path.join(self.base, 'work')
        os.makedirs(self.work)

    def tearDown(self):
        self._tmp.cleanup()

    def prepare(self, archive, sha=SHA, abi='137', glibc='2.39'):
        return vp.prepare(archive, archive + '.sha256', sha, self.work, abi, glibc)


class Prepare(Tmp):
    def test_good_archive_unpacks_and_matches(self):
        archive, _ = packed(os.path.join(self.base, 'src'))
        payload = self.prepare(archive)
        self.assertEqual(payload, os.path.join(self.work, 'payload'))
        self.assertEqual(os.readlink(os.path.join(payload, 'node_modules/.bin/pkg')), '../pkg/cli.js')
        self.assertEqual(os.stat(os.path.join(payload, 'node_modules/pkg/cli.js')).st_mode & 0o777, 0o755)

    def test_checksum_mismatch(self):
        archive, _ = packed(os.path.join(self.base, 'src'))
        with open(archive + '.sha256', 'w', encoding='ascii') as f:
            f.write('0' * 64 + '  runtime.tar.gz\n')
        with self.assertRaisesRegex(vp.Refused, r'^runtime.tar.gz sha256 [0-9a-f]{64} != 0{64}$'):
            self.prepare(archive)
        self.assertEqual(os.listdir(self.work), [])

    def test_malformed_checksum_file(self):
        archive, _ = packed(os.path.join(self.base, 'src'))
        with open(archive + '.sha256', 'w', encoding='ascii') as f:
            f.write('0' * 64 + '  other.tar.gz\n')
        with self.assertRaisesRegex(vp.Refused, 'not a single "<sha256>  runtime.tar.gz" line'):
            self.prepare(archive)

    def checksum_refused(self, text):
        archive, _ = packed(os.path.join(self.base, 'src'))
        digest = pr._sha256(archive)
        with open(archive + '.sha256', 'w', encoding='ascii') as f:
            f.write(text.format(digest))
        with self.assertRaisesRegex(vp.Refused, 'not a single "<sha256>  runtime.tar.gz" line'):
            self.prepare(archive)

    def test_checksum_with_trailing_blank_line(self):
        self.checksum_refused('{}  runtime.tar.gz\n\n')

    def test_checksum_without_newline(self):
        self.checksum_refused('{}  runtime.tar.gz')

    def test_checksum_file_over_256_bytes(self):
        self.checksum_refused('{}  runtime.tar.gz\n' + ' ' * 200)

    def test_file_changed_after_the_manifest(self):
        archive, _ = packed(os.path.join(self.base, 'src'),
                            mutate=lambda p: write(p, 'dist/index.js', b'console.log(2);\n'))
        with self.assertRaisesRegex(vp.Refused, '^tree does not match tree-manifest.json:\ndist/index.js: differs from manifest \\(sha256\\)$'):
            self.prepare(archive)

    def test_release_for_another_sha(self):
        archive, _ = packed(os.path.join(self.base, 'src'))
        with self.assertRaisesRegex(vp.Refused, f"^release.json: sourceSha '{SHA}' is not {'b' * 40}$"):
            self.prepare(archive, sha='b' * 40)

    def test_other_node_abi(self):
        archive, _ = packed(os.path.join(self.base, 'src'))
        with self.assertRaisesRegex(vp.Refused, "node 24/ABI '137', this machine runs 24/ABI 141"):
            self.prepare(archive, abi='141')

    def test_glibc_newer_than_the_machine(self):
        archive, _ = packed(os.path.join(self.base, 'src'))
        with self.assertRaisesRegex(vp.Refused, "glibc '2.39' is newer than this machine's 2.35"):
            self.prepare(archive, glibc='2.35')

    def test_glibc_equal_and_older_pass(self):
        archive, _ = packed(os.path.join(self.base, 'src'))
        self.assertEqual(vp.check_release(self.prepare(archive, glibc='2.39'), SHA, '137', '2.40')['sourceSha'], SHA)


def raw_tar(path, members):
    """A tar.gz with hand-made members: (TarInfo, bytes|None)."""
    with tarfile.open(path, 'w:gz', format=tarfile.PAX_FORMAT) as tar:
        for info, data in members:
            tar.addfile(info, io.BytesIO(data) if data is not None else None)


def info(name, kind=tarfile.REGTYPE, size=0, mode=0o644, link=''):
    i = tarfile.TarInfo(name)
    i.type, i.size, i.mode, i.linkname = kind, size, mode, link
    return i


class Extract(Tmp):
    def refused(self, members, caps=pr.Caps()):
        archive = os.path.join(self.base, 'a.tar.gz')
        raw_tar(archive, members)
        with self.assertRaises(vp.Refused) as cm:
            vp.extract(archive, os.path.join(self.work, 'p'), caps)
        return str(cm.exception)

    def test_traversal(self):
        self.assertEqual(self.refused([(info('../evil', size=1), b'x')]),
                         "archive member '../evil': empty, \".\" or \"..\" component")

    def test_absolute(self):
        self.assertEqual(self.refused([(info('/etc/x', size=1), b'x')]), "archive member '/etc/x': absolute path")

    def test_hardlink(self):
        self.assertEqual(self.refused([(info('a', size=1), b'x'), (info('b', tarfile.LNKTYPE, link='a'), None)]),
                         "archive member b: type b'1' is not file, directory or symlink")

    def test_device(self):
        self.assertEqual(self.refused([(info('d', tarfile.CHRTYPE), None)]),
                         "archive member d: type b'3' is not file, directory or symlink")

    def test_duplicate(self):
        self.assertEqual(self.refused([(info('a', size=1), b'x'), (info('a', size=1), b'y')]), 'archive member a: duplicate')

    def test_setuid(self):
        self.assertEqual(self.refused([(info('a', size=1, mode=0o4755), b'x')]), 'archive member a: special mode bits')

    def test_entry_cap(self):
        # The cap counts payload entries; tree-manifest.json is the one extra member allowed.
        members = [(info(n, size=1), b'x') for n in ('a', 'b', 'c')]
        self.assertEqual(self.refused(members, pr.Caps(entries=1)), 'archive has more than 1 entries')

    def test_byte_cap(self):
        members = [(info('a', size=3), b'xyz'), (info('b', size=3), b'xyz')]
        self.assertEqual(self.refused(members, pr.Caps(file_bytes=5)), 'archive expands past 5 bytes')

    def test_byte_cap_boundary_passes(self):
        archive = os.path.join(self.base, 'a.tar.gz')
        raw_tar(archive, [(info('a', size=3), b'xyz'), (info('b', size=3), b'xyz')])
        vp.extract(archive, os.path.join(self.work, 'p'), pr.Caps(file_bytes=6, entries=1))
        self.assertEqual(sorted(os.listdir(os.path.join(self.work, 'p'))), ['a', 'b'])

    def test_never_over_an_existing_tree(self):
        archive = os.path.join(self.base, 'a.tar.gz')
        raw_tar(archive, [(info('a', size=1), b'x')])
        os.makedirs(os.path.join(self.work, 'p'))
        with self.assertRaises(FileExistsError):
            vp.extract(archive, os.path.join(self.work, 'p'))

    def test_link_out_of_the_tree_is_left_to_the_data_filter(self):
        archive = os.path.join(self.base, 'a.tar.gz')
        raw_tar(archive, [(info('l', tarfile.SYMTYPE, link='../../etc/passwd'), None)])
        with self.assertRaisesRegex(vp.Refused, "^archive member refused by the data filter: 'l' would link to .* outside the destination$"):
            vp.extract(archive, os.path.join(self.work, 'p'))


if __name__ == '__main__':
    unittest.main()
