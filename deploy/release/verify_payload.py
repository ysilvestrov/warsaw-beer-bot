#!/usr/bin/env python3
"""Isolated proof of a packed runtime artifact before CI publishes it.

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §3 BUILD-001.
Plan: docs/superpowers/plans/2026-10/2026-10-08-wbb-artifact-deployment-core-1.md, Task 3.

Checksum before unpacking; unpack into a NEW directory with our own entry checks
plus tarfile's data filter; the tree must match tree-manifest.json exactly; then
the payload, made read-only, runs with an empty environment from an empty
directory, so neither the source checkout's node_modules nor any credential can
stand in for something the payload lacks.

Usage: verify_payload.py --archive A --checksum A.sha256 --sha SHA --workdir NEW_DIR [--node node]
Exit:  0 VERIFIED, 1 refused (reason on stderr).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tree_manifest as tm  # noqa: E402
from package_runtime import ARCHIVE, FORMAT_VERSION, NODE_MAJOR, OPS_ALLOWLIST, Caps, ops_entrypoints  # noqa: E402

PROBE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'payload-probe.cjs')
PROBE_TIMEOUT_S = 120
CHECKSUM_LINE = re.compile(r'([0-9a-f]{64})  ' + re.escape(ARCHIVE) + r'\n')
CHECKSUM_MAX_BYTES = 256


class Refused(Exception):
    pass


def check_checksum(archive, checksum_file):
    with open(checksum_file, 'rb') as f:
        raw = f.read(CHECKSUM_MAX_BYTES + 1)
    m = CHECKSUM_LINE.fullmatch(raw.decode('ascii', 'replace')) if len(raw) <= CHECKSUM_MAX_BYTES else None
    if not m:
        raise Refused(f'{checksum_file}: not a single "<sha256>  {ARCHIVE}" line')
    h = hashlib.sha256()
    with open(archive, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    if h.hexdigest() != m.group(1):
        raise Refused(f'{ARCHIVE} sha256 {h.hexdigest()} != {m.group(1)}')
    return m.group(1)


def extract(archive, dest, caps=Caps()):
    """Unpack into dest (must not exist) after checking every member; never over an existing tree."""
    if os.path.getsize(archive) > caps.archive_bytes:
        raise Refused(f'{ARCHIVE} is over the cap of {caps.archive_bytes} bytes')
    os.makedirs(dest)
    with tarfile.open(archive, 'r:gz') as tar:
        members = []
        names = set()
        total = 0
        for m in tar:
            why = tm.path_problem(m.name)
            if why:
                raise Refused(f'archive member {m.name!r}: {why}')
            if m.name in names:
                raise Refused(f'archive member {m.name}: duplicate')
            if not (m.isreg() or m.isdir() or m.issym()):
                raise Refused(f'archive member {m.name}: type {m.type!r} is not file, directory or symlink')
            if m.mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
                raise Refused(f'archive member {m.name}: special mode bits')
            names.add(m.name)
            members.append(m)
            total += m.size if m.isreg() else 0
            if len(members) > caps.entries + 1:
                raise Refused(f'archive has more than {caps.entries} entries')
            if total > caps.file_bytes:
                raise Refused(f'archive expands past {caps.file_bytes} bytes')
        try:
            tar.extractall(dest, members=members, filter='data')
        except tarfile.FilterError as e:
            raise Refused(f'archive member refused by the data filter: {e}')


def _version(text):
    return tuple(int(x) for x in text.split('.'))


def check_release(payload, sha, node_abi, host_glibc):
    """release.json must name this SHA and a platform this machine can run."""
    with open(os.path.join(payload, 'release.json'), encoding='utf-8') as f:
        rel = json.load(f)
    node = rel.get('node') if isinstance(rel.get('node'), dict) else {}
    plat = rel.get('platform') if isinstance(rel.get('platform'), dict) else {}
    glibc = plat.get('glibcVersion')
    problems = []
    if rel.get('formatVersion') != FORMAT_VERSION:
        problems.append(f'formatVersion {rel.get("formatVersion")!r}')
    if rel.get('sourceSha') != sha:
        problems.append(f'sourceSha {rel.get("sourceSha")!r} is not {sha}')
    if node.get('major') != NODE_MAJOR or node.get('modules') != node_abi:
        problems.append(f'node {node.get("major")!r}/ABI {node.get("modules")!r}, this machine runs {NODE_MAJOR}/ABI {node_abi}')
    if {k: plat.get(k) for k in ('os', 'arch', 'libc')} != {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'}:
        problems.append(f'platform {plat!r}')
    elif not isinstance(glibc, str) or not re.match(r'^\d+\.\d+$', glibc) or _version(glibc) > _version(host_glibc):
        problems.append(f'glibc {glibc!r} is newer than this machine\'s {host_glibc}')
    if problems:
        raise Refused('release.json: ' + '; '.join(problems))
    return rel


def prepare(archive, checksum_file, sha, workdir, node_abi, host_glibc, caps=Caps()):
    """Every check that needs no payload execution; returns the unpacked payload path."""
    check_checksum(archive, checksum_file)
    payload = os.path.join(workdir, 'payload')
    extract(archive, payload, caps)
    with open(os.path.join(payload, tm.MANIFEST_NAME), 'rb') as f:
        problems = tm.verify_tree(payload, f.read())
    if problems:
        raise Refused('tree does not match tree-manifest.json:\n' + '\n'.join(problems[:50]))
    check_release(payload, sha, node_abi, host_glibc)
    return payload


def make_read_only(root):
    for dirpath, dirnames, filenames in os.walk(root):
        for name in filenames:
            p = os.path.join(dirpath, name)
            if not os.path.islink(p):
                os.chmod(p, os.stat(p).st_mode & ~0o222)
        os.chmod(dirpath, os.stat(dirpath).st_mode & ~0o222)


def run_probes(payload, workdir, node):
    scratch = os.path.join(workdir, 'scratch')
    for d in ('probe', 'home', 'tmp', 'cwd'):
        os.makedirs(os.path.join(scratch, d))
    probe = shutil.copy(PROBE, os.path.join(scratch, 'probe', 'payload-probe.cjs'))
    env = {
        'PATH': '/usr/bin:/bin',
        'HOME': os.path.join(scratch, 'home'),
        'TMPDIR': os.path.join(scratch, 'tmp'),
        'WBB_PAYLOAD': payload,
        # The ops commands read an operator .env at import; an empty one keeps them offline.
        'DOTENV_CONFIG_PATH': os.devnull,
    }
    cwd = os.path.join(scratch, 'cwd')

    def run(args):
        return subprocess.run([node, *args], cwd=cwd, env=env, capture_output=True, text=True,
                              timeout=PROBE_TIMEOUT_S, check=False)

    with open(os.path.join(payload, 'package.json'), encoding='utf-8') as f:
        ops = ops_entrypoints(json.load(f))
    if len(ops) != len(OPS_ALLOWLIST):
        raise Refused('ops entrypoints do not cover the allowlist')
    for name, extra in (('native', []), ('migrate', []), ('assets', []), ('ops', ops)):
        r = run([probe, name, *extra])
        if r.returncode != 0:
            raise Refused(f'probe {name}: {r.stdout.strip()} {r.stderr.strip()[-2000:]}')
        print(r.stdout.strip())

    # Startup: the whole static import graph of dist/index.js loads, then main()
    # stops at its first line (loadEnv) without a token, before any network.
    r = run([os.path.join(payload, 'dist', 'index.js')])
    if r.returncode != 1 or 'TELEGRAM_BOT_TOKEN' not in r.stderr:
        raise Refused(f'startup: expected exit 1 at loadEnv (TELEGRAM_BOT_TOKEN), got {r.returncode}: {r.stderr.strip()[-2000:]}')
    print('PROBE OK startup: dist/index.js loads and stops at loadEnv')


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--archive', required=True)
    ap.add_argument('--checksum', required=True)
    ap.add_argument('--sha', required=True)
    ap.add_argument('--workdir', required=True, help='new directory')
    ap.add_argument('--node', default='node')
    a = ap.parse_args(argv)
    found = shutil.which(a.node)
    if not found:
        raise Refused(f'no node executable: {a.node}')
    node = os.path.realpath(found)
    abi = subprocess.run([node, '-p', 'process.versions.modules'], capture_output=True, text=True, check=True).stdout.strip()
    os.makedirs(a.workdir)
    glibc = os.confstr('CS_GNU_LIBC_VERSION').split()[1]
    payload = prepare(a.archive, a.checksum, a.sha, os.path.realpath(a.workdir), abi, glibc)
    make_read_only(payload)
    try:
        run_probes(payload, os.path.realpath(a.workdir), node)
    finally:
        # Writable again, so whoever cleans the work directory (the CI runner) can.
        for dirpath, _, filenames in os.walk(payload):
            os.chmod(dirpath, 0o755)
    print(f'VERIFIED {a.sha}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (Refused, tm.ManifestError) as e:
        print(f'VERIFY FAILED: {e}', file=sys.stderr)
        sys.exit(1)
