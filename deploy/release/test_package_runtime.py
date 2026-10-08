import json
import os
import sys
import tarfile
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import package_runtime as pr  # noqa: E402
import tree_manifest as tm  # noqa: E402
from release_testkit import SHA, make_inputs, packed, read_json, release, write  # noqa: E402

TSC = os.path.join(HERE, '..', '..', 'node_modules', '.bin', 'tsc')
ALLOWLIST_SCRIPTS = {
    'alias-key': 'tsx scripts/brewery-alias-key.ts',
    'rearm-aliased-orphans': 'tsx scripts/rearm-aliased-orphans.ts',
    'rearm-matcher-bug-orphans': 'tsx scripts/rearm-matcher-bug-orphans.ts',
    'adjudicate': 'tsx scripts/adjudicate-runner.ts',
    'close-orphan-issue': 'tsx scripts/close-orphan-issue.ts',
    'pin-match': 'tsx scripts/pin-match.ts',
    'repair-legacy-card': 'tsx scripts/repair-legacy-card.ts',
    'dispose-legacy-orphan': 'tsx scripts/dispose-legacy-orphan.ts',
    'retire-resolved-orphans': 'tsx scripts/retire-resolved-orphans.ts',
    'cluster-triage': 'tsx scripts/cluster-triage-issues.ts',
}


class Tmp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()


class OpsEntrypoints(unittest.TestCase):
    def test_allowlist_in_order(self):
        self.assertEqual(pr.ops_entrypoints({'scripts': dict(ALLOWLIST_SCRIPTS, build='tsc')}), [
            'scripts/brewery-alias-key.ts', 'scripts/rearm-aliased-orphans.ts',
            'scripts/rearm-matcher-bug-orphans.ts', 'scripts/adjudicate-runner.ts',
            'scripts/close-orphan-issue.ts', 'scripts/pin-match.ts', 'scripts/repair-legacy-card.ts',
            'scripts/dispose-legacy-orphan.ts', 'scripts/retire-resolved-orphans.ts',
            'scripts/cluster-triage-issues.ts'])

    def test_missing_script(self):
        scripts = dict(ALLOWLIST_SCRIPTS)
        del scripts['pin-match']
        with self.assertRaisesRegex(pr.PackagingError, "npm script 'pin-match' must be exactly"):
            pr.ops_entrypoints({'scripts': scripts})

    def test_extra_arguments_are_refused(self):
        with self.assertRaisesRegex(pr.PackagingError, "npm script 'adjudicate'"):
            pr.ops_entrypoints({'scripts': dict(ALLOWLIST_SCRIPTS, adjudicate='tsx scripts/adjudicate-runner.ts --x')})

    def test_other_runner_is_refused(self):
        with self.assertRaisesRegex(pr.PackagingError, "npm script 'alias-key'"):
            pr.ops_entrypoints({'scripts': dict(ALLOWLIST_SCRIPTS, **{'alias-key': 'node dist/x.js'})})

    def test_the_repository_package_json_satisfies_the_allowlist(self):
        self.assertEqual(len(pr.ops_entrypoints(read_json(os.path.join(HERE, '..', '..', 'package.json')))), 10)


class OpsClosure(Tmp):
    def repo(self, files):
        repo = os.path.join(self.base, 'r')
        write(repo, 'tsconfig.json', json.dumps({'compilerOptions': {
            'module': 'nodenext', 'moduleResolution': 'nodenext', 'strict': True}}).encode())
        for rel, text in files.items():
            write(repo, rel, text.encode())
        return repo

    def test_value_and_type_only_imports(self):
        repo = self.repo({
            'scripts/op.ts': "import { a } from '../src/a';\nimport type { T } from '../src/t';\nconsole.log(a as T);\n",
            'src/a.ts': 'export const a = 1;\n',
            'src/t.ts': 'export type T = number;\n',
            'src/unused.ts': 'export const u = 1;\n',
        })
        self.assertEqual(pr.ops_closure(repo, ['scripts/op.ts'], TSC), ['scripts/op.ts', 'src/a.ts', 'src/t.ts'])

    def test_import_of_a_test_file_is_refused(self):
        repo = self.repo({'scripts/op.ts': "import '../src/a.test';\n", 'src/a.test.ts': 'export {};\n'})
        with self.assertRaisesRegex(pr.PackagingError, 'ops command imports a test file: src/a.test.ts'):
            pr.ops_closure(repo, ['scripts/op.ts'], TSC)

    def test_import_outside_src_and_scripts_is_refused(self):
        repo = self.repo({'scripts/op.ts': "import '../tools/x';\n", 'tools/x.ts': 'export {};\n'})
        with self.assertRaisesRegex(pr.PackagingError, 'ops import outside src/ and scripts/: tools/x.ts'):
            pr.ops_closure(repo, ['scripts/op.ts'], TSC)

    def test_missing_entrypoint_is_refused(self):
        repo = self.repo({'scripts/op.ts': 'export {};\n'})
        with self.assertRaisesRegex(pr.PackagingError, 'tsc --listFilesOnly failed'):
            pr.ops_closure(repo, ['scripts/nope.ts'], TSC)

    def test_unresolved_import_is_left_to_the_load_probe(self):
        # --listFilesOnly does not typecheck: an import that resolves nowhere is simply not
        # listed. The payload's ops load probe (payload-probe.cjs ops) is what refuses it.
        repo = self.repo({'scripts/op.ts': "import '../src/missing';\n"})
        self.assertEqual(pr.ops_closure(repo, ['scripts/op.ts'], TSC), ['scripts/op.ts'])


def manifest_of(paths, size=0):
    entries = []
    for p in paths:
        if p.endswith('/'):
            entries.append({'path': p[:-1], 'type': 'dir', 'mode': 0o755})
        else:
            entries.append({'path': p, 'type': 'file', 'mode': 0o644, 'size': size, 'sha256': ''})
    return {'formatVersion': 1, 'entries': entries}


TOP = ['release.json', 'package.json', 'package-lock.json', 'dist/', 'node_modules/', 'src/', 'scripts/']


class Policy(unittest.TestCase):
    def problems(self, extra, caps=pr.Caps()):
        return pr.policy_problems(manifest_of(TOP + extra), caps)

    def test_clean(self):
        self.assertEqual(self.problems(['dist/index.js', 'node_modules/x/.env.example', 'node_modules/x/test/a.test.js']), [])

    def test_extra_top_level(self):
        self.assertEqual(self.problems(['deploy/']), [
            "top level must be exactly ['dist', 'node_modules', 'package-lock.json', 'package.json', "
            "'release.json', 'scripts', 'src', 'tree-manifest.json'], got ['deploy', 'dist', 'node_modules', "
            "'package-lock.json', 'package.json', 'release.json', 'scripts', 'src', 'tree-manifest.json']"])

    def test_missing_top_level(self):
        m = manifest_of(['release.json', 'package.json', 'package-lock.json', 'dist/', 'node_modules/', 'src/'])
        self.assertEqual(pr.policy_problems(m, pr.Caps()), [
            "top level must be exactly ['dist', 'node_modules', 'package-lock.json', 'package.json', "
            "'release.json', 'scripts', 'src', 'tree-manifest.json'], got ['dist', 'node_modules', "
            "'package-lock.json', 'package.json', 'release.json', 'src', 'tree-manifest.json']"])

    def test_env_files(self):
        self.assertEqual(self.problems(['dist/.env', 'src/.env.local', 'node_modules/x/.env']), [
            'dist/.env: env file in payload', 'src/.env.local: env file in payload',
            'node_modules/x/.env: env file in payload'])

    def test_env_example_outside_node_modules(self):
        self.assertEqual(self.problems(['dist/.env.example']), ['dist/.env.example: env file in payload'])

    def test_database_files(self):
        self.assertEqual(self.problems(['dist/bot.db', 'node_modules/x/a.sqlite']), [
            'dist/bot.db: database file in payload', 'node_modules/x/a.sqlite: database file in payload'])

    def test_test_material_outside_node_modules(self):
        self.assertEqual(self.problems(['dist/a.test.js', 'dist/b.testing.js', 'src/fixtures/', 'scripts/tests/']), [
            'dist/a.test.js: test material in payload', 'dist/b.testing.js: test material in payload',
            'src/fixtures: test material in payload', 'scripts/tests: test material in payload'])

    def test_entry_cap_boundary(self):
        # TOP is 7 entries; with dist/a that is 8.
        self.assertEqual(self.problems(['dist/a'], pr.Caps(entries=8)), [])
        self.assertEqual(self.problems(['dist/a', 'dist/b'], pr.Caps(entries=8)), ['9 entries exceed the cap of 8'])

    def test_byte_cap_boundary(self):
        # Three top-level files of 10 bytes each.
        self.assertEqual(pr.policy_problems(manifest_of(TOP, size=10), pr.Caps(file_bytes=30)), [])
        self.assertEqual(pr.policy_problems(manifest_of(TOP, size=10), pr.Caps(file_bytes=29)),
                         ['30 file bytes exceed the cap of 29'])


class ReleaseInfo(unittest.TestCase):
    def test_exact_document(self):
        self.assertEqual(release(), {
            'formatVersion': 1, 'repo': 'o/r', 'sourceSha': SHA, 'workflow': '.github/workflows/ci.yml',
            'runId': 7, 'runAttempt': 2,
            'node': {'version': '24.1.0', 'major': 24, 'modules': '137'},
            'platform': {'os': 'linux', 'arch': 'x64', 'libc': 'glibc', 'glibcVersion': '2.39'},
            'packageLockSha256': 'f' * 64})

    def test_other_node_major(self):
        with self.assertRaisesRegex(pr.PackagingError, "requires Node 24, got 'v26.0.0'"):
            pr.release_info('o/r', SHA, 'w', '1', '1', 'v26.0.0', '141', 'glibc 2.39', '')

    def test_short_sha(self):
        with self.assertRaisesRegex(pr.PackagingError, 'source SHA must be 40 lowercase hex'):
            release(sha='abc')

    def test_no_glibc(self):
        with self.assertRaisesRegex(pr.PackagingError, 'packaging requires glibc, got None'):
            release(glibc=None)


class Archive(Tmp):
    def test_same_input_same_bytes(self):
        a, _ = packed(os.path.join(self.base, 'one'))
        b, _ = packed(os.path.join(self.base, 'two'))
        with open(a, 'rb') as fa, open(b, 'rb') as fb:
            self.assertEqual(fa.read(), fb.read())

    def test_members_follow_the_manifest_with_neutral_metadata(self):
        archive, manifest = packed(self.base)
        with tarfile.open(archive, 'r:gz') as tar:
            members = tar.getmembers()
        self.assertEqual([m.name for m in members], [tm.MANIFEST_NAME] + [e['path'] for e in manifest['entries']])
        self.assertEqual({(m.mtime, m.uid, m.gid, m.uname, m.gname) for m in members}, {(0, 0, 0, '', '')})

    def test_checksum_file(self):
        archive, _ = packed(self.base)
        with open(archive + '.sha256', encoding='ascii') as f:
            self.assertEqual(f.read(), f'{pr._sha256(archive)}  runtime.tar.gz\n')

    def test_payload_layout(self):
        _, manifest = packed(self.base)
        self.assertEqual([e['path'] for e in manifest['entries']], [
            'dist', 'dist/index.js', 'node_modules', 'node_modules/.bin', 'node_modules/.bin/pkg',
            'node_modules/pkg', 'node_modules/pkg/cli.js', 'package-lock.json', 'package.json', 'release.json',
            'scripts', 'scripts/op.ts', 'src', 'src/api', 'src/api/fest-print', 'src/api/fest-print/index.html'])

    def test_archive_cap(self):
        repo_base = os.path.join(self.base, 'b')
        _, manifest = packed(repo_base)
        out = os.path.join(self.base, 'small')
        os.makedirs(out)
        with self.assertRaisesRegex(pr.PackagingError, 'runtime.tar.gz is \\d+ bytes, over the cap of 10'):
            pr.write_archive(os.path.join(repo_base, 'payload'), manifest, out, pr.Caps(archive_bytes=10))

    def test_env_file_in_dist_stops_assembly(self):
        repo, dist, modules = make_inputs(self.base)
        write(dist, '.env', b'TELEGRAM_BOT_TOKEN=x')
        with self.assertRaisesRegex(pr.PackagingError, '^dist/.env: env file in payload$'):
            pr.assemble(repo, dist, modules, os.path.join(self.base, 'p'), release(), ['scripts/op.ts'])


if __name__ == '__main__':
    unittest.main()
