#!/usr/bin/env python3
"""Runtime payload inventory: the tree-manifest.json format and its verifier.

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §3-§4.

CI writes tree-manifest.json into the payload; the host (Ядро-2) verifies an
unpacked tree against it and keeps the tree digest (SHA256 of the canonical
manifest bytes) in its own receipt. The digest is never written into the
payload: a manifest cannot vouch for itself.

Stdlib only, no candidate code: this module is meant to run as an installed
trusted tool against untrusted bytes.

Usage: tree_manifest.py build <root>   writes <root>/tree-manifest.json
       tree_manifest.py verify <root>  exit 0 OK, 1 with one problem per line
"""
import hashlib
import json
import os
import posixpath
import stat
import sys

FORMAT_VERSION = 1
MANIFEST_NAME = 'tree-manifest.json'
FILE_MODES = (0o644, 0o755)
DIR_MODE = 0o755
MAX_LINK_HOPS = 40


class ManifestError(Exception):
    pass


def canonical_bytes(manifest):
    return json.dumps(manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def tree_digest(manifest):
    return hashlib.sha256(canonical_bytes(manifest)).hexdigest()


def path_problem(path):
    """Why `path` is not a safe payload-relative path, or None."""
    if not isinstance(path, str):
        return 'path is not a string'
    if path == '':
        return 'empty path'
    if path.startswith('/'):
        return 'absolute path'
    if '\\' in path or '\x00' in path:
        return 'backslash or NUL in path'
    if any(part in ('', '.', '..') for part in path.split('/')):
        return 'empty, "." or ".." component'
    return None


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _scan(root):
    """Yield (relative path, lstat) for every entry under root, never following links."""
    stack = ['']
    while stack:
        rel_dir = stack.pop()
        with os.scandir(os.path.join(root, rel_dir) if rel_dir else root) as it:
            for de in it:
                name = de.name
                try:
                    name.encode('utf-8')
                except UnicodeEncodeError:
                    raise ManifestError(f'non-UTF-8 name under {rel_dir or "."}')
                rel = f'{rel_dir}/{name}' if rel_dir else name
                st = de.stat(follow_symlinks=False)
                yield rel, st
                if stat.S_ISDIR(st.st_mode):
                    stack.append(rel)


def entry_for(root, rel, st):
    if stat.S_ISLNK(st.st_mode):
        return {'path': rel, 'type': 'symlink', 'target': os.readlink(os.path.join(root, rel))}
    if stat.S_ISDIR(st.st_mode):
        return {'path': rel, 'type': 'dir', 'mode': DIR_MODE}
    if stat.S_ISREG(st.st_mode):
        if st.st_nlink > 1:
            raise ManifestError(f'{rel}: hardlinked file')
        mode = 0o755 if st.st_mode & 0o111 else 0o644
        return {'path': rel, 'type': 'file', 'mode': mode, 'size': st.st_size,
                'sha256': _sha256_file(os.path.join(root, rel))}
    raise ManifestError(f'{rel}: not a regular file, directory or symlink')


def _sorted(entries):
    return sorted(entries, key=lambda e: e['path'].encode('utf-8'))


def build_manifest(root):
    entries = [entry_for(root, rel, st) for rel, st in _scan(root) if rel != MANIFEST_NAME]
    manifest = {'formatVersion': FORMAT_VERSION, 'entries': _sorted(entries)}
    problems = check_entries(manifest['entries'])
    if problems:
        raise ManifestError('; '.join(problems))
    return manifest


def _resolve(by_path, start, hops=0):
    """Resolve a payload-relative path through manifest symlinks; None if it escapes or dangles."""
    parts = start.split('/')
    resolved = []
    i = 0
    while i < len(parts):
        part = parts[i]
        i += 1
        if part == '..':
            if not resolved:
                return None
            resolved.pop()
            continue
        if part in ('', '.'):
            continue
        cur = '/'.join(resolved + [part])
        entry = by_path.get(cur)
        if entry is None:
            return None
        if entry['type'] == 'symlink':
            hops += 1
            if hops > MAX_LINK_HOPS:
                return None
            target = entry['target']
            if target.startswith('/'):
                return None
            joined = posixpath.join('/'.join(resolved), target) if resolved else target
            rest = parts[i:]
            parts = joined.split('/') + rest
            resolved = []
            i = 0
            continue
        if entry['type'] != 'dir' and i < len(parts):
            return None
        resolved.append(part)
    return '/'.join(resolved) if resolved else None


def check_entries(entries):
    """Structural problems of a manifest entry list (paths, types, modes, links)."""
    problems = []
    by_path = {}
    for e in entries:
        p = e.get('path')
        why = path_problem(p)
        if why:
            problems.append(f'{p!r}: {why}')
            continue
        if p in by_path:
            problems.append(f'{p}: duplicate entry')
            continue
        by_path[p] = e
    for p, e in by_path.items():
        parent = posixpath.dirname(p)
        if parent and by_path.get(parent, {}).get('type') != 'dir':
            problems.append(f'{p}: parent is not a directory entry')
        kind = e.get('type')
        if kind == 'file':
            if set(e) != {'path', 'type', 'mode', 'size', 'sha256'} or e['mode'] not in FILE_MODES:
                problems.append(f'{p}: malformed file entry')
        elif kind == 'dir':
            if set(e) != {'path', 'type', 'mode'} or e['mode'] != DIR_MODE:
                problems.append(f'{p}: malformed dir entry')
        elif kind == 'symlink':
            target = e.get('target')
            if set(e) != {'path', 'type', 'target'} or not isinstance(target, str) or target == '':
                problems.append(f'{p}: malformed symlink entry')
            elif target.startswith('/'):
                problems.append(f'{p}: absolute symlink target')
            elif any(part == '' for part in target.split('/')):
                problems.append(f'{p}: empty component in symlink target')
            elif _resolve(by_path, p) is None:
                problems.append(f'{p}: symlink escapes the payload or dangles')
        else:
            problems.append(f'{p}: unknown entry type {kind!r}')
    return problems


def verify_tree(root, manifest_bytes):
    """Problems of the tree at root against manifest_bytes; [] means an exact match."""
    try:
        manifest = json.loads(manifest_bytes.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        return [f'manifest is not UTF-8 JSON: {e}']
    if not isinstance(manifest, dict) or set(manifest) != {'formatVersion', 'entries'}:
        return ['manifest must have exactly formatVersion and entries']
    if manifest['formatVersion'] != FORMAT_VERSION:
        return [f'unsupported formatVersion {manifest["formatVersion"]!r}']
    if not isinstance(manifest['entries'], list) or not all(isinstance(e, dict) for e in manifest['entries']):
        return ['entries must be a list of objects']
    if canonical_bytes(manifest) != manifest_bytes:
        return ['manifest bytes are not canonical']
    # Structure first: sorting needs every entry to carry a string path.
    problems = check_entries(manifest['entries'])
    if problems:
        return problems
    if manifest['entries'] != _sorted(manifest['entries']):
        return ['manifest entries are not sorted']
    expected = {e['path']: e for e in manifest['entries']}
    seen = set()
    try:
        for rel, st in _scan(root):
            if rel == MANIFEST_NAME:
                continue
            seen.add(rel)
            want = expected.get(rel)
            if want is None:
                problems.append(f'{rel}: not in manifest')
                continue
            try:
                got = entry_for(root, rel, st)
            except ManifestError as e:
                problems.append(str(e))
                continue
            if got != want:
                diff = sorted(k for k in set(got) | set(want) if got.get(k) != want.get(k))
                problems.append(f'{rel}: differs from manifest ({", ".join(diff)})')
    except ManifestError as e:
        problems.append(str(e))
    problems.extend(f'{p}: missing from tree' for p in expected if p not in seen)
    return problems


def main(argv):
    if len(argv) != 2 or argv[0] not in ('build', 'verify'):
        print('usage: tree_manifest.py build|verify <root>', file=sys.stderr)
        return 64
    cmd, root = argv
    path = os.path.join(root, MANIFEST_NAME)
    if cmd == 'build':
        data = canonical_bytes(build_manifest(root))
        with open(path, 'wb') as f:
            f.write(data)
        print(f'tree digest {hashlib.sha256(data).hexdigest()}')
        return 0
    with open(path, 'rb') as f:
        problems = verify_tree(root, f.read())
    for p in problems:
        print(p)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
