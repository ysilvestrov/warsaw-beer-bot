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


def node_identity(node=NODE, runner=subprocess.run):
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


def sandbox_argv(kind, sha, release, scratch, probe, args, unit, node=NODE):
    if kind not in RUNTIME_MAX_S:
        raise Refused(f'unknown sandbox kind {kind!r}')
    if not SHA.fullmatch(sha) or os.path.basename(release) != sha:
        raise Refused(f'release path {release!r} is not releases/<{sha}>')
    props = [
        f'User={TRIAL_USER}', f'Group={TRIAL_USER}',
        'PrivateNetwork=yes', 'ProtectHome=yes', 'NoNewPrivileges=yes', 'ProtectSystem=strict',
        'PrivateTmp=yes', 'PrivateDevices=yes',
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


FINISHED = re.compile(r'^Finished with result: (\S+)$', re.M)


def confirm_stopped(unit, runner=subprocess.run):
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


def run_sandboxed(kind, sha, release, scratch, probe, args, runner=subprocess.run, node=NODE):
    """Run the probe in the sandbox and confirm the unit is stopped on every path.

    Returns Ran when systemd ran the unit to an end. Raises Transient when systemd could
    not run it (no binary, no bus, systemd-run hanging) and Unconfirmed when the unit
    cannot be shown stopped afterwards — then the caller must keep the scratch.
    """
    unit = unit_name(kind, sha)
    argv = sandbox_argv(kind, sha, release, scratch, probe, args, unit, node)
    failure = None
    ran = None
    try:
        r = runner(argv, capture_output=True, text=True, check=False,
                   timeout=RUNTIME_MAX_S[kind] + STOP_TIMEOUT_S + WAIT_MARGIN_S, stdin=subprocess.DEVNULL)
        m = FINISHED.search(r.stderr or '')
        if m:
            ran = Ran(m.group(1), r.returncode, r.stdout)
        else:
            # No result line: systemd never ran the unit (e.g. "Failed to connect to bus").
            failure = f'systemd-run did not run the unit (exit {r.returncode}): {(r.stderr or "").strip()[-500:]!r}'
    except FileNotFoundError:
        # The binary never started, so no unit was ever created: nothing to stop or confirm.
        raise Transient('systemd-run is not available') from None
    except subprocess.TimeoutExpired:
        failure = f'systemd-run did not return within {RUNTIME_MAX_S[kind] + STOP_TIMEOUT_S + WAIT_MARGIN_S} s'
    if not confirm_stopped(unit, runner):
        raise Unconfirmed(f'sandbox unit {unit} could not be confirmed stopped' + (f' ({failure})' if failure else ''))
    if failure:
        raise Transient(failure)
    return ran
