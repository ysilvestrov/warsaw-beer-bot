import hashlib
import json
import os
import stat
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import package_runtime as pr  # noqa: E402
import publish as pub  # noqa: E402
import tree_manifest as tm  # noqa: E402
from github_trust import Trusted  # noqa: E402
from release_testkit import SHA, make_inputs, packed, release, write  # noqa: E402
from safe_tar import Refused  # noqa: E402
from zip_admission import sha256_file  # noqa: E402

NOW = '2026-10-09T08:00:00Z'


def zip_up(archive, dest):
    with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(archive, 'runtime.tar.gz')
        z.write(archive + '.sha256', 'runtime.tar.gz.sha256')
    return dest


def other_artifact(base):
    """The same SHA and run, different bytes: one extra file in dist."""
    repo, dist, modules = make_inputs(base)
    write(dist, 'extra.js', b'1;\n')
    manifest = pr.assemble(repo, dist, modules, os.path.join(base, 'payload'), release(), ['scripts/op.ts'])
    out = os.path.join(base, 'out')
    os.makedirs(out)
    pr.write_archive(os.path.join(base, 'payload'), manifest, out)
    return zip_up(os.path.join(out, 'runtime.tar.gz'), os.path.join(base, 'artifact.zip'))


def trusted_for(zip_path, run_id=7, attempt=2, artifact_id=99):
    return Trusted('o/r', SHA, '.github/workflows/ci.yml', run_id, attempt, artifact_id,
                   f'wbb-release-{SHA}-{run_id}-{attempt}', sha256_file(zip_path))


class Tmp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = self._tmp.name
        self.roots = pub.Roots(*(os.path.join(self.base, d) for d in ('releases', 'receipts', 'scratch')))
        for d in self.roots.__dict__.values():
            os.makedirs(d)
        self.archive, self.manifest = packed(os.path.join(self.base, 'src'))
        self.zip = zip_up(self.archive, os.path.join(self.base, 'artifact.zip'))
        self.trusted = trusted_for(self.zip)

    def tearDown(self):
        self._tmp.cleanup()

    def receipt_path(self):
        return os.path.join(self.roots.receipts, f'{SHA}.json')

    def receipt_bytes(self):
        with open(self.receipt_path(), 'rb') as f:
            return f.read()

    def refused(self, trusted=None, zip_path=None):
        with self.assertRaises(Refused) as cm:
            pub.publish(trusted or self.trusted, zip_path or self.zip, self.roots, lambda: NOW)
        return str(cm.exception)

    def assert_nothing_published(self):
        self.assertEqual((os.listdir(self.roots.releases), os.listdir(self.roots.receipts),
                          os.listdir(self.roots.scratch)), ([], [], []))


class Publish(Tmp):
    def test_accepts_and_writes_an_exact_receipt(self):
        self.assertEqual(pub.publish(self.trusted, self.zip, self.roots, lambda: NOW), 'accepted')
        self.assertEqual(json.loads(self.receipt_bytes()), {
            'formatVersion': 1, 'repo': 'o/r', 'sourceSha': SHA, 'runId': 7, 'runAttempt': 2, 'artifactId': 99,
            'zipSha256': sha256_file(self.zip), 'tarSha256': sha256_file(self.archive),
            'treeSha256': tm.tree_digest(self.manifest), 'acceptedAt': NOW})
        self.assertEqual(stat.S_IMODE(os.stat(self.receipt_path()).st_mode), 0o600)
        self.assertEqual(os.listdir(self.roots.scratch), [])
        release = os.path.join(self.roots.releases, SHA)
        self.assertEqual(stat.S_IMODE(os.stat(release).st_mode), 0o755)
        self.assertEqual(os.readlink(os.path.join(release, 'node_modules/.bin/pkg')), '../pkg/cli.js')
        self.assertEqual(pub.verify_release(SHA, self.roots)['treeSha256'], tm.tree_digest(self.manifest))

    def test_symlinked_operator_archive(self):
        link = os.path.join(self.base, 'link.zip')
        os.symlink(self.zip, link)
        self.assertEqual(self.refused(zip_path=link), f'{link}: is a symlink')
        self.assert_nothing_published()

    def test_operator_archive_is_a_directory(self):
        self.assertEqual(self.refused(zip_path=self.base), f'{self.base}: not a regular file')

    def test_archive_differing_from_the_trusted_digest(self):
        with open(self.zip, 'ab') as f:
            f.write(b'\0')
        message = self.refused()
        self.assertEqual(message, f'artifact ZIP sha256 {sha256_file(self.zip)} != trusted digest {self.trusted.zip_sha256}')
        self.assert_nothing_published()

    def test_release_json_for_another_run(self):
        other = trusted_for(self.zip, run_id=8)
        self.assertEqual(self.refused(trusted=other), 'release.json does not match the trusted run: runId=7')
        self.assert_nothing_published()

    def test_tree_differing_from_its_manifest(self):
        base = os.path.join(self.base, 'bad')
        archive, _ = packed(base, mutate=lambda p: write(p, 'dist/index.js', b'console.log(2);\n'))
        bad_zip = zip_up(archive, os.path.join(base, 'a.zip'))
        self.assertEqual(self.refused(trusted=trusted_for(bad_zip), zip_path=bad_zip),
                         'tree does not match tree-manifest.json:\ndist/index.js: differs from manifest (sha256)')
        self.assert_nothing_published()

    def test_same_artifact_again_is_a_no_op(self):
        pub.publish(self.trusted, self.zip, self.roots, lambda: NOW)
        before = (self.receipt_bytes(), os.stat(self.receipt_path()).st_mtime_ns)
        self.assertEqual(pub.publish(self.trusted, self.zip, self.roots, lambda: 'later'), 'already-accepted')
        self.assertEqual((self.receipt_bytes(), os.stat(self.receipt_path()).st_mtime_ns), before)

    def test_same_artifact_again_over_a_tampered_tree(self):
        pub.publish(self.trusted, self.zip, self.roots, lambda: NOW)
        write(os.path.join(self.roots.releases, SHA), 'dist/index.js', b'console.log(4);\n')
        self.assertEqual(self.refused(), f'{SHA}: release tree changed:\ndist/index.js: differs from manifest (sha256)')

    def test_new_attempt_with_the_same_tar_is_a_no_op(self):
        pub.publish(self.trusted, self.zip, self.roots, lambda: NOW)
        rezip = os.path.join(self.base, 'rezip.zip')
        with zipfile.ZipFile(rezip, 'w', zipfile.ZIP_STORED) as z:  # a different wrapper around the same files
            z.write(self.archive, 'runtime.tar.gz')
            z.write(self.archive + '.sha256', 'runtime.tar.gz.sha256')
        # release.json still names attempt 2, so the identity check holds for this trusted record.
        self.assertEqual(pub.publish(trusted_for(rezip, artifact_id=100), rezip, self.roots, lambda: NOW), 'already-accepted')

    def test_conflicting_artifact_for_an_accepted_sha(self):
        pub.publish(self.trusted, self.zip, self.roots, lambda: NOW)
        before = self.receipt_bytes()
        other_zip = other_artifact(os.path.join(self.base, 'other'))
        other_tar = os.path.join(self.base, 'other', 'out', 'runtime.tar.gz')
        self.assertEqual(self.refused(trusted=trusted_for(other_zip), zip_path=other_zip),
                         f'{SHA} was already accepted with tar {sha256_file(self.archive)} / tree '
                         f'{tm.tree_digest(self.manifest)}; this artifact has tar {sha256_file(other_tar)} / tree '
                         f'{self.other_tree_digest}. Explicit operator recovery or a new commit is required.')
        self.assertEqual(self.receipt_bytes(), before)

    @property
    def other_tree_digest(self):
        with open(os.path.join(self.base, 'other', 'payload', tm.MANIFEST_NAME), 'rb') as f:
            return hashlib.sha256(f.read()).hexdigest()

    def test_tree_left_without_receipt_is_reverified_then_receipted(self):
        pub.publish(self.trusted, self.zip, self.roots, lambda: NOW)
        os.remove(self.receipt_path())  # a crash between the rename and the receipt
        self.assertEqual(pub.publish(self.trusted, self.zip, self.roots, lambda: 'again'), 'accepted')
        self.assertEqual(json.loads(self.receipt_bytes())['acceptedAt'], 'again')

    def test_changed_tree_left_without_receipt_is_refused(self):
        pub.publish(self.trusted, self.zip, self.roots, lambda: NOW)
        os.remove(self.receipt_path())
        write(os.path.join(self.roots.releases, SHA), 'dist/index.js', b'console.log(9);\n')
        self.assertEqual(self.refused(), f'{os.path.join(self.roots.releases, SHA)} exists without a receipt and '
                                         'does not match this artifact; operator recovery required')
        self.assertEqual(os.listdir(self.roots.receipts), [])

    def test_malformed_existing_receipt_is_a_refusal(self):
        with open(self.receipt_path(), 'w') as f:
            f.write('{}')
        self.assertEqual(self.refused(), f'{self.receipt_path()}: not a version-1 receipt')

    def test_short_sha(self):
        with self.assertRaisesRegex(Refused, "not a full lowercase SHA: 'abc'"):
            pub.verify_release('abc', self.roots)


class VerifyRelease(Tmp):
    def setUp(self):
        super().setUp()
        pub.publish(self.trusted, self.zip, self.roots, lambda: NOW)
        self.release_dir = os.path.join(self.roots.releases, SHA)

    def test_changed_file(self):
        write(self.release_dir, 'dist/index.js', b'console.log(3);\n')
        with self.assertRaises(Refused) as cm:
            pub.verify_release(SHA, self.roots)
        self.assertEqual(str(cm.exception), f'{SHA}: release tree changed:\ndist/index.js: differs from manifest (sha256)')

    def test_changed_receipt_digest(self):
        receipt = json.loads(self.receipt_bytes())
        receipt['treeSha256'] = '0' * 64
        with open(self.receipt_path(), 'wb') as f:
            f.write(tm.canonical_bytes(receipt))
        with self.assertRaises(Refused) as cm:
            pub.verify_release(SHA, self.roots)
        self.assertEqual(str(cm.exception), f'{SHA}: tree digest {tm.tree_digest(self.manifest)} != receipt {"0" * 64}')

    def test_no_receipt(self):
        os.remove(self.receipt_path())
        with self.assertRaisesRegex(Refused, f'^{SHA}: no receipt — not an accepted release$'):
            pub.verify_release(SHA, self.roots)

    def test_manifest_replaced_consistently_with_the_tree(self):
        # An attacker who rewrites both a file and the manifest still fails on the receipt digest.
        write(self.release_dir, 'dist/index.js', b'console.log(3);\n')
        os.remove(os.path.join(self.release_dir, tm.MANIFEST_NAME))
        data = tm.canonical_bytes(tm.build_manifest(self.release_dir))
        with open(os.path.join(self.release_dir, tm.MANIFEST_NAME), 'wb') as f:
            f.write(data)
        with self.assertRaises(Refused) as cm:
            pub.verify_release(SHA, self.roots)
        self.assertEqual(str(cm.exception),
                         f'{SHA}: tree digest {hashlib.sha256(data).hexdigest()} != receipt {tm.tree_digest(self.manifest)}')


if __name__ == '__main__':
    unittest.main()
