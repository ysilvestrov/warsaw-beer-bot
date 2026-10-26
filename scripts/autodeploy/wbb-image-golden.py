#!/usr/bin/env python3
"""Golden outputs of the root helper wbb-image, made by its own main() with a fake host.

Plan: docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md, "Рішення" п.9, Task 0.
The image controller parses the helper's output by (exit code, line), per action. Its parsers are tested on
these files, so they read what the helper really prints, not what a test author thinks it prints;
scripts/autodeploy/wbb-image-golden.test.ts regenerates them and fails on any difference.

Usage: python3 -B scripts/autodeploy/wbb-image-golden.py <output dir>
       (the committed set: python3 -B scripts/autodeploy/wbb-image-golden.py scripts/autodeploy/fixtures/wbb-image)

Each <case>.txt is
    exit=<code>
    --- stdout
    <stdout, verbatim>--- stderr
    <stderr, verbatim>
where stdout and stderr are empty or end with a newline. Digests, SHAs and ids are fixed; paths of the fake host
(temporary directories) never reach the output of the cases chosen here.
"""
import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'deploy', 'image', 'helper'))
import wbb_image as wi  # noqa: E402

REPO = wi.REPOSITORY
REV = wi.REVISION_LABEL
X = '1111111111111111111111111111111111111111'      # the candidate's commit
S_SHA = '2222222222222222222222222222222222222222'  # the settled image's commit
D = 'sha256:' + 'd' * 64                          # the candidate's digest
S = 'sha256:' + '5' * 64                          # the settled digest
I_D = 'a' * 64
I_S = 'b' * 64
C_D = 'c' * 64
C_S = 'e' * 64
SNAPSHOT = '20261012T101500Z-1111111-pre.db'
SNAPSHOT_BYTES = b'SQLite format 3\x00 golden pre snapshot'
# What scripts/autodeploy/audit-verdict-cli.ts prints for scripts/autodeploy/fixtures/npm-audit/advisory.json
# (the golden test checks this against the real CLI).
NPM_ADVISORY = ('proxy-addr critical — proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet '
                'https://github.com/advisories/GHSA-jqcg-44mw-7w3h\n')


def done(code=0, stdout='', stderr=''):
    return subprocess.CompletedProcess(['scripted'], code, stdout, stderr)


def inspect(digest, image_id, revision, content):
    return done(stdout=json.dumps([{'Id': image_id, 'Digest': digest, 'RepoDigests': [f'{REPO}@{digest}'],
                                    'Labels': {REV: revision, 'wbb.content': content}}]))


INSPECT_D = inspect(D, I_D, X, C_D)
INSPECT_S = inspect(S, I_S, S_SHA, C_S)
NOT_KNOWN = done(125, stderr=f'Error: {REPO}@{D}: image not known\n')
TRIAL_OK = done(stdout='TRIAL OK: schema 46 -> 47\n')
START_OK_D = done(stdout=f'START OK {X}\n')
START_OK_S = done(stdout=f'START OK {S_SHA}\n')
RM = done()


class Runner:
    def __init__(self, responses):
        self.responses = list(responses)

    def __call__(self, argv, *, timeout, text=False, **kwargs):
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


class FakeHost:
    """Temporary directories standing in for the host's roots; the bot is this process's own user."""

    def __init__(self, work):
        self.work = work
        self.quadlet = os.path.join(work, 'systemd', 'warsaw-beer-bot.container')
        self.template = os.path.join(work, 'template.container')
        self.snapshots = os.path.join(work, 'snapshots')
        self.scratch = os.path.join(work, 'scratch')
        os.makedirs(os.path.dirname(self.quadlet))
        os.mkdir(self.snapshots)
        os.mkdir(self.scratch, 0o700)
        os.chmod(self.scratch, 0o700)
        with open(self.template, 'w', encoding='utf-8') as f:
            f.write(f'[Container]\nImage={REPO}@@@DIGEST@@\nUser=@@UID@@\nGroup=@@GID@@\n')
        snapshot = os.path.join(self.snapshots, SNAPSHOT)
        with open(snapshot, 'wb') as f:
            f.write(SNAPSHOT_BYTES)
        with open(snapshot + '.sha256', 'w', encoding='ascii') as f:
            f.write(hashlib.sha256(SNAPSHOT_BYTES).hexdigest() + '\n')

    def host(self, responses):
        return wi.Host(podman='/usr/bin/podman', systemctl='/usr/bin/systemctl', run=Runner(responses),
                       quadlet_path=self.quadlet, template_path=self.template, snapshot_root=self.snapshots,
                       scratch_root=self.scratch, containers_root='/var/lib/containers',
                       free_bytes=lambda path: 100 * 1024 ** 3, bot_ids=lambda: (os.getuid(), os.getgid()),
                       fchown=lambda fd, uid, gid: None, scratch_owner=os.getuid(), pid=lambda: 4242)

    def show(self, load, ours):
        source = self.quadlet if ours else ''
        fragment = '/run/systemd/generator/warsaw-beer-bot.service' if ours else '/etc/systemd/system/x.service'
        return done(stdout=f'LoadState={load}\nSourcePath={source}\nFragmentPath={fragment}\n')

    def write_quadlet(self, digest):
        with open(self.quadlet, 'w', encoding='utf-8') as f:
            f.write(f'[Container]\nImage={REPO}@{digest}\n')


TRIAL = ['trial', '--digest', D, '--previous', S, '--snapshot', SNAPSHOT]


def cases(fake):
    """(name, argv, scripted responses, setup) for every (exit, line) combination the controller parses."""
    ours, absent = fake.show('loaded', True), fake.show('not-found', False)
    container = done(stdout=f'{I_S} {S}\n')
    return [
        ('pull-pulled', ['pull', '--sha', X, '--digest', D], [done(), INSPECT_D], None),
        ('pull-refused', ['pull', '--sha', X, '--digest', D], [done(), inspect(D, I_D, S_SHA, C_D)], None),
        ('pull-tempfail', ['pull', '--sha', X, '--digest', D],
         [done(125, stderr='Error: initializing source docker://ghcr.io/ysilvestrov/warsaw-beer-bot: '
                           'pinging container registry ghcr.io: connection refused\n')], None),
        ('local-local', ['local', '--digest', S], [INSPECT_S], None),
        ('local-not-local', ['local', '--digest', D], [NOT_KNOWN], None),
        ('audit-clean', ['audit', '--digest', D],
         [INSPECT_D, done(stdout='npm audit: no high or critical advisory in production dependencies\n'), RM], None),
        ('audit-advisory', ['audit', '--digest', D], [INSPECT_D, done(10, stdout=NPM_ADVISORY), RM], None),
        ('trial-ok', TRIAL, [INSPECT_D, INSPECT_S, TRIAL_OK, RM, START_OK_D, RM, START_OK_S, RM], None),
        ('trial-trial-failed', TRIAL,
         [INSPECT_D, INSPECT_S, done(1, stdout='TRIAL FAILED: no such column: venue_id\n'), RM], None),
        ('trial-start-failed', TRIAL,
         [INSPECT_D, INSPECT_S, TRIAL_OK, RM,
          done(1, stdout='START FAILED: /health answered {"ok":false}\noutput tail:\nbot launched\n'), RM], None),
        ('trial-compat-failed', TRIAL,
         [INSPECT_D, INSPECT_S, TRIAL_OK, RM, START_OK_D, RM,
          done(1, stdout='START FAILED: bot exited (code 1) before "api listening"\noutput tail:\n'
                         'SqliteError: no such column: venue\n'), RM], None),
        ('trial-compat-failed-start-timeout', TRIAL,
         [INSPECT_D, INSPECT_S, TRIAL_OK, RM, START_OK_D, RM,
          done(75, stdout='START TIMEOUT: no "api listening" within 90s\noutput tail:\nbot launched\n'), RM], None),
        ('trial-refused', TRIAL,
         [INSPECT_D, INSPECT_S, TRIAL_OK, RM, START_OK_D, RM,
          done(64, stderr='usage: start-check.cjs [--timeout <seconds>] [--entry <file>]\n'), RM], None),
        ('trial-tempfail', TRIAL,
         [INSPECT_D, INSPECT_S, TRIAL_OK, RM,
          done(75, stdout='START KILLED: bot killed by SIGKILL (out of memory?)\noutput tail:\n'), RM], None),
        ('activate-activated', ['activate', '--digest', D], [INSPECT_D, ours, done(), ours, done(), done()],
         lambda: fake.write_quadlet(S)),
        ('activate-failed', ['activate', '--digest', D],
         [INSPECT_D, ours, done(), ours, done(),
          done(1, stderr='Job for warsaw-beer-bot.service failed because the control process exited with error code.\n'
                         'See "systemctl status warsaw-beer-bot.service" and "journalctl -xeu warsaw-beer-bot.service" '
                         'for details.\n')],
         lambda: fake.write_quadlet(S)),
        ('current-quadlet', ['current'], [container, ours], lambda: fake.write_quadlet(S)),
        ('current-foreign', ['current'], [container, fake.show('loaded', False)], lambda: fake.write_quadlet(S)),
        ('current-absent', ['current'], [done(125, stderr='Error: no such container warsaw-beer-bot\n'), absent],
         None),
    ]


def render(code, stdout, stderr):
    for name, text in (('stdout', stdout), ('stderr', stderr)):
        if text and not text.endswith('\n'):
            raise ValueError(f'{name} does not end with a newline: {text!r}')
    return f'exit={code}\n--- stdout\n{stdout}--- stderr\n{stderr}'


def run_case(name):
    """One case on a fake host of its own: its responses name that host's Quadlet path (`systemctl show`)."""
    work = tempfile.mkdtemp(prefix='wbb-image-golden-')
    try:
        fake = FakeHost(work)
        _, argv, responses, setup = next(c for c in cases(fake) if c[0] == name)
        if setup is not None:
            setup()
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = wi.main(argv, fake.host(responses))
        return render(code, out.getvalue(), err.getvalue())
    finally:
        shutil.rmtree(work)


def main(argv):
    if len(argv) != 1:
        print('usage: wbb-image-golden.py <output dir>', file=sys.stderr)
        return 64
    out_dir = argv[0]
    os.makedirs(out_dir, exist_ok=True)
    probe = tempfile.mkdtemp(prefix='wbb-image-golden-')
    try:
        names = [c[0] for c in cases(FakeHost(probe))]
    finally:
        shutil.rmtree(probe)
    for name in names:
        text = run_case(name)
        with open(os.path.join(out_dir, f'{name}.txt'), 'w', encoding='utf-8') as f:
            f.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
