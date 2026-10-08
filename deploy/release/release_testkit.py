"""Test helpers shared by test_package_runtime.py and test_verify_payload.py (not a test module)."""
import json
import os

import package_runtime as pr

SHA = 'a' * 40


def write(root, rel, data=b'x', mode=0o644):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    os.chmod(path, mode)


def make_inputs(base):
    """A minimal repo, dist and production node_modules that assemble() accepts."""
    repo = os.path.join(base, 'repo')
    write(repo, 'package.json', b'{"name":"t"}')
    write(repo, 'package-lock.json', b'{}')
    write(repo, 'src/api/fest-print/index.html', b'<html></html>')
    write(repo, 'scripts/op.ts', b'export {};\n')
    dist = os.path.join(base, 'dist')
    write(dist, 'index.js', b'console.log(1);\n')
    modules = os.path.join(base, 'nm')
    write(modules, 'pkg/cli.js', b'#!/usr/bin/env node\n', mode=0o755)
    os.makedirs(os.path.join(modules, '.bin'))
    os.symlink('../pkg/cli.js', os.path.join(modules, '.bin', 'pkg'))
    return repo, dist, modules


def release(sha=SHA, glibc='glibc 2.39'):
    return pr.release_info('o/r', sha, '.github/workflows/ci.yml', '7', '2', 'v24.1.0', '137', glibc, 'f' * 64)


def packed(base, mutate=None):
    """assemble + write_archive; `mutate(payload)` runs between the manifest and the archive."""
    repo, dist, modules = make_inputs(base)
    payload = os.path.join(base, 'payload')
    manifest = pr.assemble(repo, dist, modules, payload, release(), ['scripts/op.ts'])
    if mutate:
        mutate(payload)
    out = os.path.join(base, 'out')
    os.makedirs(out)
    pr.write_archive(payload, manifest, out)
    return os.path.join(out, pr.ARCHIVE), manifest


def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)
