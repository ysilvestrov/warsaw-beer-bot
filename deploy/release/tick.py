"""The deploy controller's tick: whether and what to activate, under the shared lock (host, as the operator).

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §5 (GATE-001), §6, §7
(lock, PAUSED, --force, --ack-holds, root refused), §10b (resume first).
Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-a.md, Task 3, Global
Constraints (the order below, notifications, Ф3, exit codes).

One tick, every step under the lock `<state dir>/lock` (the file merge-deploy uses):

   1. activate.resume — a pending phase is finished even under PAUSED; anything but `idle` ends the tick
   2. PAUSED — the timer stops here, quietly
   3. drift (or `unreachable`: /health does not answer 3 probes 10 s apart), unverified, recovery-failed —
      a reminder once a day; a manual run goes on through drift and `unreachable` (stage A review S4)
   4.-11. fetch main, then the regression fence over settled (skipped when the fetch failed), then
      gates.admission over the facts read here (no baseline, the fetch, settled/noop, ancestry and the fence, last failed SHA, the abort and prepare backoffs, quiet, installed copies, holds, CI)
  12. prepare.prepare — noop / verdict / transient (counted for its backoff) / a prepared candidate
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
exit 70. A tick-state.json that cannot be read is such an error too, but only after activate.resume ran and
what it ended was reported (stage A review S3).

By hand only, never from the timer (plan periphery-b2 "Рішення" п.4), under the same lock: `rearm --sha` clears
lastFailedSha when it is that SHA and the abort backoff of that SHA; `ack-baseline --from` clears the regression
fence whose `from` is that SHA. Both print what they changed and log it as an evidence event of state v2.

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
from deploy_state import StateError  # noqa: E402
from gates import UNREAD, Ci, CommitPrs, Inputs  # noqa: E402
from github_trust import SHA as FULL_SHA, NoRunYet, RunFailed  # noqa: E402
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


class _CannotAssess(Exception):
    """A git question or the installed-copies check failed (not an answer): a wait, never a verdict or 70."""


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
    """gates.Ci from Helpers.trusted (stage A review S2): failed only for CI's own verdict (github_trust.RunFailed),
    pending only when no run is listed yet (NoRunYet); any other Untrusted — a 5xx, no token, a partial listing,
    an expired artifact — and any other exception is unreadable: the tick waits and says so once a day. Never a
    pass without a Trusted."""
    try:
        answer = helpers.trusted(sha)
        if isinstance(answer, BaseException):
            raise answer
    except RunFailed as e:
        return Ci('failed', str(e))
    except NoRunYet as e:
        return Ci('pending', str(e))
    except Exception as e:
        return Ci('unreadable', f'{type(e).__name__}: {e}')
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
    ends = [n for n, e in enumerate(mine) if e['what'] in ENDS]
    if not ends:
        return None
    d = dict(mine[ends[-1]])
    # Why an abort happened is the engine's `abort` event (the refused switch), not its closing line.
    d['why'] = '; '.join(e['result'] for e in mine if e['what'] == 'abort')
    # (periphery-b2 Task 2) `tick.py rearm` logs into this same txn: the abort it cleared is not counted again.
    d['rearmed'] = any(e['what'] == 'rearm' and e.get('sha') == d.get('candidate')
                       for e in mine[ends[-1] + 1:])
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
        # (stage A review S3) a broken tick-state.json must not keep the engine from finishing a pending phase
        # (a rollback): it is read here, but it stops the tick only after activate.resume ran.
        self.ts, self.ts_error = None, None
        self.base = None  # where the held range starts, read with the changed paths (holds_base)
        try:
            self.ts = tick_state.load(self.ts_path) or TickState()
        except (StateError, OSError) as e:
            self.ts_error = e

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

    def record_verdicts(self):
        """Finish lastFailedSha for every queued verdict whose engine-state write may not have landed."""
        for v in self.ts.pending_verdicts:
            if not v.recorded:
                state = self.store.load()
                if state is None or state.phase != 'settled':
                    # (#827 AI review) nowhere to record it yet: the entry stays unrecorded — not sent, not
                    # dropped — and a later tick records it once the engine is settled again.
                    continue
                if state.last_failed_sha != v.sha:
                    self.store.save(state.replace(last_failed_sha=v.sha))
                self.save(self.ts.replace(pending_verdicts=tuple(
                    tick_state.Verdict(x.sha, x.text, True) if x is v else x for x in self.ts.pending_verdicts)))

    def flush_verdicts(self):
        """Send queued verdict messages oldest first; each leaves the queue only once it went out."""
        while self.ts.pending_verdicts and self.ts.pending_verdicts[0].recorded:
            if not self.send(self.ts.pending_verdicts[0].text):
                return
            self.save(self.ts.replace(pending_verdicts=self.ts.pending_verdicts[1:]))

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
        if kind == 'aborted' and not d['rearmed']:
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
            if not self.timer:
                # (stage A review S4) spec §7 forbids a human to bypass only unfinished recovery and the lock;
                # merge-deploy's deploy.sh went through drift too. begin verifies both trees before the stop.
                self.say(f'⚠️ wbb-deploy: production drift or no answer — {out.reason}. Deploying by hand anyway.')
                return None
            if self.paused():
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
            ts = self.ts.replace(last_seen_settled=o.last_seen, regression=o.regression)
            if o.last_seen != self.ts.last_seen_settled:
                # (stage A review S1) every settle acknowledges through itself: an older acknowledgement
                # never reaches past what is settled now.
                ts = ts.replace(ack_through=o.last_seen)
            self.save(ts)
        return None

    # --- admission -----------------------------------------------------------------------------------------------
    def ask(self, what, fn, *args):
        """(stage A review S5) a helper that raised has not answered: _CannotAssess, which `admit` turns into a
        daily "cannot assess" wait. An unknown commit is an answer (Helpers.is_ancestor: False), not this."""
        try:
            return fn(*args)
        except Exception as e:
            raise _CannotAssess(f'{what}: {type(e).__name__}: {e}') from None

    def read(self, name, i):
        h = self.h
        if name == 'from_in_target':
            return self.ask('ancestry', h.is_ancestor, i.regression.from_sha, i.target)
        if name == 'settled_in_target':
            return self.ask('ancestry', h.is_ancestor, i.settled_sha, i.target)
        if name == 'target_in_main':
            return self.ask('ancestry', h.is_ancestor, i.target, i.main)
        if name == 'installed_stale':
            return self.ask('the installed copies', h.installed_stale, gates.INSTALLED_COPIES)
        if name == 'changed_paths':
            # gates ask for the paths before the commits: both read the range from this one base
            self.base = self.ask('ancestry', self.holds_base, i)
            try:
                return tuple(h.changed_paths(self.base, i.target))
            except Exception as e:
                self.say(f'changed paths: {type(e).__name__}: {e}')
                return None
        if name == 'commit_prs':
            try:
                commits = tuple(h.commits(self.base, i.target))
            except Exception as e:
                self.say(f'commits: {type(e).__name__}: {e}')
                return None
            return tuple(CommitPrs(c, self.labels(c)) for c in commits)
        if name == 'ci':
            return ci_of(h, i.target)
        raise AssertionError(f'gates asked for an unknown input {name!r}')

    def holds_base(self, i):
        """Where the held range starts (stage A review S1): the newest of settled and ackThrough that the target
        contains. A range a human acknowledged and that settled nothing new (a noop) is not shown again."""
        a = self.ts.ack_through
        if a is None or a == i.settled_sha:
            return i.settled_sha
        if self.h.is_ancestor(i.settled_sha, a) and self.h.is_ancestor(a, i.target):
            return a
        return i.settled_sha

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
            try:
                value = self.read(d.reason, i)
            except _CannotAssess as e:
                return gates.Decision('wait', f'cannot assess {e} — nothing judged; unattended deploys wait.',
                                      'assess' if self.timer else None), i
            i = replace(i, **{d.reason: value})

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

    def opened(self, pre):
        """Does the stored state hold an activation with this pre (a save that raised after it landed)? Unknown
        counts as yes: a pre kept for nothing is a leak, a pre discarded under an activation breaks its rollback."""
        try:
            state = self.store.load()
        except Exception:
            return True
        return state is not None and state.pre == pre

    def discard(self, pre):
        try:
            self.h.discard_pre(pre)
        except Exception as e:
            self.say(f'WARNING: could not discard {pre.path}: {type(e).__name__}: {e}')

    # --- the tick --------------------------------------------------------------------------------------------------
    def degraded(self, out):
        """(stage A review S3) resume ran without a readable tick-state: report what the engine just ended — a
        rolled-back, settled or aborted transaction, which no later resume repeats — without the once-per-txn
        record (a duplicate once the file is repaired is possible, a loss is not), then fail the tick with the
        state error and the engine's outcome: exit 70 and its critical notice."""
        end = ended(out.state) if out.kind in ENDS else None
        if end is not None:
            text = summary(end[1], end[2])
            self.say(text)
            self.send(text)
        engine = '' if out.kind == 'idle' else f'; the engine: {out.kind}' + (f': {out.reason}' if out.reason else '')
        raise StateError(f'{self.ts_error}{engine}')

    def run(self):
        out = activate.resume(self.store, self.host)
        if self.ts_error is not None:
            return self.degraded(out)
        code = self.engine(out)
        if code is not None:
            return code
        self.record_verdicts()
        self.flush_verdicts()
        if self.timer and self.paused():
            self.say('paused (PAUSED exists); no new deploy')
            return 0
        if len(self.ts.pending_verdicts) >= tick_state.MAX_PENDING_VERDICTS:
            # (#827 AI review) the queue is never truncated: with this many verdicts undelivered, notify is
            # broken and no new candidate is prepared until they went out.
            self.say(f'{len(self.ts.pending_verdicts)} verdict messages are undelivered (notify is failing); '
                     f'no new deploy until they are sent')
            return self.served(0)
        state = self.store.load()
        settled = state.settled if state is not None else None
        main = None
        if settled is not None:
            # (stage A review S6) fetch first, as merge-deploy did: a settled commit the private clone does not
            # have yet is not an ancestor of anything there and would read as a regression. A failed fetch
            # observes nothing; admission waits on it.
            main = self.fetch_main()
            if main is not None:
                code = self.observe(settled.sha)
                if code is not None:
                    return code
        now = self.env.clock()
        if self.timer and main is not None:
            seen = tick_state.seen_main(self.ts, main, now)
            if seen != self.ts:
                self.save(seen)
        i = Inputs(
            mode=self.mode, now=now, main=main, target=main if self.timer else self.env.target,
            paused=self.paused(), settled_sha=settled.sha if settled else None, noop=self.ts.noop,
            last_failed_sha=state.last_failed_sha if state else None, abort=self.ts.abort,
            prepare_retry=self.ts.prepare_retry,
            main_seen=self.ts.main_seen, regression=self.ts.regression, ack_holds=self.ack_holds)
        d, i = self.admit(i)
        if d.kind != 'admit':
            return self.report(d)
        return self.deploy(i, settled)

    def deploy(self, i, settled):
        sha = i.target
        self.say(f'preparing {sha}')
        got = pp.prepare(self.h, sha, i.ci.trusted, settled)
        if isinstance(got, pp.Transient):
            # (plan periphery-b2 "Рішення" п.5) the timer waits gates.prepare_retry_s before it tries this SHA again.
            self.save(tick_state.prepare_transient(self.ts, sha, self.env.clock()))
        elif self.ts.prepare_retry is not None:
            try:
                self.save(self.ts.replace(prepare_retry=None))
            except _WriteFailed:
                # (periphery-b2 review S2) the pre of a prepared candidate is never a settled snapshot: a tick
                # that cannot go on to begin() takes it away, as on every other begin failure (stage A N2).
                if isinstance(got, pp.Prepared):
                    self.discard(got.pre)
                raise
        if isinstance(got, pp.Noop):
            self.say(f'{_short(sha)} changes nothing in the runtime payload; nothing to activate')
            # (stage A review S1) admission passed the holds of this range — none, or exactly the ones a human
            # acknowledged with --ack-holds — and settled does not move: the next merge shows only what is new
            # after `sha`, instead of the same acknowledged holds forever.
            self.save(self.ts.replace(noop=tick_state.Noop(sha, settled.sha), ack_through=sha))
            return 0
        if isinstance(got, pp.Verdict):
            # The only verdict the tick itself writes: exit 1 with its verdict word (prepare, plan "Рішення" п.3).
            text = f'⛔ wbb-deploy refused {_short(sha)}: {got.step.upper()} {got.kind}\n{got.text}'
            text = cut(text + (f'\n{got.note}' if got.note else ''))
            self.say(text)
            # (#827 AI review) lastFailedSha stops this SHA from being prepared again, so its message must
            # outlive a failed notify: queued first (cut, so the file stays bounded), then the verdict is
            # written to the engine's state, then marked recorded — a tick that died in between finishes
            # that write before anything else (flush_verdicts). Queued, not overwritten: a later verdict
            # never replaces one still undelivered.
            # Never truncated: deploy() is not reached while the queue is full (see run).
            self.save(self.ts.replace(pending_verdicts=self.ts.pending_verdicts + (tick_state.Verdict(sha, text, False),)))
            self.record_verdicts()
            self.flush_verdicts()
            return 1
        if isinstance(got, pp.Transient):
            note = f'\n{got.note}' if got.note else ''
            self.notice('prepare', f'⚠️ wbb-deploy could not prepare {_short(sha)} ({got.step}): {got.reason} — '
                                   f'not a verdict; it is tried again after a backoff.{note}')
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
        except Exception as e:
            # (stage A review N2) any failure of begin — a refusal, a host error, a state write that failed
            # (exit 4) — drops the pre no activation will use, unless the opened state did reach the store.
            if not self.opened(prepared.pre):
                self.discard(prepared.pre)
            if not isinstance(e, (Refused, HostError)):
                raise
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
    if held >= LOCK_STALL_S:
        # (#827 AI review) read-notify-write under a lock of its own: two ticks that both miss the deploy
        # lock must not both send the once-a-day notice.
        fd = os.open(env.path('lock-notice.lock'), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                # Another tick is sending this very notice right now; never wait on it (#827 AI review).
                env.out(f'another process holds the lock ({held} s); exiting')
                return
            try:
                with open(notice_path, encoding='ascii') as f:
                    last = f.read().strip()
            except OSError:
                last = None
            if last != day:
                text = (f'⚠️ wbb-deploy: the deploy lock has been held for {held // 60} min — no tick can run. '
                        f'A stuck manual deploy? Check: fuser -v {lock_path}')
                if _notify(env, text):
                    _write_text(notice_path, day)
        finally:
            os.close(fd)
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


# --- the operator's commands (periphery-b2, plan "Рішення" п.4) ----------------------------------------------------------
class _Refused(Exception):
    """An operator command that changes nothing: exit 1 with this text."""


def _settled_engine(env):
    """The engine's state, which these commands write only between transactions."""
    state = env.store.load()
    if state is None:
        raise _Refused('no engine state: nothing was ever deployed through it')
    if state.phase != 'settled':
        raise _Refused(f'the engine is in {state.phase}/{state.intent}: a pending transaction is finished by the '
                       'next tick first; nothing changed')
    return state


def _rearm(env, ts, sha):
    """lastFailedSha (only when it is `sha`) and the abort backoff of `sha` cleared; refused when neither names it.

    Writes tick-state first: a verdict message still queued for `sha` is marked recorded (its write did land —
    lastFailedSha is `sha`), so no later tick writes the failed SHA back. Then the engine's state: lastFailedSha
    and a `rearm` evidence event in the transaction that ended last, which keeps that transaction's abort from
    being counted again (ended()). The abort is cleared last, so a run cut between any two writes still finds
    something to rearm and is repeated by running it again.
    """
    state = _settled_engine(env)
    failed = state.last_failed_sha == sha
    aborted = ts.abort is not None and ts.abort.sha == sha
    if not failed and not aborted:
        raise _Refused(f'nothing to rearm for {sha}: lastFailedSha is {state.last_failed_sha}, the abort backoff is '
                       f'{"for " + ts.abort.sha if ts.abort else "not set"}; nothing changed')
    cleared = []
    if failed:
        cleared.append(f'lastFailedSha {sha}')
    if aborted:
        cleared.append(f'abort backoff of {sha} ({ts.abort.count} abort(s))')
    verdicts = tuple(tick_state.Verdict(v.sha, v.text, True) if failed and v.sha == sha else v
                     for v in ts.pending_verdicts)
    # Three writes, each leaving a state the same command can finish (#829 AI review): the verdicts first (so no
    # tick writes lastFailedSha back), then the engine, and only then the abort — the one record that lets an
    # abort-only rearm be run again if a write in between failed.
    ts = ts.replace(pending_verdicts=verdicts)
    _save_ts(env, ts)
    _save_engine(env, state.replace(last_failed_sha=None if failed else state.last_failed_sha)
                 .log(env.clock(), 'rearm', 'ok', sha=sha, cleared=cleared))
    if aborted:
        _save_ts(env, ts.replace(abort=None))
    return f'rearmed {sha}: cleared ' + '; '.join(cleared)


def _ack_baseline(env, ts, from_sha):
    """The regression fence cleared, only when it is the one from `from_sha` that tick-state shows."""
    r = ts.regression
    if r is None:
        raise _Refused('no regression fence is set; nothing changed')
    if r.from_sha != from_sha:
        raise _Refused(f'the fence is {r.from_sha} → {r.to_sha}, not from {from_sha}; nothing changed')
    state = _settled_engine(env)
    _save_engine(env, state.log(env.clock(), 'ack-baseline', 'ok', **{'from': r.from_sha, 'to': r.to_sha}))
    # (periphery-b2 review S1) the observation moves to what is settled now, as observe() does after a sent
    # alert: left on the old settled, the next tick would see the same divergence and set the fence again.
    _save_ts(env, ts.replace(regression=None, last_seen_settled=state.settled.sha,
                             ack_through=state.settled.sha if ts.last_seen_settled != state.settled.sha else ts.ack_through))
    return f'regression fence {r.from_sha} → {r.to_sha} acknowledged: unattended deploys resume from {r.to_sha}'


def _save_ts(env, ts):
    path = env.path(tick_state.STATE_NAME)
    try:
        tick_state.save(path, ts)
    except OSError as e:
        raise _WriteFailed(f'{path}: {type(e).__name__}: {e}') from None


def _save_engine(env, state):
    _Guarded(env.store).save(state)


OPERATOR = {'rearm': _rearm, 'ack-baseline': _ack_baseline}


def operator(env, command, sha):
    """`rearm` or `ack-baseline` by hand, under the deploy lock (a busy lock: 1 after LOCK_WAIT_S). Never the timer.

    Prints what changed (or why nothing did). Exit: 0 changed, 1 refused, 4 a state not written, 70 internal.
    """
    if command not in OPERATOR:
        raise ValueError(f'unknown command {command!r}')
    fd = None
    try:
        fd = _lock(env, 'manual')
        if fd is None:
            env.out(f'ERROR: another deploy holds {env.path("lock")} (waited {LOCK_WAIT_S} s); nothing changed')
            return 1
        ts = tick_state.load(env.path(tick_state.STATE_NAME)) or TickState()
        env.out(OPERATOR[command](env, ts, sha))
        return 0
    except _Refused as e:
        env.out(f'REFUSED: {e}')
        return 1
    except _WriteFailed as e:
        env.out(f'ERROR: failed to write {e}')
        return 4
    except Exception as e:
        env.out(f'ERROR: {type(e).__name__}: {e}; nothing judged')
        return 70
    finally:
        if fd is not None:
            os.close(fd)


class EnvFailed(Exception):
    """make_env could not build the Env; `notify` is what it had built before that (or None)."""
    def __init__(self, cause, notify=None, state_dir=None):
        super().__init__(f'{type(cause).__name__}: {cause}')
        self.cause, self.notify, self.state_dir = cause, notify, state_dir


def _real_factories():
    # Imported here: a broken adapter module is a failure of make_env (exit 70 and a notice), not of tick.py.
    import helpers_adapter
    import host_adapter
    import notify_telegram
    return {'notify': notify_telegram.make_notify, 'host': host_adapter.RealHost,
            'helpers': helpers_adapter.RealHelpers}


def _xdg(environ, var, default):
    import installed
    return os.path.join(environ.get(var) or os.path.join(environ['HOME'], default), installed.APP_DIR)


def make_env(mode, target=None, environ=None, clock=time.time, sleep=time.sleep, factories=None):
    """The Env with the real Host, Helpers and Telegram notify (plan Б-ядро, Task 3).

    One clock (plan "Рішення" п.5): the engine's host.now() — which stamps abort.at — and the tick's clock — which
    gives Inputs.now — are the same function. The directories are merge-deploy's: the state (and its lock) in
    ${XDG_STATE_HOME:-~/.local/state}/wbb-autodeploy, the private clone in ${XDG_DATA_HOME:-~/.local/share}/….
    Any failure is EnvFailed, carrying the notify if it was built by then.
    """
    environ = os.environ if environ is None else environ
    notify = state_dir = None
    try:
        f = factories or _real_factories()
        notify = f['notify']()
        state_dir = _xdg(environ, 'XDG_STATE_HOME', '.local/state')
        host = f['host'](clock=clock, sleep=sleep)
        helpers = f['helpers'](_xdg(environ, 'XDG_DATA_HOME', '.local/share'), clock=clock)
        return Env(state_dir, host, helpers, notify, clock=clock, sleep=sleep,
                   target=None if mode == 'timer' else target)
    except Exception as e:
        raise EnvFailed(e, notify, state_dir) from e


def _start_failed(e, clock=time.time):
    """make_env failed: the critical notice of the top-level catch (once per UTC day per text), and 70."""
    if not isinstance(e, EnvFailed):
        e = EnvFailed(e)
    text = f'🔥 wbb-deploy: could not start, nothing judged: {e}'
    print(text, file=sys.stderr)
    if e.notify is None:
        return 70
    env = Env(e.state_dir or '', None, None, e.notify, clock=clock, out=lambda line: print(line, file=sys.stderr))
    if e.state_dir is None:
        _notify(env, text)
        return 70
    try:
        os.makedirs(e.state_dir, exist_ok=True)
        _internal(env, text)
    except OSError as err:
        print(f'WARNING: {e.state_dir}: {type(err).__name__}: {err}', file=sys.stderr)
    return 70


def _full_sha(value):
    if not FULL_SHA.fullmatch(value):
        raise argparse.ArgumentTypeError(f'not a full lowercase SHA: {value!r}')
    return value


def main(argv=None, make_env=make_env, geteuid=os.geteuid):
    """`tick.py timer` | `tick.py deploy --target <sha> [--force] [--ack-holds KEY ...]` |
    `tick.py rearm --sha <sha>` | `tick.py ack-baseline --from <sha>` (by hand only; see `operator`).

    make_env(mode, target) builds the Env with the real Host and Helpers; if it fails, the tick does not run:
    a critical notice (when notify was built) and exit 70. --target is the operator's checkout HEAD
    (deploy.sh passes it — Б-периферія).
    """
    p = argparse.ArgumentParser(prog='tick.py')
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('timer')
    d = sub.add_parser('deploy')
    d.add_argument('--target', required=True, type=_full_sha, metavar='SHA')
    d.add_argument('--force', action='store_true')
    d.add_argument('--ack-holds', nargs='+', default=[], metavar='KEY')
    sub.add_parser('rearm').add_argument('--sha', required=True, type=_full_sha, metavar='SHA')
    sub.add_parser('ack-baseline').add_argument('--from', dest='from_sha', required=True, type=_full_sha,
                                                metavar='SHA')
    try:
        args = p.parse_args(argv)
    except SystemExit:
        return 64
    if geteuid() == 0:
        print('ERROR: run the deploy as the operator, not as root or via sudo — it calls sudo itself, per step.',
              file=sys.stderr)
        return 64
    if args.command in OPERATOR:
        try:
            env = make_env('manual', None)
        except Exception as e:
            return _start_failed(e)
        return operator(env, args.command, args.sha if args.command == 'rearm' else args.from_sha)
    mode = 'timer' if args.command == 'timer' else ('force' if args.force else 'manual')
    try:
        env = make_env(mode, getattr(args, 'target', None))
    except Exception as e:
        return _start_failed(e)
    return tick(env, mode, getattr(args, 'ack_holds', []))


if __name__ == '__main__':
    sys.exit(main())
