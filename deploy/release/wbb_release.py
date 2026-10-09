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
       wbb_release.py switch  --sha <full sha>                            (root; points `current` at it)
       wbb_release.py audit   --sha <full sha>                            (operator, never root)
       wbb_release.py probe   --sha <full sha>                            (root; runs the sandbox)
       wbb_release.py trial   --sha <full sha> --snapshot <name>-pre.db   (root; runs the sandbox)
The snapshot is a NAME in SNAPSHOT_ROOT, never a path.

Output: one verdict line on stdout — `VERIFIED <sha>: tree <hex> ...`, `ACCEPTED|ALREADY-ACCEPTED <sha>: ...`,
`SWITCHED|CURRENT <sha> tree <hex>` (CURRENT: `current` already pointed there, nothing changed; tree: the
receipt's treeSha256 the tree was verified against, which the controller compares with its record),
`AUDIT <KIND> <sha> tree <hex>` (details from the next line on), `PROBE|TRIAL <KIND> <sha>: <detail>`
followed, when the Node identity is known, by `NODE <realpath> <sha256> <version> <modules>`.
Exit (2b review B1; the controller records a failed SHA only on 1 together with its verdict line):
   0  done / ok / clean
   1  ONLY the candidate is bad: `PROBE FAILED`, `TRIAL FAILED` or `AUDIT ADVISORY` is on stdout
   2  refused: an input or a precondition (no receipt, changed tree, bad name; `REFUSED:` on stderr) —
      not a verdict on the candidate
  64  usage
  70  internal error (a traceback on stderr) — not a verdict on the candidate
  75  could not judge now — retry, never a failed SHA (EX_TEMPFAIL): no wbb-trial user, no scratch,
      a unit systemd did not start, another wbb-trial unit loaded, an audit with no report
Only `switch` touches the `current` pointer (after re-verifying the tree against its receipt);
nothing here starts or stops a unit or touches a database.
"""
import argparse
import os
import stat
import subprocess
import sys
import tempfile
import traceback

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
# Where db-snapshot.sh keeps the pre snapshots; `trial --snapshot` names one in it (2b review S2).
SNAPSHOT_ROOT = '/var/lib/warsaw-beer-bot/deploy-snapshots'
EX_FAILED = 1
EX_REFUSED = 2
EX_USAGE = 64
EX_SOFTWARE = 70
EX_TEMPFAIL = 75
STEP_EXIT = {'ok': 0, 'failed': EX_FAILED, 'transient': EX_TEMPFAIL}
AUDIT_EXIT = {'clean': 0, 'advisory': EX_FAILED, 'unrunnable': EX_TEMPFAIL}
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


def _parser():
    ap = argparse.ArgumentParser(prog='wbb_release.py', description='Accept, audit, probe, trial or switch to a release.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('publish')
    p.add_argument('--sha', required=True)
    p.add_argument('--archive', required=True)
    for name in ('verify', 'audit', 'probe', 'switch'):
        sub.add_parser(name).add_argument('--sha', required=True)
    t = sub.add_parser('trial')
    t.add_argument('--sha', required=True)
    t.add_argument('--snapshot', required=True, help='a <name>-pre.db in ' + SNAPSHOT_ROOT)
    return ap


def _print_step(cmd, sha, step):
    print(f'{cmd.upper()} {step.kind.upper()} {sha}: {step.detail}')
    if step.node is not None:
        # 2b review B3: the controller compares this Node with the one it is about to start the bot on.
        n = step.node
        print(f'NODE {n.realpath} {n.sha256} {n.version} {n.modules}')
    return STEP_EXIT[step.kind]


def _run(a, roots, token_file, api_factory, trial_root, snapshot_root, runner, node, ids, audit, glibc):
    if a.cmd == 'verify':
        receipt = pub.verify_release(a.sha, roots)
        print(f'VERIFIED {a.sha}: tree {receipt["treeSha256"]} (run {receipt["runId"]} attempt {receipt["runAttempt"]})')
        return 0
    if a.cmd == 'switch':
        kind, tree = pub.switch(a.sha, roots)
        print(f'{kind.upper()} {a.sha} tree {tree}')
        return 0
    if a.cmd == 'audit':
        # Runs as the operator, who cannot read the root-only receipt: the audit proves its
        # inputs against the tree's manifest and prints that manifest's digest, which the
        # controller matches with the receipt through `verify` (root) before trusting it.
        if not gt.SHA.fullmatch(a.sha):
            raise Refused(f'not a full lowercase SHA: {a.sha!r}')
        result = audit(os.path.join(roots.releases, a.sha), tempfile.gettempdir(), roots.owner)
        # 2b review S3: the first line is fixed; npm's details, one or many lines, come after it.
        print(f'AUDIT {result.verdict.kind.upper()} {a.sha} tree {result.tree_sha256}')
        print(render_verdict(result.verdict))
        return AUDIT_EXIT[result.verdict.kind]
    if a.cmd == 'probe':
        return _print_step(a.cmd, a.sha, tr.probe(a.sha, roots, trial_root, runner, node, ids, glibc))
    if a.cmd == 'trial':
        return _print_step(a.cmd, a.sha, tr.trial(a.sha, a.snapshot, roots, trial_root, snapshot_root, runner, node,
                                                  ids, glibc))
    api = api_factory(read_token(token_file))
    trusted = gt.fetch_trusted(api, gt.REPO, a.sha)
    outcome = pub.publish(trusted, a.archive, roots)
    print(f'{outcome.upper()} {a.sha}: run {trusted.run_id} attempt {trusted.run_attempt}, artifact {trusted.artifact_id}')
    return 0


def main(argv, roots=PRODUCTION_ROOTS, token_file=TOKEN_FILE, api_factory=gt.GitHubApi, trial_root=TRIAL_ROOT,
         runner=bounded.run, node=sb.NODE, ids=tr.trial_ids, audit=host_audit.audit_release,
         snapshot_root=SNAPSHOT_ROOT, glibc=tr.host_glibc):
    try:
        a = _parser().parse_args(argv)
    except SystemExit as e:
        return EX_USAGE if e.code else 0
    try:
        return _run(a, roots, token_file, api_factory, trial_root, snapshot_root, runner, node, ids, audit, glibc)
    except (Refused, gt.Untrusted) as e:
        # Not a verdict on the candidate: nothing here may be recorded as its failure (2b review B1).
        print(f'REFUSED: {e}', file=sys.stderr)
        return EX_REFUSED
    except Exception:
        # Before this, a Python traceback exited 1 — the code of a bad candidate (2b review B1).
        traceback.print_exc()
        return EX_SOFTWARE


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
