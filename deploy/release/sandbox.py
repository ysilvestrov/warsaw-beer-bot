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
# Margin over RuntimeMaxSec for systemd-run itself to return after the stop.
WAIT_MARGIN_S = 30


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
        f'RuntimeMaxSec={RUNTIME_MAX_S[kind]}', 'KillMode=control-group',
        'Environment=PATH=/usr/bin:/bin', f'Environment=HOME={scratch}', f'Environment=TMPDIR={scratch}/tmp',
        f'Environment=WBB_PAYLOAD={release}', 'Environment=DOTENV_CONFIG_PATH=/dev/null',
    ]
    argv = [SYSTEMD_RUN, '--wait', '--pipe', '--collect', '--quiet', f'--unit={unit}']
    for p in props:
        argv += ['-p', p]
    return argv + [node, probe, *args]


def run_sandboxed(kind, sha, release, scratch, probe, args, runner=subprocess.run, node=NODE):
    """(exit status, stdout) of the probe in the sandbox; Transient if systemd could not run it."""
    unit = unit_name(kind, sha)
    argv = sandbox_argv(kind, sha, release, scratch, probe, args, unit, node)
    try:
        r = runner(argv, capture_output=True, text=True, check=False,
                   timeout=RUNTIME_MAX_S[kind] + WAIT_MARGIN_S, stdin=subprocess.DEVNULL)
    except FileNotFoundError:
        raise Transient('systemd-run is not available') from None
    except subprocess.TimeoutExpired:
        raise Transient(f'systemd-run did not return within {RUNTIME_MAX_S[kind] + WAIT_MARGIN_S} s') from None
    state = runner([SYSTEMCTL, 'show', '--property=ActiveState,SubState', unit],
                   capture_output=True, text=True, check=False, timeout=10)
    # A collected unit is unknown to systemd ("inactive"/"dead" with no cgroup either way).
    if state.stdout.split() not in (['ActiveState=inactive', 'SubState=dead'], []):
        raise Refused(f'sandbox unit {unit} is still {state.stdout.split()} — its cgroup is not empty')
    return r.returncode, r.stdout
