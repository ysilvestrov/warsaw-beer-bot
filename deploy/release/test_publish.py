import hashlib
import json
import os
import stat
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import package_runtime as pr  # noqa: E402
import publish as pub  # noqa: E402
import tree_manifest as tm  # noqa: E402
from github_trust import Trusted  # noqa: E402
from release_testkit import SHA, make_inputs, packed, release, write  # noqa: E402
from safe_tar import Refused  # noqa: E402
from zip_admission import sha256_file  # noqa: E402

NOW = '2026-10-09T08:00:00Z'
OWNER = (os.geteuid(), os.getegid())


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
        self.roots = pub.Roots(*(os.path.join(self.base, d) for d in ('releases', 'receipts', 'scratch')), OWNER)
        for d in (self.roots.releases, self.roots.receipts, self.roots.scratch):
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

    def test_loosened_tree_left_without_receipt_is_refused(self):
        pub.publish(self.trusted, self.zip, self.roots, lambda: NOW)
        os.remove(self.receipt_path())
        os.chmod(os.path.join(self.roots.releases, SHA, 'dist/index.js'), 0o666)
        self.assertEqual(self.refused(), f'{os.path.join(self.roots.releases, SHA)} exists without a receipt and '
                                         'does not match this artifact; operator recovery required')

    def fsync_log(self, action):
        seen = []
        real = os.fsync

        def spy(fd):
            seen.append(os.readlink(f'/proc/self/fd/{fd}'))
            return real(fd)
        with mock.patch('os.fsync', spy):
            action()
        return seen

    def durable_before_receipt(self, seen, tree_prefix):
        """Tree entries fsynced (as relative paths) and the index of the receipt's own fsync."""
        receipt_at = next(i for i, p in enumerate(seen) if os.path.basename(p).startswith('.receipt-'))
        synced = {os.path.relpath(p, tree_prefix) for p in seen[:receipt_at]
                  if p == tree_prefix or p.startswith(tree_prefix + '/')}
        return synced, receipt_at

    def tree_entries(self):
        files = {e['path'] for e in self.manifest['entries'] if e['type'] != 'symlink'}
        return files | {'.', tm.MANIFEST_NAME}

    def test_whole_tree_is_durable_before_the_receipt(self):
        # #815 review P2: every file, directory and the root, then releases/, then the receipt.
        seen = self.fsync_log(lambda: pub.publish(self.trusted, self.zip, self.roots, lambda: NOW))
        scratch_tree = next(p for p in seen if p.endswith('/tree'))
        synced, receipt_at = self.durable_before_receipt(seen, scratch_tree)
        self.assertEqual(synced, self.tree_entries())
        self.assertEqual(seen.index(self.roots.releases) < receipt_at, True)
        self.assertEqual(seen[receipt_at + 1:], [self.roots.receipts])

    def test_reconciled_tree_is_made_durable_before_its_receipt(self):
        pub.publish(self.trusted, self.zip, self.roots, lambda: NOW)
        os.remove(self.receipt_path())
        seen = self.fsync_log(lambda: pub.publish(self.trusted, self.zip, self.roots, lambda: NOW))
        synced, _ = self.durable_before_receipt(seen, os.path.join(self.roots.releases, SHA))
        self.assertEqual(synced, self.tree_entries())

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

    def verify_refused(self, roots=None):
        with self.assertRaises(Refused) as cm:
            pub.verify_release(SHA, roots or self.roots)
        return str(cm.exception)

    def test_loosened_permissions(self):
        # #815 review P1: modes are checked as they are, not normalised to 0644/0755.
        os.chmod(os.path.join(self.release_dir, 'dist'), 0o777)
        os.chmod(os.path.join(self.release_dir, 'dist/index.js'), 0o666)
        os.chmod(os.path.join(self.release_dir, 'node_modules/pkg/cli.js'), 0o777)
        head, *problems = self.verify_refused().splitlines()
        self.assertEqual((head, sorted(problems)), (f'{SHA}: release tree changed:', [
            'dist/index.js: differs from manifest (mode)', 'dist: differs from manifest (mode)',
            'node_modules/pkg/cli.js: differs from manifest (mode)']))

    def test_writable_root(self):
        os.chmod(self.release_dir, 0o777)
        self.assertEqual(self.verify_refused(), f'{SHA}: release tree changed:\n.: expected mode 0755, got 0777')

    def test_writable_manifest(self):
        os.chmod(os.path.join(self.release_dir, tm.MANIFEST_NAME), 0o666)
        self.assertEqual(self.verify_refused(),
                         f'{SHA}: release tree changed:\ntree-manifest.json: expected mode 0644, got 0666')

    def test_tree_owned_by_someone_else(self):
        other = pub.Roots(self.roots.releases, self.roots.receipts, self.roots.scratch, (OWNER[0] + 1, OWNER[1]))
        message = self.verify_refused(other)
        self.assertEqual(message.splitlines()[:3], [
            f'{SHA}: release tree changed:',
            f'.: owned by {OWNER[0]}:{OWNER[1]}, expected {OWNER[0] + 1}:{OWNER[1]}',
            f'tree-manifest.json: owned by {OWNER[0]}:{OWNER[1]}, expected {OWNER[0] + 1}:{OWNER[1]}'])

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
