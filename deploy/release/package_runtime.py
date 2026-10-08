#!/usr/bin/env python3
"""Assemble the runtime payload of one main SHA and pack runtime.tar.gz (CI only).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §3 BUILD-001.
Plan: docs/superpowers/plans/2026-10/2026-10-08-wbb-artifact-deployment-core-1.md, Task 2.

Inputs are already built by the workflow: `dist` from tsconfig.release.json and a
production-only node_modules from `npm ci --omit=dev`. This script only copies,
describes and packs; it never builds, so the same bytes can be reasoned about on
the host without trusting this script's environment.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tree_manifest as tm  # noqa: E402

FORMAT_VERSION = 1
NODE_MAJOR = 24
ARCHIVE = 'runtime.tar.gz'
RELEASE_JSON = 'release.json'
TOP_LEVEL = frozenset({RELEASE_JSON, tm.MANIFEST_NAME, 'package.json', 'package-lock.json',
                       'dist', 'node_modules', 'src', 'scripts'})
# Spec §3: the TS operational commands production keeps running through tsx.
# Changing this list is a reviewed packaging-contract change.
OPS_ALLOWLIST = ('alias-key', 'rearm-aliased-orphans', 'rearm-matcher-bug-orphans', 'adjudicate',
                 'close-orphan-issue', 'pin-match', 'repair-legacy-card', 'dispose-legacy-orphan',
                 'retire-resolved-orphans', 'cluster-triage')
# Read-by-path runtime assets tsc does not carry into dist (src/api/routes/fest-print.ts).
ASSET_DIRS = ('src/api/fest-print',)
OPS_SCRIPT = re.compile(r'^tsx (scripts/[A-Za-z0-9-]+\.ts)$')
SHA = re.compile(r'^[0-9a-f]{40}$')
DB_SUFFIXES = ('.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3')
TEST_DIRS = frozenset({'tests', '__tests__', 'fixtures'})


@dataclass(frozen=True)
class Caps:
    archive_bytes: int = 256 * 1024 * 1024
    file_bytes: int = 1024 * 1024 * 1024
    entries: int = 100_000


class PackagingError(Exception):
    pass


def ops_entrypoints(package_json):
    scripts = package_json.get('scripts', {})
    out = []
    for name in OPS_ALLOWLIST:
        m = OPS_SCRIPT.match(scripts.get(name, ''))
        if not m:
            raise PackagingError(f'npm script {name!r} must be exactly "tsx scripts/<file>.ts", got {scripts.get(name)!r}')
        out.append(m.group(1))
    return out


def ops_closure(repo, entrypoints, tsc):
    """Repository-local files the ops entrypoints import, as tsc resolves them (type-only included)."""
    repo = os.path.realpath(repo)
    with tempfile.TemporaryDirectory() as scratch:
        config = os.path.join(scratch, 'tsconfig.json')
        with open(config, 'w', encoding='utf-8') as f:
            json.dump({'extends': os.path.join(repo, 'tsconfig.json'),
                       'compilerOptions': {'noEmit': True, 'rootDir': repo, 'types': []},
                       'include': [], 'files': [os.path.join(repo, e) for e in entrypoints]}, f)
        run = subprocess.run([tsc, '-p', config, '--listFilesOnly'], cwd=repo,
                             capture_output=True, text=True, check=False)
    if run.returncode != 0:
        raise PackagingError(f'tsc --listFilesOnly failed: {run.stdout}{run.stderr}')
    files = set()
    for line in run.stdout.splitlines():
        path = os.path.realpath(line.strip())
        if not line.strip() or '/node_modules/' in path:
            continue
        rel = os.path.relpath(path, repo)
        if rel.startswith('..') or rel.split('/')[0] not in ('src', 'scripts'):
            raise PackagingError(f'ops import outside src/ and scripts/: {rel}')
        if '.test.' in os.path.basename(rel) or '.testing.' in os.path.basename(rel):
            raise PackagingError(f'ops command imports a test file: {rel}')
        files.add(rel)
    missing = [e for e in entrypoints if e not in files]
    if missing:
        raise PackagingError(f'tsc did not list the entrypoints: {missing}')
    return sorted(files)


def policy_problems(manifest, caps):
    entries = manifest['entries']
    problems = []
    top = {e['path'] for e in entries if '/' not in e['path']} | {tm.MANIFEST_NAME}
    if top != TOP_LEVEL:
        problems.append(f'top level must be exactly {sorted(TOP_LEVEL)}, got {sorted(top)}')
    for e in entries:
        p = e['path']
        parts = p.split('/')
        base = parts[-1]
        in_modules = parts[0] == 'node_modules'
        if base == '.env' or (base.startswith('.env.') and not (in_modules and base == '.env.example')):
            problems.append(f'{p}: env file in payload')
        if base.endswith(DB_SUFFIXES):
            problems.append(f'{p}: database file in payload')
        if not in_modules and ('.test.' in base or '.testing.' in base or TEST_DIRS & set(parts)):
            problems.append(f'{p}: test material in payload')
    if len(entries) > caps.entries:
        problems.append(f'{len(entries)} entries exceed the cap of {caps.entries}')
    total = sum(e['size'] for e in entries if e['type'] == 'file')
    if total > caps.file_bytes:
        problems.append(f'{total} file bytes exceed the cap of {caps.file_bytes}')
    return problems


def release_info(repo_slug, sha, workflow, run_id, run_attempt, node_version, node_modules_abi, glibc, lock_sha256):
    if not SHA.match(sha):
        raise PackagingError(f'source SHA must be 40 lowercase hex, got {sha!r}')
    m = re.match(r'^v?(\d+)\.\d+\.\d+$', node_version)
    if not m or int(m.group(1)) != NODE_MAJOR:
        raise PackagingError(f'packaging requires Node {NODE_MAJOR}, got {node_version!r}')
    g = re.match(r'^glibc (\d+\.\d+)$', glibc or '')
    if not g:
        raise PackagingError(f'packaging requires glibc, got {glibc!r}')
    return {
        'formatVersion': FORMAT_VERSION,
        'repo': repo_slug,
        'sourceSha': sha,
        'workflow': workflow,
        'runId': int(run_id),
        'runAttempt': int(run_attempt),
        'node': {'version': node_version.lstrip('v'), 'major': NODE_MAJOR, 'modules': str(node_modules_abi)},
        'platform': {'os': 'linux', 'arch': 'x64', 'libc': 'glibc', 'glibcVersion': g.group(1)},
        'packageLockSha256': lock_sha256,
    }


def _copy_file(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst, follow_symlinks=False)


def assemble(repo, dist, modules, payload, release, closure, caps=Caps()):
    """Build the payload tree at `payload` (must not exist); return its manifest."""
    os.makedirs(payload)
    for name in ('package.json', 'package-lock.json'):
        _copy_file(os.path.join(repo, name), os.path.join(payload, name))
    shutil.copytree(dist, os.path.join(payload, 'dist'), symlinks=True)
    shutil.copytree(modules, os.path.join(payload, 'node_modules'), symlinks=True)
    for rel in closure:
        if os.path.islink(os.path.join(repo, rel)):
            raise PackagingError(f'{rel}: ops source is a symlink')
        _copy_file(os.path.join(repo, rel), os.path.join(payload, rel))
    for rel in ASSET_DIRS:
        shutil.copytree(os.path.join(repo, rel), os.path.join(payload, rel), symlinks=True, dirs_exist_ok=True)
    with open(os.path.join(payload, RELEASE_JSON), 'w', encoding='utf-8') as f:
        json.dump(release, f, indent=2, sort_keys=True)
        f.write('\n')
    manifest = tm.build_manifest(payload)
    problems = policy_problems(manifest, caps)
    if problems:
        raise PackagingError('\n'.join(problems))
    with open(os.path.join(payload, tm.MANIFEST_NAME), 'wb') as f:
        f.write(tm.canonical_bytes(manifest))
    return manifest


def _tarinfo(name, kind, mode=0, size=0, target=''):
    info = tarfile.TarInfo(name)
    info.type = kind
    info.mode = mode
    info.size = size
    info.linkname = target
    info.mtime = 0
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    return info


def write_archive(payload, manifest, out_dir, caps=Caps()):
    """Deterministic runtime.tar.gz (+ .sha256) in manifest order; returns the archive SHA256."""
    archive = os.path.join(out_dir, ARCHIVE)
    with open(archive, 'wb') as raw, \
            gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=9) as gz, \
            tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as tar:
        manifest_bytes = tm.canonical_bytes(manifest)
        tar.addfile(_tarinfo(tm.MANIFEST_NAME, tarfile.REGTYPE, 0o644, len(manifest_bytes)),
                    io.BytesIO(manifest_bytes))
        for e in manifest['entries']:
            if e['type'] == 'dir':
                tar.addfile(_tarinfo(e['path'], tarfile.DIRTYPE, e['mode']))
            elif e['type'] == 'symlink':
                tar.addfile(_tarinfo(e['path'], tarfile.SYMTYPE, 0o777, target=e['target']))
            else:
                with open(os.path.join(payload, e['path']), 'rb') as f:
                    tar.addfile(_tarinfo(e['path'], tarfile.REGTYPE, e['mode'], e['size']), f)
    size = os.path.getsize(archive)
    if size > caps.archive_bytes:
        raise PackagingError(f'{ARCHIVE} is {size} bytes, over the cap of {caps.archive_bytes}')
    digest = _sha256(archive)
    with open(archive + '.sha256', 'w', encoding='ascii') as f:
        f.write(f'{digest}  {ARCHIVE}\n')
    return digest


def _sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--repo', required=True)
    ap.add_argument('--dist', required=True)
    ap.add_argument('--modules', required=True)
    ap.add_argument('--out', required=True, help='new directory: payload/ and the archive go here')
    ap.add_argument('--repo-slug', required=True)
    ap.add_argument('--sha', required=True)
    ap.add_argument('--workflow', required=True)
    ap.add_argument('--run-id', required=True)
    ap.add_argument('--run-attempt', required=True)
    ap.add_argument('--node', default='node')
    ap.add_argument('--tsc', default='node_modules/.bin/tsc')
    a = ap.parse_args(argv)
    if platform.machine() != 'x86_64':
        raise PackagingError(f'packaging target is x86_64, this machine is {platform.machine()}')
    repo = os.path.realpath(a.repo)
    node = subprocess.run([a.node, '-p', 'process.version + " " + process.versions.modules'],
                          capture_output=True, text=True, check=True).stdout.split()
    with open(os.path.join(repo, 'package.json'), encoding='utf-8') as f:
        entrypoints = ops_entrypoints(json.load(f))
    release = release_info(a.repo_slug, a.sha, a.workflow, a.run_id, a.run_attempt, node[0], node[1],
                           os.confstr('CS_GNU_LIBC_VERSION'), _sha256(os.path.join(repo, 'package-lock.json')))
    closure = ops_closure(repo, entrypoints, os.path.join(repo, a.tsc))
    os.makedirs(a.out)
    payload = os.path.join(a.out, 'payload')
    manifest = assemble(repo, a.dist, a.modules, payload, release, closure)
    digest = write_archive(payload, manifest, a.out)
    print(f'{ARCHIVE} sha256 {digest}; tree digest {tm.tree_digest(manifest)}; '
          f'{len(manifest["entries"])} entries; {len(closure)} ops sources')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except PackagingError as e:
        print(f'PACKAGING FAILED: {e}', file=sys.stderr)
        sys.exit(1)
