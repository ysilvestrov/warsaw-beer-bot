#!/usr/bin/env python3
"""Accept or re-verify a runtime release on the host (artifact deployment, Ядро-2а).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §2, §4.
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2a.md, Task 4.

Meant to be installed root-owned and run as root through a fixed sudo rule (the
installation is a later stage). It takes no paths but the operator's ZIP: the
release, receipt and scratch roots and the token file are constants here, and
trust comes from metadata fetched now, never from anything the operator passes.

Usage: wbb_release.py publish --sha <full sha> --archive <artifact zip>
       wbb_release.py verify  --sha <full sha>
Exit:  0 done, 1 refused (reason on stderr), 64 usage.
Nothing is activated: no unit, pointer or database is touched.
"""
import argparse
import os
import stat
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import github_trust as gt  # noqa: E402
import publish as pub  # noqa: E402
from safe_tar import Refused  # noqa: E402

PRODUCTION_ROOTS = pub.Roots(
    releases='/opt/warsaw-beer-bot/releases',
    receipts='/var/lib/wbb-deploy/receipts',
    scratch='/opt/warsaw-beer-bot/staging',
)
TOKEN_FILE = '/etc/wbb-deploy/github.env'
TOKEN_KEY = 'WBB_GITHUB_TOKEN'


def read_token(path):
    """WBB_GITHUB_TOKEN from a KEY=VALUE file only this user can read."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'r', encoding='utf-8') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise Refused(f'{path}: must be a regular file owned by this user, not readable by others')
        values = [line.split('=', 1)[1].strip() for line in f.read(8192).splitlines()
                  if line.startswith(f'{TOKEN_KEY}=')]
    if len(values) != 1 or not values[0]:
        raise Refused(f'{path}: expected exactly one non-empty {TOKEN_KEY}=')
    return values[0]


def main(argv, roots=PRODUCTION_ROOTS, token_file=TOKEN_FILE, api_factory=gt.GitHubApi):
    ap = argparse.ArgumentParser(prog='wbb_release.py', description='Accept or re-verify a runtime release.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('publish')
    p.add_argument('--sha', required=True)
    p.add_argument('--archive', required=True)
    v = sub.add_parser('verify')
    v.add_argument('--sha', required=True)
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return 64 if e.code else 0
    try:
        if a.cmd == 'verify':
            receipt = pub.verify_release(a.sha, roots)
            print(f'VERIFIED {a.sha}: tree {receipt["treeSha256"]} (run {receipt["runId"]} attempt {receipt["runAttempt"]})')
            return 0
        api = api_factory(read_token(token_file))
        trusted = gt.fetch_trusted(api, gt.REPO, a.sha)
        outcome = pub.publish(trusted, a.archive, roots)
        print(f'{outcome.upper()} {a.sha}: run {trusted.run_id} attempt {trusted.run_attempt}, artifact {trusted.artifact_id}')
        return 0
    except (Refused, gt.Untrusted) as e:
        print(f'REFUSED: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
