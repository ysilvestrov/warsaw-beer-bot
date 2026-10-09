"""Run the installed payload probe against a release inside the fixed `wbb-trial` sandbox.

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §2
("Probe/trial SHALL виконуватися як окремий system user wbb-trial ..."), §4, §6.
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2b.md, Task 3.

The first execution of candidate code happens here and only here. The unit's
properties are a constant list: the caller supplies a validated SHA and a scratch
directory the root helper created, never a property, an executable or a path to
run. systemd-run --wait returns when the unit has stopped; KillMode=control-group
plus RuntimeMaxSec end every descendant on timeout, and the unit is checked to be
gone before the scratch is trusted again. Gate G2 (a VPS probe of exactly these
properties) decides whether the list is final.
"""
import hashlib
import os
import re
import secrets
import subprocess
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounded  # noqa: E402
from github_trust import SHA  # noqa: E402
from safe_tar import Refused  # noqa: E402

SYSTEMD_RUN = '/usr/bin/systemd-run'
SYSTEMCTL = '/usr/bin/systemctl'
NODE = '/usr/bin/node'
TRIAL_USER = 'wbb-trial'
RUNTIME_MAX_S = {'probe': 30, 'trial': 120}
INACCESSIBLE = ('/etc/warsaw-beer-bot', '/etc/wbb-deploy', '/var/lib/warsaw-beer-bot', '/var/lib/wbb-deploy')
# Bounded stop: SIGTERM, then SIGKILL to the whole cgroup after this (systemd's default is 90 s).
STOP_TIMEOUT_S = 10
# Margin over RuntimeMaxSec + stop for systemd-run itself to return.
WAIT_MARGIN_S = 30
# How long `systemctl stop` may take before the stop counts as unconfirmed.
STOP_WAIT_S = STOP_TIMEOUT_S + WAIT_MARGIN_S


class Transient(Exception):
    """The sandbox could not be run at all (systemd unavailable): retry later, not a verdict on the SHA."""


@dataclass(frozen=True)
class NodeIdentity:
    realpath: str
    sha256: str
    version: str
    modules: str


def node_identity(node=NODE, runner=bounded.run):
    """Which Node binary the probe runs on, so the controller can tell if it changed before stop/start."""
    real = os.path.realpath(node)
    h = hashlib.sha256()
    with open(real, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    out = runner([real, '-p', 'process.version + " " + process.versions.modules'],
                 capture_output=True, text=True, timeout=10, check=True, env={'PATH': '/usr/bin:/bin'})
    version, modules = out.stdout.split()
    return NodeIdentity(real, h.hexdigest(), version.lstrip('v'), modules)


def unit_name(kind, sha):
    return f'wbb-trial-{kind}-{sha[:12]}-{secrets.token_hex(4)}'


# Gate G2 (VPS, systemd 255): systemd-run rewrites $NAME / ${NAME} in the command line from
# the environment, silently, and resolves %-specifiers. Every value we splice into the
# argv or a property is a path or name of our own making, so anything carrying one of
# those characters (or whitespace) is refused rather than escaped: it was never meant to be there.
UNSAFE = re.compile(r'[$%\s\\\x00-\x1f\x7f]')
# Gate G2: PrivateTmp=yes hides /tmp and /var/tmp inside the unit; a scratch under them
# makes the unit die with 226/NAMESPACE before the probe starts.
HIDDEN_BY_PRIVATE_TMP = ('/tmp', '/var/tmp')


def _check_value(what, value):
    if not isinstance(value, str) or value == '' or UNSAFE.search(value):
        raise Refused(f'{what} {value!r} is empty or has a character systemd would rewrite')


def sandbox_argv(kind, sha, release, scratch, probe, args, unit, node=NODE):
    if kind not in RUNTIME_MAX_S:
        raise Refused(f'unknown sandbox kind {kind!r}')
    if not SHA.fullmatch(sha) or os.path.basename(release) != sha:
        raise Refused(f'release path {release!r} is not releases/<{sha}>')
    for what, value in (('release', release), ('scratch', scratch), ('probe', probe), ('node', node), ('unit', unit),
                        *(('argument', a) for a in args)):
        _check_value(what, value)
    for path in (release, scratch, probe, node):
        if not os.path.isabs(path):
            raise Refused(f'{path!r} is not an absolute path')
    norm = os.path.normpath(scratch)
    if any(norm == d or norm.startswith(d + '/') for d in HIDDEN_BY_PRIVATE_TMP):
        raise Refused(f'scratch {scratch!r} is under /tmp or /var/tmp, which PrivateTmp hides from the unit')
    props = [
        f'User={TRIAL_USER}', f'Group={TRIAL_USER}',
        'PrivateNetwork=yes', 'ProtectHome=yes', 'NoNewPrivileges=yes', 'ProtectSystem=strict',
        'PrivateTmp=yes', 'PrivateDevices=yes',
        # #817 AI review: other users' processes (and their /proc/<pid>/cmdline) stay invisible.
        'ProtectProc=invisible',
        *(f'InaccessiblePaths=-{p}' for p in INACCESSIBLE),
        f'ReadWritePaths={scratch}', f'WorkingDirectory={scratch}',
        'CapabilityBoundingSet=', 'AmbientCapabilities=',
        'MemoryMax=768M', 'CPUQuota=100%', 'TasksMax=64',
        f'RuntimeMaxSec={RUNTIME_MAX_S[kind]}', f'TimeoutStopSec={STOP_TIMEOUT_S}s', 'KillMode=control-group',
        'Environment=PATH=/usr/bin:/bin', f'Environment=HOME={scratch}', f'Environment=TMPDIR={scratch}/tmp',
        f'Environment=WBB_PAYLOAD={release}', 'Environment=DOTENV_CONFIG_PATH=/dev/null',
    ]
    # No --quiet: systemd-run's "Finished with result:" line is how a unit that ran is told
    # apart from one systemd never started.
    argv = [SYSTEMD_RUN, '--wait', '--pipe', '--collect', f'--unit={unit}']
    for p in props:
        argv += ['-p', p]
    return argv + [node, probe, *args]


@dataclass(frozen=True)
class Ran:
    """The unit ran: systemd's own verdict on it, and the probe's stdout (kept apart from systemd's)."""
    result: str      # systemd's "Finished with result:", e.g. success, exit-code, timeout, oom-kill
    exit: int
    stdout: str


class Unconfirmed(Transient):
    """The unit could not be confirmed stopped: its scratch must be kept, not removed."""


# Not anchored at the line start (2v review): with --pipe the candidate's stderr may end without
# a newline, and systemd-run's footer is then glued to it ("xFinished with result: exit-code").
FINISHED = re.compile(r'Finished with result: (\S+)$', re.M)
LIST_UNITS_S = 10


def no_trial_units(runner=bounded.run):
    """Raise Transient unless systemd shows no wbb-trial-* unit at all (2b review S1).

    ProtectProc=invisible does not hide processes of the same user (gate G3), so two units
    alive at once would see each other: an unconfirmed unit from an earlier tick must be
    gone before the next one starts. A listing that cannot be had proves nothing.
    """
    try:
        r = runner([SYSTEMCTL, 'list-units', '--all', '--plain', '--no-legend', 'wbb-trial-*'],
                   capture_output=True, text=True, check=False, timeout=LIST_UNITS_S)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Transient(f'cannot list wbb-trial units ({type(e).__name__})') from None
    if r.returncode != 0:
        raise Transient(f'cannot list wbb-trial units (systemctl exit {r.returncode})')
    units = [line.split()[0] for line in r.stdout.splitlines() if line.strip()]
    if units:
        raise Transient(f'wbb-trial unit(s) still loaded, not starting another: {" ".join(units)}')


def confirm_stopped(unit, runner=bounded.run):
    """Stop unit (idempotent) and confirm systemd reports it gone or inactive. False if that cannot be shown."""
    try:
        runner([SYSTEMCTL, 'stop', unit], capture_output=True, text=True, check=False, timeout=STOP_WAIT_S)
        state = runner([SYSTEMCTL, 'show', '--property=LoadState,ActiveState', unit],
                       capture_output=True, text=True, check=False, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    if state.returncode != 0:
        return False
    props = dict(line.split('=', 1) for line in state.stdout.splitlines() if '=' in line)
    # A collected transient unit reads LoadState=not-found; a lingering one must be inactive or failed.
    return props.get('ActiveState') in ('inactive', 'failed') and props.get('LoadState') in ('not-found', 'loaded')


def run_sandboxed(kind, sha, release, scratch, probe, args, runner=bounded.run, node=NODE):
    """Run the probe in the sandbox and confirm the unit is stopped on every path.

    Returns Ran when systemd ran the unit to an end. Raises Transient when systemd could
    not run it (no binary, no bus, systemd-run hanging, another wbb-trial unit loaded) and
    Unconfirmed when the unit cannot be shown stopped afterwards — then the caller must
    keep the scratch. Unconfirmed also replaces any other exception (a Ctrl-C while
    waiting): whatever was in flight, a unit that may be alive keeps its scratch.
    """
    unit = unit_name(kind, sha)
    argv = sandbox_argv(kind, sha, release, scratch, probe, args, unit, node)
    no_trial_units(runner)
    limit = RUNTIME_MAX_S[kind] + STOP_TIMEOUT_S + WAIT_MARGIN_S
    created = True
    failure = None
    ran = None
    try:
        r = runner(argv, capture_output=True, text=True, check=False, timeout=limit, stdin=subprocess.DEVNULL)
        # The last match (2b review N1): with --pipe the candidate writes to this same stream
        # and can print the line too, but systemd-run's own footer comes after the unit ended.
        found = FINISHED.findall(r.stderr or '')
        if found:
            ran = Ran(found[-1], r.returncode, r.stdout)
        else:
            # No result line: systemd never ran the unit (e.g. "Failed to connect to bus").
            failure = f'systemd-run did not run the unit (exit {r.returncode}): {(r.stderr or "").strip()[-500:]!r}'
    except OSError as e:
        # exec of systemd-run itself failed (missing, not executable, out of resources): the
        # process never started, so no unit was ever created — nothing to stop or confirm.
        created = False
        raise Transient(f'systemd-run could not start ({e.strerror or type(e).__name__})') from None
    except subprocess.TimeoutExpired:
        failure = f'systemd-run did not return within {limit} s'
    finally:
        # 2b review N2: on every way out, an exception that is not ours included, the unit is
        # stopped and confirmed before the caller may remove its scratch.
        if created and not confirm_stopped(unit, runner):
            raise Unconfirmed(f'sandbox unit {unit} could not be confirmed stopped' + (f' ({failure})' if failure else ''))
    if failure:
        raise Transient(failure)
    return ran
