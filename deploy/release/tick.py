"""The deploy controller's tick: whether and what to activate, under the shared lock (host, as the operator).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §5 (GATE-001), §6, §7
(lock, PAUSED, --force, --ack-holds, root refused), §10b (resume first).
Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-a.md, Task 3, Global
Constraints (the order below, notifications, Ф3, exit codes).

One tick, every step under the lock `<state dir>/lock` (the file merge-deploy uses):

   1. activate.resume — a pending phase is finished even under PAUSED; anything but `idle` ends the tick
   2. PAUSED — the timer stops here, quietly
   3. drift (or `unreachable`: /health does not answer 3 probes 10 s apart), unverified, recovery-failed —
      a reminder once a day
   4.-11. gates.admission over the facts read here (no baseline, fetch main, settled/noop, ancestry and the
      regression fence, last failed SHA and the abort backoff, quiet, installed copies, holds, CI)
  12. prepare.prepare — noop / verdict / transient / a prepared candidate
  13. the gates once more right before begin: main unmoved (timer), PAUSED absent, the same holds
  14. activate.begin -> activate.run

Notifications go through the injected `notify(text) -> bool`, cut to NOTIFY_LIMIT characters. The end of a
transaction (settled, rolled-back, aborted, unverified, recovery-failed) is reported once per txn, from the
engine's state (`lastTxn`, the ending evidence event) against `notifiedTxn`, which is written only AFTER a
successful send: a tick that dies in between leaves the message to the next tick (a duplicate is
possible, a loss is not). Ф3: `blocked` in a step where the bot is down is a critical alert at once (once
per txn and step) and once more after BLOCKED_REPEAT_S of the same block. Standing conditions: once per UTC
day per key (tick_state.notices). Only the timer sends gate notices; a manual run prints them.

A verdict on a candidate (state v2 lastFailedSha) comes only from the engine's own rollback or from a
prepare `Verdict`; nothing else — a helper's exception, a host error, an internal error — ever writes one.
Any uncaught exception is a critical notification with its type and text (once per UTC day per text) and
exit 70.

Exit codes (merge-deploy's unit has SuccessExitStatus=0 1 2):
  0 nothing to do, waiting, settled, noop   1 refused candidate or hold (and a manual run not served)
  2 rolled back   3 recovery failed, or blocked with the bot down   4 state not written   64 usage / root
  70 internal error
"""
import argparse
import fcntl
import hashlib
import os
import sys
import time
from dataclasses import dataclass, field, replace
from typing import Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import activate  # noqa: E402
import gates  # noqa: E402
import prepare as pp  # noqa: E402
import tick_state  # noqa: E402
from activate import HostError  # noqa: E402
from gates import UNREAD, Ci, CommitPrs, Inputs  # noqa: E402
from github_trust import Untrusted  # noqa: E402
from safe_tar import Refused  # noqa: E402
from tick_state import Blocked, TickState  # noqa: E402

NOTIFY_LIMIT = 3500
# A lock held longer than the longest legitimate tick has a holder that will not let go (merge-deploy).
LOCK_STALL_S = 2100
LOCK_WAIT_S = 30
DRIFT_PROBES = 3
DRIFT_PROBE_GAP_S = 10
BLOCKED_REPEAT_S = 900
# Steps the engine reaches only with the bot stopped: a block there is production down (Ф3).
BOT_DOWN = {('activating', 'switch'), ('activating', 'start')}
ENDS = ('settled', 'rolled-back', 'aborted')
CODES = {'idle': 0, 'wait': 0, 'hold': 1, 'refuse': 1}
ICONS = {'idle': '⚠️', 'wait': '⚠️', 'hold': '⏸', 'refuse': '⛔'}


@dataclass
class Env:
    """Everything the tick touches, injected. `state_dir` holds lock, PAUSED, tick-state.json (and by default
    the engine's deploy-state.json); `target` is the SHA a manual run deploys (the checkout's HEAD)."""
    state_dir: str
    host: object
    helpers: object
    notify: Callable[[str], bool]
    clock: Callable[[], float] = time.time
    sleep: Callable[[float], None] = time.sleep
    store: object = None
    target: str | None = None
    out: Callable[[str], None] = field(default=print)

    def __post_init__(self):
        if self.store is None:
            self.store = activate.Store(self.path('deploy-state.json'))

    def path(self, name):
        return os.path.join(self.state_dir, name)


class _WriteFailed(Exception):
    """A state file could not be written: exit 4."""


class _Guarded:
    """The engine's store, with a failed save turned into _WriteFailed (activate never catches it)."""
    def __init__(self, store):
        self.inner = store

    def load(self):
        return self.inner.load()

    def save(self, state):
        try:
            self.inner.save(state)
        except OSError as e:
            raise _WriteFailed(f'the engine state: {type(e).__name__}: {e}') from None


def _short(sha):
    return sha[:7] if sha else str(sha)


def _day(now):
    return time.strftime('%Y-%m-%d', time.gmtime(now))


def cut(text):
    """merge-deploy notify(): at most NOTIFY_LIMIT characters (characters, never bytes) plus a marker."""
    return text if len(text) <= NOTIFY_LIMIT else text[:NOTIFY_LIMIT] + '\n… truncated'


def ci_of(helpers, sha):
    """gates.Ci from Helpers.trusted: no run at all yet is pending, any other Untrusted reason is failed, a
    failure to ask is unreadable — never a pass."""
    try:
        answer = helpers.trusted(sha)
    except Untrusted as e:
        answer = e
    except Exception as e:
        return Ci('unreadable', f'{type(e).__name__}: {e}')
    if isinstance(answer, Untrusted):
        text = str(answer)
        return Ci('pending', text) if text == f'no trusted CI run for {sha}' else Ci('failed', text)
    return Ci('pass', trusted=answer)


def ended(state):
    """(txn, kind, detail) of the transaction whose end is to be reported, or None.

    unverified / recovery-failed: the open txn, still in its phase. settled: `lastTxn` and its ending event
    (settled, rolled-back, aborted) — the state the engine left after the transaction closed.
    """
    if state is None:
        return None
    if state.phase == 'unverified':
        return state.txn, 'unverified', {'sha': state.unverified.sha, 'result': state.unverified.reason}
    if state.phase == 'recovery-failed':
        e = state.evidence[-1]
        return state.txn, 'recovery-failed', {'result': f'{e["what"]}: {e["result"]}'}
    if state.phase != 'settled' or state.last_txn is None:
        return None
    mine = [e for e in state.evidence if e.get('txn') == state.last_txn]
    ends = [e for e in mine if e['what'] in ENDS]
    if not ends:
        return None
    d = dict(ends[-1])
    # Why an abort happened is the engine's `abort` event (the refused switch), not its closing line.
    d['why'] = '; '.join(e['result'] for e in mine if e['what'] == 'abort')
    return state.last_txn, d['what'], d


def summary(kind, d):
    if kind == 'settled':
        return f'✅ wbb-deploy {_short(d["sha"])} is live and settled.'
    if kind == 'rolled-back':
        return (f'🔥 wbb-deploy ROLLED BACK {_short(d["candidate"])} → {_short(d["previous"])}, code AND database.\n'
                f'{d["result"]}\nA human must reconcile; nothing will do it automatically.')
    if kind == 'aborted':
        return (f'⚠️ wbb-deploy: the activation of {_short(d["candidate"])} was aborted: {d["why"]}. '
                f'{d["result"]}. No verdict on it; the timer retries after a backoff.')
    if kind == 'unverified':
        return (f'⚠️ wbb-deploy {_short(d["sha"])} is live but UNVERIFIED: {d["result"]}. Nothing was rolled back; '
                'unattended deploys are held until a human decides.')
    return (f'🔥 wbb-deploy RECOVERY FAILED at {d["result"]}. Production state is UNKNOWN — the bot may be down. '
            'Manual intervention required; nothing new starts.')


class _Tick:
    def __init__(self, env, mode, ack_holds):
        self.env, self.mode = env, mode
        self.timer = mode == 'timer'
        self.ack_holds = frozenset(ack_holds)
        self.h, self.host = env.helpers, env.host
        self.store = _Guarded(env.store)
        self.ts_path = env.path(tick_state.STATE_NAME)
        self.ts = tick_state.load(self.ts_path) or TickState()

    # --- plumbing -------------------------------------------------------------------------------------------
    def save(self, ts):
        try:
            tick_state.save(self.ts_path, ts)
        except OSError as e:
            raise _WriteFailed(f'{self.ts_path}: {type(e).__name__}: {e}') from None
        self.ts = ts

    def say(self, line):
        self.env.out(line)

    def send(self, text):
        """notify; False (and a warning on the output) when it failed or raised."""
        text = cut(text)
        try:
            ok = self.env.notify(text) is True
        except Exception as e:
            self.say(f'WARNING: notify raised {type(e).__name__}: {e}')
            ok = False
        if not ok:
            self.say(f'WARNING: notify failed: {text}')
        return ok

    def notice(self, key, text, repeat='daily'):
        """A standing condition: the timer notifies once per UTC day (or once) per key; by hand it is printed."""
        self.say(text)
        day = _day(self.env.clock())
        if self.timer and tick_state.notice_due(self.ts, key, day, repeat) and self.send(text):
            self.save(tick_state.noted(self.ts, key, day))

    def paused(self):
        return os.path.exists(self.env.path('PAUSED'))

    def served(self, code, own=False, settled=False):
        """A manual run whose deploy did not happen is not a success, even where the timer's would be."""
        return 1 if not self.timer and code == 0 and not (own and settled) else code

    # --- the engine's outcomes ------------------------------------------------------------------------------
    def account(self, state):
        """Abort backoff and the once-per-txn summary, from the engine's state alone (Ф6, Ф7)."""
        end = ended(state)
        if end is None:
            return
        txn, kind, d = end
        if kind == 'aborted':
            counted = tick_state.aborted(self.ts, d['candidate'], d['at'], txn)
            if counted != self.ts:
                self.save(counted)
        if txn == self.ts.notified_txn:
            return
        text = summary(kind, d)
        self.say(text)
        if self.send(text):
            ts = self.ts.replace(notified_txn=txn)
            if kind in ('unverified', 'recovery-failed'):
                # The summary is today's reminder too.
                ts = tick_state.noted(ts, kind, _day(self.env.clock()))
            self.save(ts)

    def engine(self, out, own=False):
        """Report an Outcome of resume/run; the exit code, or None when idle (the tick goes on)."""
        self.account(out.state)
        s = out.state
        if out.kind == 'blocked' or (out.kind == 'recovery-failed' and s.phase == 'rolling-back'):
            return self.blocked(out)
        if self.ts.blocked is not None:
            self.save(self.ts.replace(blocked=None))
        if out.kind == 'idle':
            return None
        if out.kind in ENDS:
            return self.served({'settled': 0, 'rolled-back': 2, 'aborted': 0}[out.kind], own, out.kind == 'settled')
        if out.kind in ('unverified', 'recovery-failed'):
            self.notice(out.kind, summary(out.kind, ended(s)[2]))
            return self.served(3 if out.kind == 'recovery-failed' else 0)
        if out.kind == 'drift':
            if self.timer and self.paused():
                return 0
            if self.answers():
                self.notice('drift', f'⚠️ wbb-deploy: production drift — {out.reason}. Nothing is done; '
                                     'unattended deploys wait until a human decides.')
            else:
                self.notice('unreachable', f'⚠️ wbb-deploy: the bot does not answer /health ({DRIFT_PROBES} '
                                           f'probes, {DRIFT_PROBE_GAP_S} s apart); settled is '
                                           f'{_short(s.settled.sha)}. Not a release incident: check the bot unit.')
            return self.served(0)
        raise AssertionError(f'unexpected engine outcome {out.kind}')

    def answers(self):
        """Does the bot answer /health at all (ok, or naming a release) within DRIFT_PROBES probes?"""
        for n in range(DRIFT_PROBES):
            try:
                h = self.host.health()
            except HostError:
                h = None
            if h is not None and (h.ok or h.release_sha is not None):
                return True
            if n + 1 < DRIFT_PROBES:
                self.host.sleep(DRIFT_PROBE_GAP_S)
        return False

    def blocked(self, out):
        """Ф3: a block with the bot down — critical at once per txn+step, again after BLOCKED_REPEAT_S."""
        s = out.state
        step = f'{s.phase}/{s.intent}'
        if (s.phase, s.intent) not in BOT_DOWN and s.phase != 'rolling-back':
            self.notice('blocked', f'⚠️ wbb-deploy: {step} is blocked: {out.reason}. The next tick retries.')
            return self.served(0)
        now, b = self.env.clock(), self.ts.blocked
        text = (f'🔥 wbb-deploy: the bot is DOWN — {step} is blocked: {out.reason}. Every tick retries it; '
                'a human may be needed (sudo, systemctl).')
        if b is None or (b.txn, b.step) != (s.txn, step):
            self.say(text)
            if self.send(text):
                self.save(tick_state.noted(self.ts.replace(blocked=Blocked(s.txn, step, now, 1)), 'blocked', _day(now)))
        elif b.alerts == 1 and now - b.at >= BLOCKED_REPEAT_S:
            again = f'{text}\nStill blocked after {int((now - b.at) // 60)} min.'
            self.say(again)
            if self.send(again):
                self.save(self.ts.replace(blocked=replace(b, alerts=2)))
        else:
            self.notice('blocked', text)
        return 3

    # --- the regression fence ----------------------------------------------------------------------------------
    def observe(self, settled_sha):
        try:
            o = gates.observe(self.ts.last_seen_settled, self.ts.regression, settled_sha, self.h.is_ancestor)
        except Exception as e:
            self.notice('assess', f'⚠️ wbb-deploy: cannot assess the settled transition ({type(e).__name__}: {e}); '
                                  'keeping the previous observation, unattended deploys wait.')
            return self.served(0)
        if o.event in ('went-backwards', 'diverged'):
            # The brake is persisted before Telegram can fail; the observation advances only once it was said.
            self.save(self.ts.replace(regression=o.regression))
            text = (f'⚠️ wbb-deploy: production {o.event}: {_short(o.previous)} → {_short(settled_sha)}. '
                    'Was this a deliberate rollback? Unattended deploys are HELD; deploy main by hand to recover.')
            self.say(text)
            if not self.send(text):
                return self.served(0)
        if (o.last_seen, o.regression) != (self.ts.last_seen_settled, self.ts.regression):
            self.save(self.ts.replace(last_seen_settled=o.last_seen, regression=o.regression))
        return None

    # --- admission -----------------------------------------------------------------------------------------------
    def read(self, name, i):
        h = self.h
        if name == 'from_in_target':
            return h.is_ancestor(i.regression.from_sha, i.target)
        if name == 'settled_in_target':
            return h.is_ancestor(i.settled_sha, i.target)
        if name == 'target_in_main':
            return h.is_ancestor(i.target, i.main)
        if name == 'installed_stale':
            return h.installed_stale(gates.INSTALLED_COPIES)
        if name == 'changed_paths':
            try:
                return tuple(h.changed_paths(i.settled_sha, i.target))
            except Exception as e:
                self.say(f'changed paths: {type(e).__name__}: {e}')
                return None
        if name == 'commit_prs':
            try:
                commits = tuple(h.commits(i.settled_sha, i.target))
            except Exception as e:
                self.say(f'commits: {type(e).__name__}: {e}')
                return None
            return tuple(CommitPrs(c, self.labels(c)) for c in commits)
        if name == 'ci':
            return ci_of(h, i.target)
        raise AssertionError(f'gates asked for an unknown input {name!r}')

    def labels(self, commit):
        try:
            return tuple(self.h.pr_labels(commit))
        except Exception as e:
            self.say(f'PR labels of {_short(commit)}: {type(e).__name__}: {e}')
            return None

    def admit(self, i):
        """(decision, the inputs it was made on): admission, reading each input it asks for."""
        while True:
            d = gates.admission(i)
            if d.kind != 'need':
                return d, i
            i = replace(i, **{d.reason: self.read(d.reason, i)})

    def report(self, d):
        text = f'{ICONS[d.kind]} wbb-deploy: {d.reason}'
        if d.holds:
            text += f'\nDo the steps, then run: bash deploy/deploy.sh --ack-holds {" ".join(d.holds)}'
        if d.notice_key is not None:
            self.notice(d.notice_key, text, d.repeat)
        else:
            self.say(text)
        # Nothing to do is fine by hand too; a wait is a deploy that did not happen.
        return self.served(0) if d.kind == 'wait' else CODES[d.kind]

    def fetch_main(self):
        try:
            return self.h.fetch_main()
        except Exception as e:
            self.say(f'fetch main: {type(e).__name__}: {e}')
            return None

    def discard(self, pre):
        try:
            self.h.discard_pre(pre)
        except Exception as e:
            self.say(f'WARNING: could not discard {pre.path}: {type(e).__name__}: {e}')

    # --- the tick --------------------------------------------------------------------------------------------------
    def run(self):
        code = self.engine(activate.resume(self.store, self.host))
        if code is not None:
            return code
        if self.timer and self.paused():
            self.say('paused (PAUSED exists); no new deploy')
            return 0
        state = self.store.load()
        settled = state.settled if state is not None else None
        main = None
        if settled is not None:
            code = self.observe(settled.sha)
            if code is not None:
                return code
            main = self.fetch_main()
        now = self.env.clock()
        if self.timer and main is not None:
            seen = tick_state.seen_main(self.ts, main, now)
            if seen != self.ts:
                self.save(seen)
        i = Inputs(
            mode=self.mode, now=now, main=main, target=main if self.timer else self.env.target,
            paused=self.paused(), settled_sha=settled.sha if settled else None, noop=self.ts.noop,
            last_failed_sha=state.last_failed_sha if state else None, abort=self.ts.abort,
            main_seen=self.ts.main_seen, regression=self.ts.regression, ack_holds=self.ack_holds)
        d, i = self.admit(i)
        if d.kind != 'admit':
            return self.report(d)
        return self.deploy(i, settled)

    def deploy(self, i, settled):
        sha = i.target
        self.say(f'preparing {sha}')
        got = pp.prepare(self.h, sha, i.ci.trusted, settled)
        if isinstance(got, pp.Noop):
            self.say(f'{_short(sha)} changes nothing in the runtime payload; nothing to activate')
            self.save(self.ts.replace(noop=tick_state.Noop(sha, settled.sha)))
            return 0
        if isinstance(got, pp.Verdict):
            # The only verdict the tick itself writes: exit 1 with its verdict word (prepare, plan "Рішення" п.3).
            self.store.save(self.store.load().replace(last_failed_sha=sha))
            text = f'⛔ wbb-deploy refused {_short(sha)}: {got.step.upper()} {got.kind}\n{got.text}'
            self.say(text + (f'\n{got.note}' if got.note else ''))
            self.send(text)
            return 1
        if isinstance(got, pp.Transient):
            note = f'\n{got.note}' if got.note else ''
            self.notice('prepare', f'⚠️ wbb-deploy could not prepare {_short(sha)} ({got.step}): {got.reason} — '
                                   f'not a verdict; the next tick tries again.{note}')
            return self.served(0)
        return self.activate(got, i)

    def activate(self, prepared, i):
        state = self.store.load()
        fresh = replace(i, now=self.env.clock(), main=self.fetch_main() if self.timer else i.main,
                        paused=self.paused(), last_failed_sha=state.last_failed_sha,
                        installed_stale=UNREAD, changed_paths=UNREAD, commit_prs=UNREAD)
        d, _ = self.admit(fresh)
        if d.kind != 'admit':
            self.discard(prepared.pre)
            return self.report(d)
        try:
            activate.begin(self.store, self.host, prepared.candidate, prepared.pre)
        except (Refused, HostError) as e:
            self.discard(prepared.pre)
            self.notice('begin', f'⚠️ wbb-deploy could not begin {_short(i.target)}: {type(e).__name__}: {e} — '
                                 'not a verdict; the next tick tries again.')
            return self.served(0)
        self.say(f'activating {i.target}')
        return self.engine(activate.run(self.store, self.host), own=True)


# --- the lock --------------------------------------------------------------------------------------------------------
def _read_int(path):
    try:
        with open(path, encoding='ascii') as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def _write_text(path, text):
    with open(path, 'w', encoding='ascii') as f:
        f.write(text)


def _busy(env, lock_path):
    """merge-deploy's lock-busy-since: a holder that never lets go is reported once a day after LOCK_STALL_S.

    Both files live outside tick-state.json: state is written only under the lock, and this runs without it.
    """
    now = int(env.clock())
    since_path = env.path('lock-busy-since')
    since = _read_int(since_path)
    if since is None or now - since >= 2 * LOCK_STALL_S:
        # A record older than two stall periods is from an earlier busy period nobody closed.
        _write_text(since_path, str(now))
        since = now
    held = now - since
    notice_path = env.path('lock-notice')
    day = _day(now)
    try:
        with open(notice_path, encoding='ascii') as f:
            last = f.read().strip()
    except OSError:
        last = None
    if held >= LOCK_STALL_S and last != day:
        text = (f'⚠️ wbb-deploy: the deploy lock has been held for {held // 60} min — no tick can run. '
                f'A stuck manual deploy? Check: fuser -v {lock_path}')
        if _notify(env, text):
            _write_text(notice_path, day)
    env.out(f'another process holds the lock ({held} s); exiting')


def _lock(env, mode):
    """The open, locked fd; None if busy (timer: at once; by hand: after LOCK_WAIT_S)."""
    os.makedirs(env.state_dir, exist_ok=True)
    path = env.path('lock')
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    deadline = env.clock() + (0 if mode == 'timer' else LOCK_WAIT_S)
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            if env.clock() >= deadline:
                os.close(fd)
                return None
            env.sleep(1)


def _internal(env, text):
    """The top-level catch's critical notice, once per UTC day per text (a broken state file fails every tick)."""
    mark = f'{_day(env.clock())} {hashlib.sha256(text.encode()).hexdigest()}'
    path = env.path('internal-notice')
    try:
        with open(path, encoding='ascii') as f:
            if f.read() == mark:
                return
    except OSError:
        pass
    if _notify(env, text):
        _write_text(path, mark)


def _notify(env, text):
    """notify outside a tick (lock busy, top-level catch): True only for a confirmed send."""
    try:
        return env.notify(cut(text)) is True
    except Exception as e:
        env.out(f'WARNING: notify raised {type(e).__name__}: {e}')
        return False


def tick(env, mode, ack_holds=()):
    """One tick in `mode` (timer, manual, force); the exit code."""
    if mode not in gates.MODES:
        raise ValueError(f'unknown mode {mode!r}')
    if (mode == 'timer') != (env.target is None):
        raise ValueError('the timer deploys main (no target); a manual run deploys its checkout (a target)')
    fd = None
    try:
        fd = _lock(env, mode)
        if fd is None:
            if mode == 'timer':
                _busy(env, env.path('lock'))
                return 0
            env.out(f'ERROR: another deploy holds {env.path("lock")} (waited {LOCK_WAIT_S} s) — it is probably '
                    'watching a rollback window. Retry when it ends.')
            return 1
        try:
            os.unlink(env.path('lock-busy-since'))
        except FileNotFoundError:
            pass
        return _Tick(env, mode, ack_holds).run()
    except _WriteFailed as e:
        text = f'🔥 wbb-deploy: failed to write {e} — its record may now disagree with production.'
        env.out(text)
        _internal(env, text)
        return 4
    except Exception as e:
        text = f'🔥 wbb-deploy: internal error, nothing judged: {type(e).__name__}: {e}'
        env.out(text)
        _internal(env, text)
        return 70
    finally:
        if fd is not None:
            os.close(fd)


def main(argv=None, make_env=None, geteuid=os.geteuid):
    """`tick.py timer` | `tick.py deploy [--force] [--ack-holds KEY ...]`.

    make_env(mode) builds the Env with the real Host and Helpers — the adapters of stage Б; without them the
    CLI refuses to run (70) rather than guess.
    """
    p = argparse.ArgumentParser(prog='tick.py')
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('timer')
    d = sub.add_parser('deploy')
    d.add_argument('--force', action='store_true')
    d.add_argument('--ack-holds', nargs='+', default=[], metavar='KEY')
    try:
        args = p.parse_args(argv)
    except SystemExit:
        return 64
    if geteuid() == 0:
        print('ERROR: run the deploy as the operator, not as root or via sudo — it calls sudo itself, per step.',
              file=sys.stderr)
        return 64
    mode = 'timer' if args.command == 'timer' else ('force' if args.force else 'manual')
    if make_env is None:
        print('ERROR: the host adapters (Host, Helpers) are not installed yet (stage Б).', file=sys.stderr)
        return 70
    return tick(make_env(mode), mode, getattr(args, 'ack_holds', []))


if __name__ == '__main__':
    sys.exit(main())
