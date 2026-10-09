"""Activation engine of the deploy controller: switch production to an accepted release and watch it (host).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §7 (ACTIVATE-001),
§10a (DEPLOYED_SHA, Pending phase/substep, settled, previous settled), §10b (crash/recovery matrix).
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2c.md, Task 3.

The engine never touches the host itself: it gets a `store` (load/save of the state v2 file,
deploy_state) and a `host` with the methods below, and every step is

    persist intent -> act -> observe -> persist the next intent (its completion).

The intent is persisted BEFORE the action, so a crash anywhere leaves a state whose intent is
the action that may or may not have run; every action is idempotent and its result is read back
from the world (unit state, `current`, /health), never assumed, so resuming is repeating the
current intent.

Host (the real adapter is the periphery's; tests use fake_host.FakeHost):
  bot_state() / litestream_state() -> systemd ActiveState ('active', 'inactive', 'failed', ...)
  stop_bot() / start_bot() / stop_litestream() / start_litestream()  -- systemctl, idempotent
  current() -> the SHA `current` points at (publish.current_sha), or None
  switch(sha)  -- publish.switch through the root helper; Refused if the tree does not verify
  health() -> Health(ok, release_sha): one /health probe, release_sha as the process read it at startup
  nrestarts() -> int, or None when it cannot be read
  boot_id() -> this boot's id;  now() -> seconds;  sleep(s)
  post(dir) -> dbsnap.post of the bot DB;  restore(pre_path, post_dir) -> dbsnap.restore
A host method raises HostError for a failure that says nothing about the candidate (sudo,
systemctl, I/O): such a step is `blocked` and the next tick repeats it. Only the window — the
candidate's own health and restarts — ever produces a verdict on the candidate.

The window keeps merge-deploy's timing (deploy/autodeploy.sh wait_healthy/watch_window):
startup — a healthy answer FROM THE CANDIDATE within STARTUP_S, probed every STARTUP_POLL_S;
then until WINDOW_S after the start, a probe every POLL_S; HEALTH_FAILS_MAX failures in a row or
a change of NRestarts roll back; a window in which NRestarts was never read is `unverified`.
Every sample is persisted, and a sample more than GAP_S after the previous one, or in another
boot, ends the window as `unverified`: a window nobody watched is not proof.
"""
import os
import sys
from dataclasses import dataclass, replace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deploy_state as ds  # noqa: E402
from deploy_state import Observe, Settled, Unverified  # noqa: E402
from safe_tar import Refused  # noqa: E402

STARTUP_S = 120
STARTUP_POLL_S = 2
WINDOW_S = 600
POLL_S = 10
HEALTH_FAILS_MAX = 3
# Three missed polls: no longer a continuous observation.
GAP_S = 30
STOPPED = ('inactive', 'failed')


class HostError(Exception):
    """A host action failed; not a verdict on the candidate. The step is repeated by a later tick."""


@dataclass(frozen=True)
class Health:
    ok: bool
    release_sha: str | None


@dataclass(frozen=True)
class Outcome:
    """What a step left. `continue`: call step again. Every other kind ends this tick's run.

    idle — nothing in flight; blocked — the host would not do the current step (state unchanged,
    repeated next tick); settled — the candidate went through its whole window; unverified — the
    window was not proven, the candidate keeps running, unattended activation is blocked.
    """
    kind: str
    state: object
    reason: str = ''


class Store:
    """The state file at path (deploy_state.load/save)."""
    def __init__(self, path):
        self.path = path

    def load(self):
        return ds.load(self.path)

    def save(self, state):
        ds.save(self.path, state)


def _short(sha):
    return sha[:7] if sha else str(sha)


def _put(store, state, kind='continue', reason=''):
    store.save(state)
    return Outcome(kind, state, reason)


def begin(store, host, candidate, pre):
    """Open an activation of candidate (a deploy_state.Release) with its pre snapshot (Pre).

    Only from a settled state that has a settled baseline to roll back to, and never for the
    SHA that failed last or the one already settled; otherwise Refused and nothing is written.
    """
    state = store.load()
    if state is None or state.phase != 'settled':
        raise Refused(f'phase is {state.phase if state else "absent (first run)"}, not settled')
    if state.settled is None:
        raise Refused('no settled baseline to roll back to')
    if candidate.sha == state.last_failed_sha:
        raise Refused(f'{candidate.sha} is the last failed SHA')
    if candidate.sha == state.settled.sha:
        raise Refused(f'{candidate.sha} is already settled')
    boot = host.boot_id()
    at = host.now()
    previous = ds.Release(state.settled.sha, state.settled.tree_sha256)
    opened = state.replace(
        phase='activating', intent='stop', boot_id=boot, txn=ds.new_txn(), candidate=candidate,
        previous=previous, pre=pre, post=None, observe=None, unverified=None, evidence=(),
    ).log(at, 'begin', 'ok', candidate=candidate.sha, previous=previous.sha, pre=pre.path)
    store.save(opened)
    return opened


def _blocked(state, what, e):
    return Outcome('blocked', state, f'{what}: {e}')


def _stop(store, host, s, boot):
    try:
        host.stop_bot()
        got = host.bot_state()
    except HostError as e:
        return _blocked(s, 'stop', e)
    if got not in STOPPED:
        return Outcome('blocked', s, f'stop: the bot is {got}')
    return _put(store, s.replace(intent='switch', boot_id=boot).log(host.now(), 'stop', 'ok'))


def _abort(store, s, boot, at, reason):
    """The candidate never started: back to previous without touching the DB, no verdict on it."""
    return _put(store, s.replace(phase='rolling-back', intent='switch-previous', boot_id=boot)
                .log(at, 'abort', reason))


def _switch(store, host, s, boot):
    sha = s.candidate.sha
    try:
        # §2: the old runtime is stopped before `current` moves; observed, not assumed.
        if host.bot_state() not in STOPPED:
            return _put(store, s.replace(intent='stop', boot_id=boot).log(host.now(), 'switch', 'bot running'))
        try:
            host.switch(sha)
            refused = None
        except Refused as e:
            refused = str(e)
        cur = host.current()
        at = host.now()
    except HostError as e:
        return _blocked(s, 'switch', e)
    if refused is not None:
        return _abort(store, s, boot, at, f'switch to {_short(sha)} refused: {refused}')
    if cur != sha:
        return _abort(store, s, boot, at, f'current is {_short(cur)} after the switch to {_short(sha)}')
    return _put(store, s.replace(intent='start', boot_id=boot).log(at, 'switch', 'ok'))


def _start(store, host, s, boot):
    sha = s.candidate.sha
    try:
        cur = host.current()
        if cur != sha:
            # Someone moved `current` after the switch was observed. The candidate may already
            # have run, so neither a restart nor an abort without the DB is safe: an operator decides.
            return Outcome('blocked', s, f'start: current is {_short(cur)}, not {_short(sha)}')
        # `start` of an active unit is a no-op in systemd; never a restart of what already runs.
        if host.bot_state() != 'active':
            host.start_bot()
        at = host.now()
    except HostError as e:
        return _blocked(s, 'start', e)
    observe = Observe(at, boot, None, None, 0, None)
    return _put(store, s.replace(phase='observing', intent=None, boot_id=boot, observe=observe)
                .log(at, 'start', 'ok'))


def _health(host):
    try:
        return host.health()
    except HostError:
        return Health(False, None)


def _nrestarts(host):
    try:
        return host.nrestarts()
    except HostError:
        return None


def _describe(h):
    return f'ok={h.ok} releaseSha={_short(h.release_sha)}'


def _unverified(store, s, boot, at, reason):
    return _put(store, s.replace(phase='unverified', intent=None, boot_id=boot,
                                 unverified=Unverified(s.candidate.sha, reason, s.pre))
                .log(at, 'unverified', reason), 'unverified', reason)


def _to_rollback(store, s, boot, at, reason):
    """The candidate failed its window: it IS the failed SHA, recorded with the first rollback intent."""
    return _put(store, s.replace(phase='rolling-back', intent='stop-writers', boot_id=boot,
                                 last_failed_sha=s.candidate.sha).log(at, 'rollback', reason))


def _settle(store, s, boot, at):
    c = s.candidate
    done = s.replace(phase='settled', intent=None, boot_id=boot, txn=None, candidate=None, previous=None,
                     pre=None, post=None, observe=None, unverified=None,
                     settled=Settled(c.sha, c.tree_sha256, at)).log(at, 'settled', 'ok', sha=c.sha)
    return _put(store, done, 'settled')


def _observe(store, host, s, boot):
    o, sha = s.observe, s.candidate.sha
    now = host.now()
    if boot != o.boot_id:
        return _unverified(store, s, boot, now, f'reboot during the window (boot {o.boot_id} -> {boot})')
    last = o.last_sample_at if o.last_sample_at is not None else o.started_at
    if now - last > GAP_S:
        return _unverified(store, s, boot, now, f'no sample for {now - last:g} s (over {GAP_S} s)')
    t = now - o.started_at
    if o.healthy_at is None:
        h = _health(host)
        if h.ok and h.release_sha == sha:
            s = s.replace(observe=replace(o, last_sample_at=now, healthy_at=now)).log(now, 'healthy', 'ok', t=t)
            pause = POLL_S
        elif t >= STARTUP_S:
            return _to_rollback(store, s, boot, now,
                                f'not healthy as {_short(sha)} within {STARTUP_S} s (last: {_describe(h)})')
        else:
            s, pause = s.replace(observe=replace(o, last_sample_at=now)), STARTUP_POLL_S
        _put(store, s)
        host.sleep(pause)
        return Outcome('continue', s)
    if t >= WINDOW_S:
        if o.nrestarts0 is None:
            return _unverified(store, s, boot, now, 'NRestarts could not be read once during the window')
        return _settle(store, s, boot, now)
    h = _health(host)
    fails = 0 if h.ok and h.release_sha == sha else o.fails + 1
    if fails >= HEALTH_FAILS_MAX:
        return _to_rollback(store, s, boot, now,
                            f'health failed {fails} times in a row (last at +{t:g} s: {_describe(h)})')
    n0, r = o.nrestarts0, _nrestarts(host)
    if r is not None and n0 is not None and r != n0:
        return _to_rollback(store, s, boot, now, f'service restarted (NRestarts {n0} -> {r}) at +{t:g} s')
    # An unreadable NRestarts is neither a change nor a pass; the baseline is the first reading.
    s = s.replace(observe=replace(o, last_sample_at=now, fails=fails, nrestarts0=r if n0 is None else n0))
    _put(store, s)
    host.sleep(POLL_S)
    return Outcome('continue', s)


_STEPS = {
    ('activating', 'stop'): _stop,
    ('activating', 'switch'): _switch,
    ('activating', 'start'): _start,
    ('observing', None): _observe,
}


def step(store, host):
    """Do the current intent once and persist what follows; see Outcome for the kinds."""
    s = store.load()
    if s is None or s.phase == 'settled':
        return Outcome('idle', s)
    if s.phase in ('unverified', 'recovery-failed'):
        return Outcome(s.phase, s, s.unverified.reason if s.unverified else '')
    try:
        return _STEPS[(s.phase, s.intent)](store, host, s, host.boot_id())
    except HostError as e:
        # The clock, the boot id or a sleep failed: nothing was judged, the next tick repeats.
        return Outcome('blocked', s, f'{s.phase}/{s.intent}: {e}')


def run(store, host):
    """step until an Outcome other than `continue`."""
    while True:
        out = step(store, host)
        if out.kind != 'continue':
            return out
