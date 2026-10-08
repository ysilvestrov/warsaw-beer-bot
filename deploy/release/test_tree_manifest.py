import hashlib
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tree_manifest as tm  # noqa: E402

HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'  # sha256(b'hello')


def write(root, rel, data=b'hello', mode=0o644):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    os.chmod(path, mode)


class Tree(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def built(self):
        data = tm.canonical_bytes(tm.build_manifest(self.root))
        with open(os.path.join(self.root, tm.MANIFEST_NAME), 'wb') as f:
            f.write(data)
        return data


class CanonicalForm(Tree):
    def test_exact_bytes_of_a_small_tree(self):
        write(self.root, 'a/b.txt')
        write(self.root, 'run.sh', mode=0o700)
        os.symlink('a/b.txt', os.path.join(self.root, 'link'))
        self.assertEqual(
            tm.canonical_bytes(tm.build_manifest(self.root)),
            ('{"entries":['
             '{"mode":493,"path":"a","type":"dir"},'
             '{"mode":420,"path":"a/b.txt","sha256":"' + HELLO_SHA + '","size":5,"type":"file"},'
             '{"path":"link","target":"a/b.txt","type":"symlink"},'
             '{"mode":493,"path":"run.sh","sha256":"' + HELLO_SHA + '","size":5,"type":"file"}'
             '],"formatVersion":1}').encode('utf-8'))

    def test_modes_normalise_to_644_and_755(self):
        write(self.root, 'plain', mode=0o600)
        write(self.root, 'group-exec', mode=0o610)
        modes = {e['path']: e['mode'] for e in tm.build_manifest(self.root)['entries']}
        self.assertEqual(modes, {'group-exec': 0o755, 'plain': 0o644})

    def test_manifest_file_itself_is_not_inventoried(self):
        write(self.root, 'x')
        self.built()
        self.assertEqual([e['path'] for e in tm.build_manifest(self.root)['entries']], ['x'])

    def test_digest_is_sha256_of_canonical_bytes(self):
        manifest = {'formatVersion': 1, 'entries': []}
        self.assertEqual(tm.tree_digest(manifest), hashlib.sha256(b'{"entries":[],"formatVersion":1}').hexdigest())

    def test_empty_tree(self):
        self.assertEqual(tm.build_manifest(self.root), {'formatVersion': 1, 'entries': []})


class Refusals(Tree):
    def test_fifo(self):
        os.mkfifo(os.path.join(self.root, 'pipe'))
        with self.assertRaisesRegex(tm.ManifestError, '^pipe: not a regular file'):
            tm.build_manifest(self.root)

    def test_hardlink(self):
        write(self.root, 'a')
        os.link(os.path.join(self.root, 'a'), os.path.join(self.root, 'b'))
        with self.assertRaisesRegex(tm.ManifestError, 'hardlinked file'):
            tm.build_manifest(self.root)

    def link_problem(self, target, link='l', extra=()):
        for rel in extra:
            write(self.root, rel)
        os.symlink(target, os.path.join(self.root, link))
        with self.assertRaises(tm.ManifestError) as cm:
            tm.build_manifest(self.root)
        return str(cm.exception)

    def test_symlink_escaping_payload(self):
        self.assertEqual(self.link_problem('../outside'), 'l: symlink escapes the payload or dangles')

    def test_absolute_symlink(self):
        self.assertEqual(self.link_problem('/etc/passwd'), 'l: absolute symlink target')

    def test_dangling_symlink(self):
        self.assertEqual(self.link_problem('nope'), 'l: symlink escapes the payload or dangles')

    def test_symlink_through_symlink_component_that_escapes(self):
        os.mkdir(os.path.join(self.root, 'd'))
        os.symlink('..', os.path.join(self.root, 'up'))
        # up -> '..' already escapes, so both the hop and the link through it are refused.
        self.assertEqual(
            self.link_problem('../up/x', link='d/l'),
            'd/l: symlink escapes the payload or dangles; up: symlink escapes the payload or dangles')

    def test_empty_component_in_target(self):
        self.assertEqual(self.link_problem('a//b', extra=['a/b']), 'l: empty component in symlink target')

    def test_link_loop(self):
        os.symlink('b', os.path.join(self.root, 'a'))
        os.symlink('a', os.path.join(self.root, 'b'))
        with self.assertRaisesRegex(tm.ManifestError, 'a: symlink escapes the payload or dangles'):
            tm.build_manifest(self.root)


class AllowedLinks(Tree):
    def test_npm_bin_style_link(self):
        write(self.root, 'node_modules/tsx/dist/cli.mjs')
        os.makedirs(os.path.join(self.root, 'node_modules/.bin'))
        os.symlink('../tsx/dist/cli.mjs', os.path.join(self.root, 'node_modules/.bin/tsx'))
        self.assertEqual(tm.verify_tree(self.root, self.built()), [])

    def test_link_through_inner_dir_link(self):
        write(self.root, 'real/f')
        os.symlink('real', os.path.join(self.root, 'alias'))
        os.symlink('alias/f', os.path.join(self.root, 'l'))
        self.assertEqual(tm.verify_tree(self.root, self.built()), [])


class Verify(Tree):
    def setUp(self):
        super().setUp()
        write(self.root, 'dist/index.js')
        write(self.root, 'bin/run', mode=0o755)
        os.symlink('../dist/index.js', os.path.join(self.root, 'bin/main'))
        self.data = self.built()

    def test_exact_tree_passes(self):
        self.assertEqual(tm.verify_tree(self.root, self.data), [])

    def test_changed_byte_same_size(self):
        write(self.root, 'dist/index.js', b'jello')
        self.assertEqual(tm.verify_tree(self.root, self.data), ['dist/index.js: differs from manifest (sha256)'])

    def test_changed_mode(self):
        os.chmod(os.path.join(self.root, 'bin/run'), 0o644)
        self.assertEqual(tm.verify_tree(self.root, self.data), ['bin/run: differs from manifest (mode)'])

    def test_changed_link_target(self):
        os.remove(os.path.join(self.root, 'bin/main'))
        os.symlink('run', os.path.join(self.root, 'bin/main'))
        self.assertEqual(tm.verify_tree(self.root, self.data), ['bin/main: differs from manifest (target)'])

    def test_extra_and_missing(self):
        write(self.root, 'dist/extra.js')
        os.remove(os.path.join(self.root, 'bin/run'))
        self.assertEqual(sorted(tm.verify_tree(self.root, self.data)),
                         ['bin/run: missing from tree', 'dist/extra.js: not in manifest'])

    def test_file_replaced_by_link(self):
        os.remove(os.path.join(self.root, 'bin/run'))
        os.symlink('../dist/index.js', os.path.join(self.root, 'bin/run'))
        self.assertEqual(tm.verify_tree(self.root, self.data), ['bin/run: differs from manifest (mode, sha256, size, target, type)'])

    def test_non_canonical_bytes(self):
        pretty = json.dumps(json.loads(self.data), indent=1).encode('utf-8')
        self.assertEqual(tm.verify_tree(self.root, pretty), ['manifest bytes are not canonical'])

    def test_unsorted_entries(self):
        m = json.loads(self.data)
        m['entries'].reverse()
        self.assertEqual(tm.verify_tree(self.root, tm.canonical_bytes(m)), ['manifest entries are not sorted'])

    def test_traversal_path_in_manifest(self):
        m = {'formatVersion': 1, 'entries': [{'path': '../x', 'type': 'dir', 'mode': 0o755}]}
        self.assertEqual(tm.verify_tree(self.root, tm.canonical_bytes(m)), ["'../x': empty, \".\" or \"..\" component"])

    def test_duplicate_path_in_manifest(self):
        e = {'path': 'a', 'type': 'dir', 'mode': 0o755}
        m = {'formatVersion': 1, 'entries': [e, e]}
        self.assertEqual(tm.verify_tree(self.root, tm.canonical_bytes(m)), ['a: duplicate entry'])

    def test_wrong_format_version(self):
        self.assertEqual(tm.verify_tree(self.root, b'{"entries":[],"formatVersion":2}'), ['unsupported formatVersion 2'])

    def test_entry_without_parent_dir(self):
        m = {'formatVersion': 1, 'entries': [{'path': 'a/b', 'type': 'dir', 'mode': 0o755}]}
        self.assertEqual(tm.verify_tree(self.root, tm.canonical_bytes(m)), ['a/b: parent is not a directory entry'])

    def test_special_mode_bits_are_not_a_valid_entry(self):
        m = {'formatVersion': 1, 'entries': [{'path': 'a', 'type': 'file', 'mode': 0o4755, 'size': 0, 'sha256': ''}]}
        self.assertEqual(tm.verify_tree(self.root, tm.canonical_bytes(m)), ['a: malformed file entry'])

    def test_not_json(self):
        self.assertEqual(tm.verify_tree(self.root, b'\xff')[0][:27], 'manifest is not UTF-8 JSON:')


if __name__ == '__main__':
    unittest.main()
