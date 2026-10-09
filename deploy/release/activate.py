"""Activation and rollback engine of the deploy controller (host, as the operator).

Switches production to an accepted release, watches it, and puts code AND database back when it
fails its window — so that a crash at any point leaves a state the next tick finishes.

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §7 (ACTIVATE-001),
§8 (ROLLBACK-001), §10a (DEPLOYED_SHA, Pending phase/substep, settled, previous settled), §10b (crash/recovery matrix).
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2c.md, Tasks 3-4.

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
import time
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
    window was not proven, the candidate keeps running, unattended activation is blocked;
    rolled-back — the candidate failed its window, code and DB are back on the previous settled
    release and the candidate is lastFailedSha; aborted — the candidate never started (its switch
    failed), the previous release runs again on the untouched DB, no verdict on the candidate;
    recovery-failed — a rollback step a retry cannot fix, evidence kept, nothing new starts;
    drift — settled, but `current` or the running process is another release (no action).
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


def _utc(seconds):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(seconds))


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
    if o.last_sample_at is not None:
        # The pause comes BEFORE the probe, measured from the persisted sample: a tick that died
        # between saving a sample and sleeping must not probe again at once (a second failure
        # at the same moment would count as a run of failures).
        due = o.last_sample_at + (POLL_S if o.healthy_at is not None else STARTUP_POLL_S)
        if now < due:
            host.sleep(due - now)
            now = host.now()
    t = now - o.started_at
    if o.healthy_at is None:
        h = _health(host)
        if h.ok and h.release_sha == sha:
            return _put(store, s.replace(observe=replace(o, last_sample_at=now, healthy_at=now))
                        .log(now, 'healthy', 'ok', t=t))
        if t >= STARTUP_S:
            return _to_rollback(store, s, boot, now,
                                f'not healthy as {_short(sha)} within {STARTUP_S} s (last: {_describe(h)})')
        return _put(store, s.replace(observe=replace(o, last_sample_at=now)))
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
    return _put(store, s.replace(observe=replace(o, last_sample_at=now, fails=fails,
                                                 nrestarts0=r if n0 is None else n0)))


def _verdict(s):
    """The candidate started and failed its window: the rollback restores the DB, it is the failed SHA."""
    return s.last_failed_sha == s.candidate.sha


def post_dir(pre_path):
    """Where the rollback keeps the post DB: fixed by the pre snapshot, so a retry finds the same one."""
    stem = pre_path[:-len('-pre.db')] if pre_path.endswith('-pre.db') else pre_path
    return stem + '-rollback-post'


def _writers_stopped(host):
    return host.bot_state() in STOPPED and host.litestream_state() in STOPPED


def _failed(store, s, boot, at, what, reason):
    """A rollback step a retry cannot fix: keep the phase's evidence, no baseline claim, no new activation."""
    return _put(store, s.replace(phase='recovery-failed', intent=None, boot_id=boot).log(at, what, reason),
                'recovery-failed', f'{what}: {reason}')


def _restop(store, s, boot, at, why):
    """Writers run again (a reboot starts the units): the DB may have changed; stop them before touching it."""
    return _put(store, s.replace(intent='stop-writers', boot_id=boot).log(at, s.intent, why))


def _stop_writers(store, host, s, boot):
    try:
        host.stop_bot()
        host.stop_litestream()
        bot, litestream = host.bot_state(), host.litestream_state()
        at = host.now()
    except HostError as e:
        return _blocked(s, 'stop-writers', e)
    if bot not in STOPPED or litestream not in STOPPED:
        return Outcome('blocked', s, f'stop-writers: the bot is {bot}, litestream is {litestream}')
    return _put(store, s.replace(intent='save-post', boot_id=boot).log(at, 'stop-writers', 'ok'))


def _save_post(store, host, s, boot):
    out = post_dir(s.pre.path)
    try:
        at = host.now()
        if not _writers_stopped(host):
            return _restop(store, s, boot, at, 'writers running')
        try:
            # dbsnap.post: a complete post already there is returned as it is, never rewritten.
            host.post(out)
        except Refused as e:
            return _failed(store, s, boot, at, 'save-post', str(e))
    except HostError as e:
        return _blocked(s, 'save-post', e)
    return _put(store, s.replace(intent='restore-pre', boot_id=boot, post=out).log(at, 'save-post', 'ok', post=out))


def _restore_pre(store, host, s, boot):
    try:
        at = host.now()
        if not _writers_stopped(host):
            return _restop(store, s, boot, at, 'writers running')
        try:
            # dbsnap.restore checks the complete post and pre's checksum before the first change.
            host.restore(s.pre.path, s.post)
        except Refused as e:
            return _failed(store, s, boot, at, 'restore-pre', str(e))
    except HostError as e:
        return _blocked(s, 'restore-pre', e)
    return _put(store, s.replace(intent='switch-previous', boot_id=boot).log(at, 'restore-pre', 'ok'))


def _switch_previous(store, host, s, boot):
    prev = s.previous.sha
    try:
        at = host.now()
        if host.bot_state() not in STOPPED:
            if _verdict(s):
                # Started by a reboot from `current` — maybe the candidate, on the restored DB.
                return _restop(store, s, boot, at, 'bot running')
            host.stop_bot()
            if host.bot_state() not in STOPPED:
                return Outcome('blocked', s, 'switch-previous: the bot does not stop')
        try:
            host.switch(prev)
        except Refused as e:
            # The baseline does not verify: never start some other release instead (§10b).
            return _failed(store, s, boot, at, 'switch-previous', str(e))
        cur = host.current()
    except HostError as e:
        return _blocked(s, 'switch-previous', e)
    if cur != prev:
        return _failed(store, s, boot, at, 'switch-previous', f'current is {_short(cur)} after the switch to {_short(prev)}')
    return _put(store, s.replace(intent='start-baseline', boot_id=boot).log(at, 'switch-previous', 'ok'))


def _first(s, what):
    return next(e['at'] for e in s.evidence if e['what'] == what)


def _start_baseline(store, host, s, boot):
    prev = s.previous.sha
    try:
        if host.current() != prev:
            return _put(store, s.replace(intent='switch-previous', boot_id=boot)
                        .log(host.now(), 'start-baseline', 'current moved'))
        host.start_litestream()
        if host.bot_state() != 'active':
            host.start_bot()
        t0 = host.now()
        while True:
            h = _health(host)
            if h.ok and h.release_sha == prev:
                break
            now = host.now()
            if now - t0 >= STARTUP_S:
                return _failed(store, s, boot, now, 'start-baseline',
                               f'{_short(prev)} not healthy within {STARTUP_S} s (last: {_describe(h)})')
            host.sleep(STARTUP_POLL_S)
        at = host.now()
    except HostError as e:
        return _blocked(s, 'start-baseline', e)
    cand = s.candidate.sha
    done = s.replace(phase='settled', intent=None, boot_id=boot, txn=None, candidate=None, previous=None,
                     pre=None, post=None, observe=None, unverified=None)
    if not _verdict(s):
        reason = f'{_short(cand)} never started; back on {_short(prev)}, database untouched'
        return _put(store, done.log(at, 'aborted', reason, candidate=cand, previous=prev), 'aborted', reason)
    lost_to = _first(s, 'stop-writers')
    reason = (f'{_short(cand)} rolled back to {_short(prev)}, code and database; writes between '
              f'{_utc(s.pre.taken_at)} and {_utc(lost_to)} exist only in {s.post}')
    return _put(store, done.log(at, 'rolled-back', reason, candidate=cand, previous=prev, pre=s.pre.path,
                                post=s.post, lostFrom=s.pre.taken_at, lostTo=lost_to), 'rolled-back', reason)


_STEPS = {
    ('activating', 'stop'): _stop,
    ('activating', 'switch'): _switch,
    ('activating', 'start'): _start,
    ('observing', None): _observe,
    ('rolling-back', 'stop-writers'): _stop_writers,
    ('rolling-back', 'save-post'): _save_post,
    ('rolling-back', 'restore-pre'): _restore_pre,
    ('rolling-back', 'switch-previous'): _switch_previous,
    ('rolling-back', 'start-baseline'): _start_baseline,
}


def _held(s):
    """Why a held phase holds: the unverified reason, or the last evidence of a failed recovery."""
    return s.unverified.reason if s.phase == 'unverified' else s.evidence[-1]['result']


def step(store, host):
    """Do the current intent once and persist what follows; see Outcome for the kinds."""
    s = store.load()
    if s is None or s.phase == 'settled':
        return Outcome('idle', s)
    if s.phase in ('unverified', 'recovery-failed'):
        return Outcome(s.phase, s, _held(s))
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


def resume(store, host):
    """The start of every tick: finish what a dead tick left, before anything new (§10b).

    No state / settled: `idle` — or `drift`, without any action, when `current` or the running
    process is not the settled release (an incident, never a destructive DB rollback).
    activating / rolling-back: repeat the persisted intent and run on. observing: continue the
    window only if it is still continuous (same boot, no gap over GAP_S), else `unverified`.
    unverified / recovery-failed: nothing is done; the Outcome is for the notification.
    """
    s = store.load()
    if s is None:
        return Outcome('idle', None)
    if s.phase in ('activating', 'observing', 'rolling-back'):
        return run(store, host)
    if s.phase != 'settled':
        return step(store, host)
    if s.settled is None:
        return Outcome('idle', s)
    try:
        cur, h = host.current(), _health(host)
    except HostError as e:
        return _blocked(s, 'resume', e)
    if cur != s.settled.sha or h.release_sha != s.settled.sha:
        return Outcome('drift', s, f'settled is {_short(s.settled.sha)}, current is {_short(cur)}, '
                                   f'the running process says {_short(h.release_sha)}')
    return Outcome('idle', s)
