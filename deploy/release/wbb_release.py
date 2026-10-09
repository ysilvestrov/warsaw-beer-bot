#!/usr/bin/env python3
"""Accept or re-verify a runtime release on the host (artifact deployment, Ядро-2а).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §2, §4.
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2a.md, Task 4.

Meant to be installed root-owned and run as root through a fixed sudo rule (the
installation is a later stage). It takes no paths but the operator's ZIP: the
release, receipt and scratch roots and the token file are constants here, and
trust comes from metadata fetched now, never from anything the operator passes.

Usage: wbb_release.py publish --sha <full sha> --archive <artifact zip>   (root)
       wbb_release.py verify  --sha <full sha>                            (root)
       wbb_release.py audit   --sha <full sha>                            (operator, never root)
       wbb_release.py probe   --sha <full sha>                            (root; runs the sandbox)
       wbb_release.py trial   --sha <full sha> --snapshot <pre.db>        (root; runs the sandbox)
Exit:  0 done/ok, 1 refused or the candidate failed (reason on stderr), 75 could not judge
       now — retry, never a failed SHA (EX_TEMPFAIL), 64 usage.
Nothing is activated: no unit, pointer or database is touched.
"""
import argparse
import os
import stat
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounded  # noqa: E402
import github_trust as gt  # noqa: E402
import host_audit  # noqa: E402
import publish as pub  # noqa: E402
import sandbox as sb  # noqa: E402
import trial as tr  # noqa: E402
from audit_verdict import render_verdict  # noqa: E402
from safe_tar import Refused  # noqa: E402

PRODUCTION_ROOTS = pub.Roots(
    releases='/opt/warsaw-beer-bot/releases',
    receipts='/var/lib/wbb-deploy/receipts',
    scratch='/opt/warsaw-beer-bot/staging',
    owner=(0, 0),
)
TOKEN_FILE = '/etc/wbb-deploy/github.env'
# Parent of the per-run sandbox scratch directories (root-owned; each run is 0700 wbb-trial).
TRIAL_ROOT = '/var/lib/wbb-trial'
EX_TEMPFAIL = 75
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


def main(argv, roots=PRODUCTION_ROOTS, token_file=TOKEN_FILE, api_factory=gt.GitHubApi, trial_root=TRIAL_ROOT,
         runner=bounded.run, node=sb.NODE, ids=tr.trial_ids, audit=host_audit.audit_release):
    ap = argparse.ArgumentParser(prog='wbb_release.py', description='Accept, audit, probe or trial a runtime release.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('publish')
    p.add_argument('--sha', required=True)
    p.add_argument('--archive', required=True)
    for name in ('verify', 'audit', 'probe'):
        sub.add_parser(name).add_argument('--sha', required=True)
    t = sub.add_parser('trial')
    t.add_argument('--sha', required=True)
    t.add_argument('--snapshot', required=True)
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return 64 if e.code else 0
    try:
        if a.cmd == 'verify':
            receipt = pub.verify_release(a.sha, roots)
            print(f'VERIFIED {a.sha}: tree {receipt["treeSha256"]} (run {receipt["runId"]} attempt {receipt["runAttempt"]})')
            return 0
        if a.cmd == 'audit':
            # Runs as the operator, who cannot read the root-only receipt: the audit proves its
            # inputs against the tree's manifest and prints that manifest's digest, which the
            # controller matches with the receipt through `verify` (root) before trusting it.
            if not gt.SHA.fullmatch(a.sha):
                raise Refused(f'not a full lowercase SHA: {a.sha!r}')
            result = audit(os.path.join(roots.releases, a.sha), tempfile.gettempdir(), roots.owner)
            print(f'AUDIT {result.verdict.kind.upper()} {a.sha} tree {result.tree_sha256}: {render_verdict(result.verdict)}')
            return {'clean': 0, 'advisory': 1}.get(result.verdict.kind, EX_TEMPFAIL)
        if a.cmd in ('probe', 'trial'):
            step = (tr.probe(a.sha, roots, trial_root, runner, node, ids) if a.cmd == 'probe'
                    else tr.trial(a.sha, a.snapshot, roots, trial_root, runner, node, ids))
            print(f'{a.cmd.upper()} {step.kind.upper()} {a.sha}: {step.detail}')
            return {'ok': 0, 'failed': 1}.get(step.kind, EX_TEMPFAIL)
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
