"""tick.tick over the engine's fake host (fake_host.World), scripted Helpers and a recording notify.

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-a.md, Task 3. The clock is
the World's: nothing here sleeps for real, a window of 600 s is a loop of host.sleep calls.
"""
import contextlib
import email.message
import fcntl
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import activate  # noqa: E402
import gates  # noqa: E402
import tick  # noqa: E402
import tick_state  # noqa: E402
import tree_manifest as tm  # noqa: E402
from activate import HostError  # noqa: E402
from deploy_state import Pre, Release, Settled, State  # noqa: E402
from fake_helpers import Clone, FakeHelpers  # noqa: E402
from fake_host import BOOT_A, PRE_DB, T0, Crash, FakeHost, MemoryStore, World  # noqa: E402
from gates import Ci, Pr  # noqa: E402
import github_trust as gt  # noqa: E402
import test_github_trust as tg  # noqa: E402
from github_trust import NoRunYet, Untrusted  # noqa: E402
from helpers import HelperError, Run  # noqa: E402
from tick_state import Abort, Blocked, Noop, Regression, Seen, TickState  # noqa: E402

OLD = 'b' * 40
CAND = 'c' * 40
OTHER = 'e' * 40
TRUSTED = object()
ZIP = '/home/ysi/.cache/wbb/ccccccc.zip'
DAY = 86400


def manifest(index, release):
    es = [{'path': 'dist', 'type': 'dir', 'mode': 0o755},
          {'path': 'dist/index.js', 'type': 'file', 'mode': 0o644, 'size': 10, 'sha256': index * 64},
          {'path': 'release.json', 'type': 'file', 'mode': 0o644, 'size': 200, 'sha256': release * 64}]
    return tm.canonical_bytes({'formatVersion': 1, 'entries': es})


MANIFESTS = {OLD: manifest('1', 'a'), CAND: manifest('2', 'b')}
TREES = {sha: hashlib.sha256(m).hexdigest() for sha, m in MANIFESTS.items()}
SETTLED = Settled(OLD, TREES[OLD], T0 - DAY)
SETTLED_STATE = State('settled', BOOT_A, settled=SETTLED)
HELD = 'path:deploy/release/tick.py'
SETTLED_NOTE = '✅ wbb-deploy ccccccc is live and settled.'

# Every helper call of a tick that admits main after its quiet and takes it to the engine, in order:
# admission (ancestry, installed copies, the range, CI), prepare (audit before any execution), then the
# gates once more right before begin (main, installed copies, the range).
ADMIT = ['fetch_main', 'is_ancestor', 'installed_stale', 'changed_paths', 'commits', 'pr_labels', 'trusted']
PREPARE = ['download', 'publish', 'verify', 'verify', 'manifest', 'manifest', 'audit', 'probe', 'snapshot_pre',
           'trial']
RECHECK = ['fetch_main', 'installed_stale', 'changed_paths', 'commits', 'pr_labels']


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = self._tmp.name
        self.world = World(base, OLD, CAND, trees=TREES)
        self.host = FakeHost(self.world)
        self.store = MemoryStore(state=SETTLED_STATE)
        self.dir = os.path.join(base, 'state')
        self.pre = Pre(self.world.pre, hashlib.sha256(PRE_DB).hexdigest(), T0 - 60)
        self.notes, self.lines, self.sleeps = [], [], []
        self.notify_ok = True
        self.h = self.helpers()

    def tearDown(self):
        self._tmp.cleanup()

    def helpers(self, **answers):
        defaults = dict(
            fetch_main=CAND, is_ancestor=lambda a, b: True, installed_stale=None,
            changed_paths=('src/index.ts',), commits=(CAND,), pr_labels=(Pr(41, ('dependencies',)),),
            trusted=TRUSTED, download=ZIP, publish=Run(0, 'ACCEPTED'),
            verify=lambda sha: Run(0, 'VERIFIED', f'VERIFIED {sha}', TREES[sha]),
            manifest=lambda sha: MANIFESTS[sha], audit=Run(0, 'CLEAN', 'AUDIT CLEAN', TREES[CAND]),
            probe=Run(0, 'OK', 'PROBE OK'), snapshot_pre=self.pre, trial=Run(0, 'OK', 'TRIAL OK'), discard_pre=None,
        )
        return FakeHelpers(**{**defaults, **answers})

    def notify(self, text):
        self.notes.append(text)
        return self.notify_ok

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.world.now += seconds

    def env(self, mode='timer', helpers=None, target=None):
        return tick.Env(self.dir, self.host, helpers or self.h, self.notify, clock=lambda: self.world.now,
                        sleep=self.sleep, store=self.store, target=target, out=self.lines.append)

    def tick(self, mode='timer', ack=(), helpers=None):
        return tick.tick(self.env(mode, helpers, None if mode == 'timer' else CAND), mode, ack)

    def ts(self):
        return tick_state.load(os.path.join(self.dir, tick_state.STATE_NAME))

    def quiet(self):
        """The first tick sees main and starts its quiet; the clock then moves past it."""
        self.assertEqual(self.tick(), 0)
        self.world.now += gates.QUIET_S
        self.h.calls.clear()

    def at(self, phase, intent=None):
        """An activation of CAND begun and stepped (by the engine itself) until phase/intent is persisted."""
        activate.begin(self.store, self.host, Release(CAND, TREES[CAND]), self.pre)
        while (self.store.load().phase, self.store.load().intent) != (phase, intent):
            activate.step(self.store, self.host)
        return self.store.load()


class HappyPath(Base):
    def test_a_quiet_green_main_goes_to_settled_with_one_notification(self):
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.h.names(), ['fetch_main', 'is_ancestor'])
        self.assertEqual(self.ts().main_seen, Seen(CAND, T0))
        self.world.now += gates.QUIET_S
        self.h.calls.clear()

        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.h.names(), ADMIT + PREPARE + RECHECK)
        self.assertEqual(self.h.calls[2], ('installed_stale', gates.INSTALLED_COPIES))
        s = self.store.load()
        self.assertEqual((s.phase, s.settled.sha, s.last_failed_sha), ('settled', CAND, None))
        self.assertEqual(self.notes, [SETTLED_NOTE])
        self.assertEqual(self.ts().notified_txn, s.last_txn)
        self.assertEqual(self.world.violations, [])

        self.h.calls.clear()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.h.names(), ['fetch_main', 'is_ancestor', 'installed_stale'])
        self.assertEqual(self.notes, [SETTLED_NOTE])
        self.assertEqual(self.ts().last_seen_settled, CAND)

    def test_an_idle_timer_reminds_of_a_stale_deployer_once_a_day(self):
        # Controller adjustment (b): main == settled, the installed copies differ.
        self.store = MemoryStore(state=SETTLED_STATE)
        h = self.helpers(fetch_main=OLD, installed_stale='STALE: deploy/release/tick.py')
        text = ('⚠️ wbb-deploy: up to date at bbbbbbb; the installed deployer is out of date:\n'
                'STALE: deploy/release/tick.py')
        self.assertEqual([self.tick(helpers=h), self.tick(helpers=h)], [0, 0])
        self.assertEqual(self.notes, [text])
        self.world.now += DAY
        self.assertEqual(self.tick(helpers=h), 0)
        self.assertEqual(self.notes, [text, text])


class Paused(Base):
    def touch_paused(self):
        os.makedirs(self.dir, exist_ok=True)
        open(os.path.join(self.dir, 'PAUSED'), 'w').close()

    def test_a_pending_rollback_is_finished_under_paused_and_nothing_is_admitted(self):
        self.world.healthy = lambda sha, age: sha != CAND
        self.at('rolling-back', 'stop-writers')
        self.touch_paused()
        h = FakeHelpers()  # any helper call would be an admission: it raises
        self.assertEqual(self.tick(helpers=h), 2)
        self.assertEqual(h.calls, [])
        s = self.store.load()
        self.assertEqual((s.phase, s.settled.sha, s.last_failed_sha), ('settled', OLD, CAND))
        # The engine's own account of the rollback (which writes live only in which post), verbatim.
        record = [e['result'] for e in s.evidence if e['what'] == 'rolled-back']
        self.assertEqual(self.notes, [f'🔥 wbb-deploy ROLLED BACK ccccccc → bbbbbbb, code AND database.\n{record[0]}\n'
                                      'A human must reconcile; nothing will do it automatically.'])

    def test_paused_and_idle_is_silent(self):
        self.touch_paused()
        h = FakeHelpers()
        self.assertEqual(self.tick(helpers=h), 0)
        self.assertEqual((h.calls, self.notes), ([], []))
        self.assertEqual(self.lines, ['paused (PAUSED exists); no new deploy'])

    def test_paused_does_not_stop_a_human(self):
        self.touch_paused()
        self.assertEqual(self.tick('manual'), 0)
        self.assertEqual(self.store.load().settled.sha, CAND)


class OncePerTransaction(Base):
    def test_a_tick_that_dies_before_its_notification_leaves_it_to_the_next_exactly_once(self):
        self.quiet()

        def dies(text):
            raise Crash('the tick is killed before notify returns')

        env = self.env()
        env.notify = dies
        with self.assertRaises(Crash):
            tick.tick(env, 'timer')
        self.assertEqual(self.store.load().settled.sha, CAND)
        self.assertEqual(self.ts().notified_txn, None)

        self.assertEqual([self.tick(), self.tick()], [0, 0])
        self.assertEqual(self.notes, [SETTLED_NOTE])

    def test_a_failed_send_is_retried_by_the_next_tick(self):
        self.quiet()
        self.notify_ok = False
        self.assertEqual(self.tick(), 0)
        self.notify_ok = True
        self.assertEqual([self.tick(), self.tick()], [0, 0])
        self.assertEqual(self.notes, [SETTLED_NOTE, SETTLED_NOTE])
        self.assertEqual(self.lines.count(f'WARNING: notify failed: {SETTLED_NOTE}'), 1)


class BlockedWithTheBotDown(Base):
    """Ф3: critical at once (per txn and step), once more after 15 min of the same block, not more often."""

    def test_critical_at_once_and_after_fifteen_minutes(self):
        s = self.at('activating', 'start')
        self.world.errors['start_bot'] = HostError('sudo: a terminal is required')
        h = FakeHelpers()
        critical = ('🔥 wbb-deploy: the bot is DOWN — activating/start is blocked: start: sudo: a terminal is '
                    'required. Every tick retries it; a human may be needed (sudo, systemctl).')
        again = f'{critical}\nStill blocked after 15 min.'
        codes = []
        for at in (0, 60, 899, 900, 960, 1800):
            self.world.now = T0 + at
            codes.append(self.tick(helpers=h))
        self.assertEqual(codes, [3] * 6)
        self.assertEqual(self.notes, [critical, again])
        self.assertEqual(self.ts().blocked, Blocked(s.txn, 'activating/start', T0, 2))
        self.world.now = T0 + DAY
        self.assertEqual(self.tick(helpers=h), 3)
        self.assertEqual(self.notes, [critical, again, critical])
        self.assertEqual(h.calls, [])

        del self.world.errors['start_bot']
        self.assertEqual(self.tick(helpers=h), 0)
        self.assertEqual(self.notes[3:], [SETTLED_NOTE])
        self.assertEqual(self.ts().blocked, None)

    def test_a_baseline_that_does_not_come_back_is_the_same_critical_alert(self):
        self.world.healthy = lambda sha, age: False
        s = self.at('rolling-back', 'start-baseline')
        self.assertEqual(self.tick(helpers=FakeHelpers()), 3)
        self.assertEqual(self.notes, [
            '🔥 wbb-deploy: the bot is DOWN — rolling-back/start-baseline is blocked: start-baseline: bbbbbbb not '
            'healthy within 120 s (last: ok=False releaseSha=bbbbbbb). Every tick retries it; a human may be needed '
            '(sudo, systemctl).'])
        self.assertEqual(self.ts().blocked.step, 'rolling-back/start-baseline')
        self.assertEqual(self.ts().blocked.txn, s.txn)

    def test_a_block_with_the_bot_still_running_is_a_daily_reminder(self):
        self.at('activating', 'stop')
        self.world.errors['stop_bot'] = HostError('sudo: a password is required')
        h = FakeHelpers()
        self.assertEqual([self.tick(helpers=h), self.tick(helpers=h)], [0, 0])
        self.assertEqual(self.notes, ['⚠️ wbb-deploy: activating/stop is blocked: stop: sudo: a password is '
                                      'required. The next tick retries.'])
        self.assertEqual(self.ts().blocked, None)


class AbortBackoff(Base):
    """Ф7: an aborted SHA waits 1 h, then 2 h, … (gates.backoff_s), counted once per transaction."""

    def abort(self, count):
        a = self.ts().abort
        self.assertEqual((a.sha, a.count, a.txn), (CAND, count, self.store.load().last_txn))
        return a

    def retry_after(self, a, backoff):
        """A tick one second before the backoff ends prepares nothing; the one at its end tries again."""
        self.world.now = a.at + backoff - 1
        self.h.calls.clear()
        self.assertEqual(self.tick(), 0)
        # settled did not move (observe asks nothing); ancestry is read before the backoff stops the tick
        self.assertEqual(self.h.names(), ['fetch_main', 'is_ancestor'])
        self.world.now += 1
        return self.tick()

    def test_three_aborts_back_off_and_never_fail_the_sha(self):
        self.world.tampered = {CAND}
        self.quiet()
        self.assertEqual(self.tick(), 0)
        first = self.abort(1)
        self.assertEqual(self.retry_after(first, 3600), 0)
        second = self.abort(2)
        self.assertEqual(self.retry_after(second, 7200), 0)
        self.abort(3)
        self.assertEqual(self.store.load().last_failed_sha, None)
        self.assertEqual(len(self.notes), 3)
        self.assertEqual(self.notes[2], (
            '⚠️ wbb-deploy: the activation of ccccccc was aborted: switch to ccccccc refused: '
            f'{CAND}: release tree changed:\ndist/index.js: differs from manifest (sha256). ccccccc never started; '
            'back on bbbbbbb, database untouched. No verdict on it; the timer retries after a backoff.'))


class DriftOrUnreachable(Base):
    def test_a_bot_that_does_not_answer_is_unreachable_after_three_probes_ten_seconds_apart(self):
        self.world.stop_bot()
        h = FakeHelpers()
        self.assertEqual(self.tick(helpers=h), 0)
        self.assertEqual([t for t, _ in self.world.health_calls], [T0, T0, T0 + 10, T0 + 20])
        self.assertEqual(self.notes, ['⚠️ wbb-deploy: the bot does not answer /health (3 probes, 10 s apart); '
                                      'settled is bbbbbbb. Not a release incident: check the bot unit.'])
        self.assertEqual(h.calls, [])

    def test_another_release_answering_is_drift(self):
        self.world.running = CAND
        self.assertEqual(self.tick(helpers=FakeHelpers()), 0)
        self.assertEqual(len(self.world.health_calls), 2)
        self.assertEqual(self.notes, ['⚠️ wbb-deploy: production drift — settled is bbbbbbb, current is bbbbbbb, '
                                      'the running process says ccccccc. Nothing is done; unattended deploys wait '
                                      'until a human decides.'])


class ByHandThroughDrift(Base):
    """(stage A review S4) a human deploys through drift and `unreachable`; begin re-verifies both trees."""

    def another_release_answering(self, mode):
        self.world.running = CAND
        self.assertEqual(self.tick(mode), 0)
        self.assertEqual(self.store.load().settled.sha, CAND)
        self.assertEqual(self.lines[0], '⚠️ wbb-deploy: production drift or no answer — settled is bbbbbbb, '
                                        'current is bbbbbbb, the running process says ccccccc. Deploying by hand '
                                        'anyway.')
        self.assertEqual(self.notes, [SETTLED_NOTE])

    def test_another_release_answering_by_hand(self):
        self.another_release_answering('manual')

    def test_another_release_answering_forced(self):
        self.another_release_answering('force')

    def test_a_bot_that_does_not_answer(self):
        self.world.stop_bot()
        self.assertEqual(self.tick('manual'), 0)
        self.assertEqual((self.store.load().settled.sha, self.world.running), (CAND, CAND))
        self.assertEqual(self.notes, [SETTLED_NOTE])

    def test_a_tree_that_does_not_verify_still_stops_it_before_the_bot(self):
        self.world.running = CAND
        self.world.accepted = {CAND}
        self.assertEqual(self.tick('manual'), 1)
        self.assertEqual(self.store.load(), SETTLED_STATE)
        self.assertEqual((self.world.running, self.world.starts), (CAND, []))
        self.assertEqual(self.h.calls[-1], ('discard_pre', self.pre))


class NeverAVerdict(Base):
    def test_an_unexpected_exception_is_exit_70_with_one_critical_notice_and_no_failed_sha(self):
        self.world.errors['current'] = RuntimeError('readlink: unexpected')
        h = FakeHelpers()
        self.assertEqual([self.tick(helpers=h), self.tick(helpers=h)], [70, 70])
        self.assertEqual(self.notes, ['🔥 wbb-deploy: internal error, nothing judged: RuntimeError: readlink: '
                                      'unexpected'])
        self.assertEqual((h.calls, self.store.load()), ([], SETTLED_STATE))
        self.world.now += DAY
        self.assertEqual(self.tick(helpers=h), 70)
        self.assertEqual(len(self.notes), 2)

    def cannot_assess(self, why, **answers):
        """(stage A review S5) not 70: the helper did not answer, nothing is judged — a daily wait; by hand, 1."""
        self.h = self.helpers(**answers)
        text = f'⚠️ wbb-deploy: cannot assess {why} — nothing judged; unattended deploys wait.'
        self.assertEqual([self.tick(), self.tick()], [0, 0])
        self.world.now += gates.QUIET_S
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.notes, [text])
        self.world.now += DAY
        self.assertEqual([self.tick(), self.tick('manual')], [0, 1])
        self.assertEqual(self.notes, [text, text])
        self.assertEqual(self.lines[-1], text)
        self.assertEqual(self.store.load(), SETTLED_STATE)

    def test_git_that_cannot_answer_ancestry_is_a_daily_wait(self):
        self.cannot_assess('ancestry: HelperError: git: index.lock exists',
                           is_ancestor=HelperError('git: index.lock exists'))

    def test_an_installed_check_that_raises_is_a_daily_wait(self):
        self.cannot_assess('the installed copies: HelperError: sudo: unable to resolve host',
                           installed_stale=HelperError('sudo: unable to resolve host'))

    def test_a_transient_prepare_is_a_daily_notice_and_no_failed_sha(self):
        self.h = self.helpers(audit=Run(75, 'UNRUNNABLE', 'AUDIT UNRUNNABLE: registry 503'))
        self.quiet()
        self.assertEqual([self.tick(), self.tick()], [0, 0])
        self.assertEqual(self.notes, ['⚠️ wbb-deploy could not prepare ccccccc (audit): exit 75, UNRUNNABLE: AUDIT '
                                      'UNRUNNABLE: registry 503 — not a verdict; the next tick tries again.'])
        self.assertEqual(self.store.load(), SETTLED_STATE)

    def test_a_state_that_cannot_be_written_is_exit_4(self):
        class ReadOnly(MemoryStore):
            def save(self, state):
                raise PermissionError(13, 'Permission denied')

        self.store = ReadOnly(state=SETTLED_STATE)
        self.quiet()
        self.assertEqual(self.tick(), 4)
        self.assertEqual(self.notes, ['🔥 wbb-deploy: failed to write the engine state: PermissionError: [Errno 13] '
                                      'Permission denied — its record may now disagree with production.'])


class BrokenTickState(Base):
    """(stage A review S3) the engine finishes a pending phase before a broken tick-state.json stops the tick."""

    def break_tick_state(self):
        os.makedirs(self.dir, exist_ok=True)
        with open(os.path.join(self.dir, tick_state.STATE_NAME), 'wb') as f:
            f.write(b'{')

    def test_a_rollback_in_flight_completes_then_exit_70(self):
        self.world.healthy = lambda sha, age: sha != CAND
        self.at('rolling-back', 'stop-writers')
        self.break_tick_state()
        h = FakeHelpers()
        self.assertEqual(self.tick(helpers=h), 70)
        s = self.store.load()
        self.assertEqual((s.phase, s.settled.sha, s.last_failed_sha), ('settled', OLD, CAND))
        self.assertEqual((self.world.current, self.world.running, h.calls), (OLD, OLD, []))
        record = [e['result'] for e in s.evidence if e['what'] == 'rolled-back']
        path = os.path.join(self.dir, tick_state.STATE_NAME)
        self.assertEqual(self.notes, [
            f'🔥 wbb-deploy ROLLED BACK ccccccc → bbbbbbb, code AND database.\n{record[0]}\n'
            'A human must reconcile; nothing will do it automatically.',
            '🔥 wbb-deploy: internal error, nothing judged: StateError: '
            f'{path}: not JSON (Expecting property name enclosed in double quotes: line 1 column 2 (char 1)); '
            'the engine: rolled-back: ' + self.store.load().evidence[-1]['result']])

    def test_idle_with_a_broken_tick_state_is_exit_70_and_admits_nothing(self):
        self.break_tick_state()
        h = FakeHelpers()
        self.assertEqual(self.tick(helpers=h), 70)
        path = os.path.join(self.dir, tick_state.STATE_NAME)
        self.assertEqual(self.notes, ['🔥 wbb-deploy: internal error, nothing judged: StateError: '
                                      f'{path}: not JSON (Expecting property name enclosed in double quotes: line 1 '
                                      'column 2 (char 1))'])
        self.assertEqual((h.calls, self.store.load()), ([], SETTLED_STATE))


class PrivateClone(Base):
    """Helpers.is_ancestor answers False for a commit the clone does not have (stage A review S5), so the clone
    is fetched before anything asks it (S6)."""

    def test_a_manual_target_the_clone_does_not_have_is_not_reachable_from_main(self):
        clone = Clone({OTHER: OLD}, known={OLD, OTHER})
        self.h = self.helpers(fetch_main=OTHER, is_ancestor=clone.is_ancestor)
        self.assertEqual(self.tick('manual'), 1)
        self.assertEqual(self.lines, ['⛔ wbb-deploy: ccccccc is not reachable from main eeeeeee'])
        self.assertEqual((self.notes, self.store.load()), ([], SETTLED_STATE))

    def settled_on_cand_seen_at_old(self):
        """CAND settled (by hand, elsewhere) after the fence last saw OLD; the clone has only OLD so far."""
        os.makedirs(self.dir)
        tick_state.save(os.path.join(self.dir, tick_state.STATE_NAME), TickState(last_seen_settled=OLD))
        self.store = MemoryStore(state=State('settled', BOOT_A, settled=Settled(CAND, TREES[CAND], T0 - 60)))
        self.world.current = self.world.running = CAND
        return Clone({CAND: OLD}, known={OLD})

    def test_the_clone_is_fetched_before_the_fence_looks_at_settled(self):
        clone = self.settled_on_cand_seen_at_old()
        h = self.helpers(fetch_main=lambda: clone.fetch(CAND) or CAND, is_ancestor=clone.is_ancestor)
        self.assertEqual(self.tick(helpers=h), 0)
        self.assertEqual(h.names(), ['fetch_main', 'is_ancestor', 'installed_stale'])
        self.assertEqual((self.ts().last_seen_settled, self.ts().regression, self.notes), (CAND, None, []))

    def test_a_failed_fetch_observes_nothing(self):
        clone = self.settled_on_cand_seen_at_old()
        h = self.helpers(fetch_main=HelperError('could not resolve host'), is_ancestor=clone.is_ancestor)
        self.assertEqual(self.tick(helpers=h), 0)
        self.assertEqual(h.names(), ['fetch_main'])
        self.assertEqual((self.ts().last_seen_settled, self.ts().regression), (OLD, None))
        self.assertEqual(self.notes, ['⚠️ wbb-deploy: could not fetch main'])


class Verdicts(Base):
    def test_a_failed_probe_is_the_failed_sha_reported_once(self):
        self.h = self.helpers(probe=Run(1, 'FAILED', 'PROBE FAILED: ABI 137 != 127'))
        self.quiet()
        self.assertEqual(self.tick(), 1)
        self.assertEqual(self.store.load(), SETTLED_STATE.replace(last_failed_sha=CAND))
        self.assertEqual(self.notes, ['⛔ wbb-deploy refused ccccccc: PROBE FAILED\nPROBE FAILED: ABI 137 != 127'])
        self.h.calls.clear()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.h.names(), ['fetch_main', 'is_ancestor', 'installed_stale'])
        self.assertEqual(len(self.notes), 1)

    def test_a_verdict_whose_notify_failed_is_sent_by_the_next_tick(self):
        # #827 AI review: lastFailedSha stops the SHA from being prepared again, so the message is the
        # one thing that must survive a failed notify — persisted first, cleared only once it went out.
        self.h = self.helpers(probe=Run(1, 'FAILED', 'PROBE FAILED: ABI 137 != 127'))
        self.quiet()
        self.notify_ok = False
        self.assertEqual(self.tick(), 1)
        self.notify_ok = True
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.tick(), 0)
        text = '⛔ wbb-deploy refused ccccccc: PROBE FAILED\nPROBE FAILED: ABI 137 != 127'
        self.assertEqual(self.notes, [text, text])
        self.assertEqual(self.store.load(), SETTLED_STATE.replace(last_failed_sha=CAND))

    def queued(self, *verdicts):
        tick_state.save(os.path.join(self.dir, tick_state.STATE_NAME),
                        tick_state.TickState(pending_verdicts=tuple(verdicts)))

    def test_a_new_verdict_queues_behind_one_still_undelivered(self):
        # #827 AI review, second pass: a single slot let the next verdict overwrite the undelivered one.
        os.makedirs(self.dir, exist_ok=True)
        self.queued(tick_state.Verdict(OTHER, '⛔ older verdict', True))
        self.h = self.helpers(probe=Run(1, 'FAILED', 'PROBE FAILED: ABI 137 != 127'))
        self.notify_ok = False
        self.quiet()
        self.assertEqual(self.tick(), 1)
        self.notify_ok = True
        self.notes.clear()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.notes, ['⛔ older verdict',
                                      '⛔ wbb-deploy refused ccccccc: PROBE FAILED\nPROBE FAILED: ABI 137 != 127'])

    def test_a_verdict_whose_engine_write_never_landed_is_finished_before_anything_else(self):
        # #827 AI review, second pass: the message is queued before lastFailedSha is written; a tick that died
        # between the two left the gates unaware. The next tick writes it, sends, and never prepares the SHA.
        os.makedirs(self.dir, exist_ok=True)
        self.queued(tick_state.Verdict(CAND, '⛔ refused ccccccc', False))
        self.h = self.helpers()
        self.assertEqual(self.tick(), 0)
        self.assertEqual((self.store.load(), self.notes), (SETTLED_STATE.replace(last_failed_sha=CAND),
                                                           ['⛔ refused ccccccc']))
        self.assertEqual('download' in self.h.names(), False)

    def test_a_full_verdict_queue_stops_new_preparation_and_drops_nothing(self):
        # #827 AI review, third pass: the queue was sliced to its newest ten, dropping the oldest.
        os.makedirs(self.dir, exist_ok=True)
        old = tuple(tick_state.Verdict(f'{i:x}' * 40, f'⛔ verdict {i}', True) for i in range(1, 11))
        self.queued(*old)
        self.notify_ok = False
        self.h = self.helpers()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.h.names(), [])
        self.assertEqual(tick_state.load(os.path.join(self.dir, tick_state.STATE_NAME)).pending_verdicts, old)

    def test_an_unrecorded_verdict_waits_while_the_engine_is_not_settled(self):
        # #827 AI review, third pass: it was marked recorded (and could be sent) with lastFailedSha written nowhere.
        os.makedirs(self.dir, exist_ok=True)
        self.queued(tick_state.Verdict(CAND, '⛔ refused ccccccc', False))
        self.store = MemoryStore()
        self.h = self.helpers()
        # The tick goes on to its usual answer for a missing baseline (a hold, not an internal error); the
        # verdict is not sent, not dropped, still unrecorded.
        self.assertEqual(self.tick(), 1)
        self.assertEqual([n.startswith('⏸ wbb-deploy: no settled baseline') for n in self.notes], [True])
        self.assertEqual(tick_state.load(os.path.join(self.dir, tick_state.STATE_NAME)).pending_verdicts,
                         (tick_state.Verdict(CAND, '⛔ refused ccccccc', False),))

    def test_a_huge_verdict_is_cut_before_it_is_kept(self):
        # #827 AI review, second pass: the tick-state file is refused over 1 MiB; the queued text is cut first.
        self.h = self.helpers(probe=Run(1, 'FAILED', 'PROBE FAILED: ' + 'x' * (2 << 20)))
        self.notify_ok = False
        self.quiet()
        self.assertEqual(self.tick(), 1)
        self.assertEqual(len(tick_state.load(os.path.join(self.dir, tick_state.STATE_NAME)).pending_verdicts[0].text),
                         tick.NOTIFY_LIMIT + len('\n… truncated'))

    def test_a_verdict_carries_the_note_of_a_pre_that_could_not_be_discarded(self):
        self.h = self.helpers(trial=Run(1, 'FAILED', 'TRIAL FAILED: migrate: no such table'),
                              discard_pre=HelperError('sudo: unable to remove'))
        self.quiet()
        self.assertEqual(self.tick(), 1)
        self.assertEqual(len(self.notes), 1)
        self.assertEqual(self.notes[0].startswith('⛔ wbb-deploy refused ccccccc: TRIAL FAILED\nTRIAL FAILED: migrate: '
                                                  'no such table\n'), True)
        self.assertEqual('sudo: unable to remove' in self.notes[0], True)

    def test_a_payload_equal_to_settled_is_noop_and_not_prepared_again(self):
        noop = {**MANIFESTS, CAND: manifest('1', 'c')}
        trees = {sha: hashlib.sha256(m).hexdigest() for sha, m in noop.items()}
        self.h = self.helpers(manifest=lambda sha: noop[sha],
                              verify=lambda sha: Run(0, 'VERIFIED', '', trees[sha]))
        self.quiet()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.ts().noop, Noop(CAND, OLD))
        self.assertEqual(self.h.names(), ADMIT + PREPARE[:6])
        self.h.calls.clear()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.h.names(), ['fetch_main', 'installed_stale'])
        self.assertEqual((self.notes, self.store.load()), ([], SETTLED_STATE))

    def test_a_noop_found_against_another_settled_release_is_prepared_again(self):
        # (stage A review B1) CAND was a noop against OTHER; OLD is settled now, so CAND's payload is
        # compared again — and it differs: the deploy goes on to settled.
        os.makedirs(self.dir)
        tick_state.save(os.path.join(self.dir, tick_state.STATE_NAME), TickState(noop=Noop(CAND, OTHER)))
        self.quiet()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.h.names(), ADMIT + PREPARE + RECHECK)
        self.assertEqual(self.store.load().settled.sha, CAND)


class Holds(Base):
    def setUp(self):
        super().setUp()
        self.h = self.helpers(changed_paths=('deploy/release/tick.py', 'src/index.ts'))

    def test_the_timer_is_held_and_says_so_once_a_day(self):
        self.quiet()
        self.assertEqual([self.tick(), self.tick()], [1, 1])
        self.assertEqual(self.notes, ['⏸ wbb-deploy: held:\n• path deploy/release/tick.py needs a human step\n'
                                      f'Do the steps, then run: bash deploy/deploy.sh --ack-holds {HELD}'])
        self.assertNotIn('download', self.h.names())

    def test_by_hand_only_the_shown_acknowledgement_passes(self):
        self.assertEqual(self.tick('manual'), 1)
        self.assertEqual((self.notes, self.store.load()), ([], SETTLED_STATE))
        self.assertEqual(self.tick('manual', ack=(HELD,)), 0)
        self.assertEqual(self.store.load().settled.sha, CAND)
        self.assertEqual(self.notes, [SETTLED_NOTE])

    def test_by_hand_needs_no_quiet(self):
        self.assertEqual(self.tick('force', ack=(HELD,)), 0)
        self.assertEqual(self.ts().main_seen, None)


class AckThrough(Base):
    """(stage A review S1) holds are read from the newest of settled and ackThrough that the target contains."""

    def noop_helpers(self, heads, **answers):
        noop = {**MANIFESTS, CAND: manifest('1', 'c')}
        trees = {sha: hashlib.sha256(m).hexdigest() for sha, m in noop.items()}
        return self.helpers(
            fetch_main=lambda: heads[0], manifest=lambda sha: noop[sha],
            verify=lambda sha: Run(0, 'VERIFIED', '', trees[sha]),
            changed_paths=lambda a, b: ('deploy/release/tick.py',) if a == OLD else ('src/x.ts',),
            commits=lambda a, b: (b,), **answers)

    def ranges(self):
        return [c for c in self.h.calls if c[0] in ('changed_paths', 'commits')]

    def test_an_acknowledged_noop_does_not_hold_the_next_merge(self):
        heads = [CAND]
        self.h = self.noop_helpers(heads, trusted=lambda sha: TRUSTED if sha == CAND else NoRunYet(
            f'no trusted CI run for {sha}'))
        self.assertEqual(self.tick('manual', ack=(HELD,)), 0)
        self.assertEqual((self.ts().noop, self.ts().ack_through), (Noop(CAND, OLD), CAND))
        self.assertEqual(self.store.load(), SETTLED_STATE)
        # OTHER is merged on top of CAND: only CAND..OTHER is a new range; it holds nothing.
        heads[0] = OTHER
        self.quiet()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.ranges(), [('changed_paths', CAND, OTHER), ('commits', CAND, OTHER)])
        self.assertEqual(self.h.calls[-1], ('trusted', OTHER))
        self.assertEqual(self.notes, [])

    def test_every_settle_acknowledges_through_itself(self):
        os.makedirs(self.dir)
        tick_state.save(os.path.join(self.dir, tick_state.STATE_NAME),
                        TickState(last_seen_settled=OLD, ack_through=OTHER))
        self.h = self.helpers(is_ancestor=lambda a, b: a == b or (a, b) == (OLD, CAND))
        self.quiet()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.store.load().settled.sha, CAND)
        self.assertEqual(self.ts().ack_through, OTHER)
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.ts().ack_through, CAND)

    def test_git_that_cannot_place_the_acknowledgement_is_a_wait(self):
        # (stage A review S5) not "the range is unreadable", not 70: ancestry could not be assessed.
        os.makedirs(self.dir)
        tick_state.save(os.path.join(self.dir, tick_state.STATE_NAME),
                        TickState(last_seen_settled=OLD, ack_through=OTHER))
        broken = HelperError('git: bad object eeeeeee')
        self.h = self.helpers(is_ancestor=lambda a, b: broken if OTHER in (a, b) else True)
        self.assertEqual(self.tick('manual'), 1)
        self.assertEqual(self.lines, ['⚠️ wbb-deploy: cannot assess ancestry: HelperError: git: bad object eeeeeee — '
                                      'nothing judged; unattended deploys wait.'])
        self.assertEqual(self.ranges(), [])

    def held_from_settled(self, edges):
        """A manual run of CAND with ackThrough OTHER, git history `edges` (and OLD <- CAND): held from OLD."""
        os.makedirs(self.dir)
        tick_state.save(os.path.join(self.dir, tick_state.STATE_NAME),
                        TickState(last_seen_settled=OLD, ack_through=OTHER))
        history = edges | {(OLD, CAND)}
        self.h = self.noop_helpers([CAND], is_ancestor=lambda a, b: a == b or (a, b) in history)
        self.assertEqual(self.tick('manual'), 1)
        self.assertEqual(self.ranges(), [('changed_paths', OLD, CAND), ('commits', OLD, CAND)])

    def test_an_acknowledgement_the_target_does_not_contain_is_ignored(self):
        self.held_from_settled({(OLD, OTHER)})

    def test_an_acknowledgement_older_than_settled_is_ignored(self):
        self.held_from_settled({(OTHER, OLD), (OTHER, CAND)})


class RecheckBeforeBegin(Base):
    def test_main_that_moved_during_preparation_stops_before_begin_and_drops_the_pre(self):
        heads = iter([CAND, CAND, OTHER])
        self.h = self.helpers(fetch_main=lambda: next(heads))
        self.quiet()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.h.names(), ADMIT + PREPARE + ['fetch_main', 'discard_pre'])
        self.assertEqual(self.h.calls[-1], ('discard_pre', self.pre))
        self.assertEqual(self.store.load(), SETTLED_STATE)
        self.assertEqual(self.world.starts, [])

    def test_paused_during_preparation_stops_the_timer_before_begin(self):
        def pause_then_ok(sha, name):
            open(os.path.join(self.dir, 'PAUSED'), 'w').close()
            return Run(0, 'OK', 'TRIAL OK')

        self.h = self.helpers(trial=pause_then_ok)
        self.quiet()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.h.calls[-1], ('discard_pre', self.pre))
        self.assertEqual(self.store.load(), SETTLED_STATE)


class BeginFails(Base):
    """(stage A review N2) whatever stops begin, the pre no activation will use is dropped — unless it is in use."""

    def not_begun(self, why):
        self.quiet()
        self.assertEqual([self.tick(), self.tick()], [0, 0])
        self.assertEqual(self.notes, [f'⚠️ wbb-deploy could not begin ccccccc: {why} — not a verdict; the next tick '
                                      'tries again.'])
        self.assertEqual([c for c in self.h.calls if c[0] == 'discard_pre'], [('discard_pre', self.pre)] * 2)
        self.assertEqual((self.store.load(), self.world.starts), (SETTLED_STATE, []))

    def test_refused_is_a_daily_notice_and_drops_the_pre(self):
        self.world.accepted = {CAND}
        self.not_begun(f'Refused: previous bbbbbbb does not verify: {OLD}: no receipt — not an accepted release')

    def test_a_host_error_is_a_daily_notice_and_drops_the_pre(self):
        self.world.errors['boot_id'] = HostError('sudo: a password is required')
        self.not_begun('HostError: sudo: a password is required')

    def test_a_state_write_that_fails_drops_the_pre_and_is_exit_4(self):
        class ReadOnly(MemoryStore):
            def save(self, state):
                raise PermissionError(13, 'Permission denied')

        self.store = ReadOnly(state=SETTLED_STATE)
        self.quiet()
        self.assertEqual(self.tick(), 4)
        self.assertEqual(self.h.calls[-1], ('discard_pre', self.pre))
        self.assertEqual(self.store.load(), SETTLED_STATE)

    def test_a_write_that_landed_before_it_failed_keeps_the_pre(self):
        class LandsThenFails(MemoryStore):
            def save(self, state):
                super().save(state)
                raise OSError(5, 'Input/output error: fsync of the directory')

        self.store = LandsThenFails(state=SETTLED_STATE)
        self.quiet()
        self.assertEqual(self.tick(), 4)
        self.assertEqual(self.h.names(), ADMIT + PREPARE + RECHECK)
        self.assertEqual((self.store.load().phase, self.store.load().pre), ('activating', self.pre))

    def test_a_store_that_cannot_be_read_after_the_failed_write_keeps_the_pre(self):
        class BrokenAfterWrite(MemoryStore):
            broken = False

            def save(self, state):
                self.broken = True
                raise OSError(5, 'Input/output error')

            def load(self):
                if self.broken:
                    raise OSError(5, 'Input/output error')
                return super().load()

        self.store = BrokenAfterWrite(state=SETTLED_STATE)
        self.quiet()
        self.assertEqual(self.tick(), 4)
        self.assertEqual(self.h.names(), ADMIT + PREPARE + RECHECK)


class ExitCodes(Base):
    """(stage A review: surviving mutations) a manual run whose own deploy did not happen is 1, whatever the
    timer's code for the same outcome; recovery-failed is 3; drift under PAUSED is the timer's silence."""

    def test_by_hand_an_aborted_activation_is_1(self):
        self.world.tampered = {CAND}
        self.assertEqual(self.tick('manual'), 1)
        self.assertEqual(self.ts().abort.count, 1)
        self.assertEqual(self.store.load().settled.sha, OLD)

    def test_by_hand_a_ci_that_has_not_concluded_is_1(self):
        self.h = self.helpers(trusted=NoRunYet(f'no trusted CI run for {CAND}'))
        self.assertEqual(self.tick('manual'), 1)
        self.assertEqual(self.lines, ['⚠️ wbb-deploy: CI has not concluded on ccccccc'])
        self.assertEqual(self.store.load(), SETTLED_STATE)

    def test_by_hand_an_unverified_release_is_1(self):
        self.at('observing')
        self.world.reboot()
        self.assertEqual(self.tick('manual', helpers=FakeHelpers()), 1)
        self.assertEqual(self.store.load().phase, 'unverified')

    def test_by_hand_settling_an_activation_this_run_did_not_begin_is_1(self):
        # The window of an earlier activation of CAND ends in this run's resume: not this run's deploy.
        self.at('observing')
        h = FakeHelpers()
        self.assertEqual(self.tick('manual', helpers=h), 1)
        self.assertEqual((self.store.load().settled.sha, h.calls, self.notes), (CAND, [], [SETTLED_NOTE]))

    def test_recovery_failed_is_3_every_tick_and_said_once(self):
        self.world.healthy = lambda sha, age: sha != CAND
        self.at('rolling-back', 'switch-previous')
        self.world.accepted = {CAND}
        h = FakeHelpers()
        self.assertEqual([self.tick(helpers=h), self.tick(helpers=h), self.tick('manual', helpers=h)], [3, 3, 3])
        self.assertEqual(self.store.load().phase, 'recovery-failed')
        self.assertEqual(self.notes, [f'🔥 wbb-deploy RECOVERY FAILED at switch-previous: {OLD}: no receipt — not an '
                                      'accepted release. Production state is UNKNOWN — the bot may be down. Manual '
                                      'intervention required; nothing new starts.'])
        self.assertEqual(h.calls, [])

    def test_drift_under_paused_is_silent_for_the_timer(self):
        self.world.running = CAND
        os.makedirs(self.dir)
        open(os.path.join(self.dir, 'PAUSED'), 'w').close()
        h = FakeHelpers()
        self.assertEqual(self.tick(helpers=h), 0)
        self.assertEqual((self.notes, self.lines, h.calls), ([], [], []))
        self.assertEqual(len(self.world.health_calls), 1)


class Unverified(Base):
    def test_reported_once_then_once_a_day(self):
        s = self.at('observing')
        self.world.reboot()
        h = FakeHelpers()
        self.assertEqual([self.tick(helpers=h), self.tick(helpers=h)], [0, 0])
        note = (f'⚠️ wbb-deploy ccccccc is live but UNVERIFIED: reboot during the window (boot {s.boot_id} -> '
                f'{self.world.boot}). Nothing was rolled back; unattended deploys are held until a human decides.')
        self.assertEqual(self.notes, [note])
        self.world.now += DAY
        self.assertEqual(self.tick(helpers=h), 0)
        self.assertEqual(self.notes, [note, note])
        self.assertEqual(h.calls, [])


class RegressionFence(Base):
    def setUp(self):
        super().setUp()
        # The tick last saw CAND settled; now OLD is (someone deployed an older commit by hand).
        os.makedirs(self.dir)
        tick_state.save(os.path.join(self.dir, tick_state.STATE_NAME), TickState(last_seen_settled=CAND))
        self.h = self.helpers(is_ancestor=lambda a, b: a == b or (a, b) == (OLD, CAND))
        self.went_back = ('⚠️ wbb-deploy: production went-backwards: ccccccc → bbbbbbb. Was this a deliberate rollback? '
                          'Unattended deploys are HELD; deploy main by hand to recover.')

    def test_a_backwards_settled_raises_the_fence_and_holds_the_timer(self):
        self.assertEqual(self.tick(), 1)
        self.assertEqual((self.ts().regression, self.ts().last_seen_settled), (Regression(CAND, OLD), OLD))
        self.assertEqual(self.notes, [self.went_back, '⏸ wbb-deploy: production regression ccccccc → bbbbbbb: '
                                                      'ccccccc does not contain ccccccc'])

    def test_the_brake_is_kept_when_the_report_fails_and_the_report_is_retried(self):
        self.notify_ok = False
        self.assertEqual(self.tick(), 0)
        self.assertEqual((self.ts().regression, self.ts().last_seen_settled), (Regression(CAND, OLD), CAND))
        self.notify_ok = True
        self.assertEqual(self.tick(), 1)
        self.assertEqual(self.notes[:2], [self.went_back, self.went_back])
        self.assertEqual(self.ts().last_seen_settled, OLD)


class Lock(Base):
    def hold(self):
        os.makedirs(self.dir, exist_ok=True)
        fd = os.open(os.path.join(self.dir, 'lock'), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(os.close, fd)
        return fd

    def read(self, name):
        with open(os.path.join(self.dir, name)) as f:
            return f.read()

    def test_a_busy_lock_is_reported_once_a_day_after_the_stall_period(self):
        self.hold()
        h = FakeHelpers()
        codes = []
        for at in (0, 2099, 2100, 2160):
            self.world.now = T0 + at
            codes.append(self.tick(helpers=h))
        self.assertEqual(codes, [0, 0, 0, 0])
        self.assertEqual(self.read('lock-busy-since'), str(T0))
        self.assertEqual(self.notes, ['⚠️ wbb-deploy: the deploy lock has been held for 35 min — no tick can run. '
                                      f'A stuck manual deploy? Check: fuser -v {self.dir}/lock'])
        self.assertEqual((h.calls, self.store.load()), ([], SETTLED_STATE))

    def test_a_busy_notice_another_tick_is_sending_is_not_waited_for(self):
        # #827 AI review, second pass: the notice's own lock is taken without waiting.
        self.hold()
        fd = os.open(os.path.join(self.dir, 'lock-notice.lock'), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(os.close, fd)
        self.world.now = T0
        self.assertEqual(self.tick(helpers=FakeHelpers()), 0)
        self.world.now = T0 + 2100
        self.assertEqual(self.tick(helpers=FakeHelpers()), 0)
        self.assertEqual(self.notes, [])

    def test_a_busy_record_older_than_two_stall_periods_starts_afresh(self):
        self.hold()
        self.world.now = T0
        self.tick(helpers=FakeHelpers())
        self.world.now = T0 + 2 * tick.LOCK_STALL_S
        self.tick(helpers=FakeHelpers())
        self.assertEqual(self.read('lock-busy-since'), str(T0 + 2 * tick.LOCK_STALL_S))
        self.assertEqual(self.notes, [])

    def test_a_tick_that_gets_the_lock_clears_the_busy_record(self):
        fd = self.hold()
        self.tick(helpers=FakeHelpers())
        fcntl.flock(fd, fcntl.LOCK_UN)
        self.assertEqual(self.tick(helpers=self.helpers(fetch_main=OLD)), 0)
        self.assertFalse(os.path.exists(os.path.join(self.dir, 'lock-busy-since')))

    def test_by_hand_waits_thirty_seconds_then_refuses(self):
        self.hold()
        self.assertEqual(self.tick('manual', helpers=FakeHelpers()), 1)
        self.assertEqual(self.sleeps, [1] * 30)
        self.assertEqual(self.lines, [f'ERROR: another deploy holds {self.dir}/lock (waited 30 s) — it is probably '
                                      'watching a rollback window. Retry when it ends.'])
        self.assertEqual(self.notes, [])

    def test_by_hand_takes_the_lock_released_while_it_waits(self):
        fd = self.hold()

        then = iter([lambda: None, lambda: None, lambda: fcntl.flock(fd, fcntl.LOCK_UN)])

        def release_on_third(seconds):
            self.sleep(seconds)
            next(then)()

        env = self.env('manual', target=CAND)
        env.sleep = release_on_third
        self.assertEqual(tick.tick(env, 'manual'), 0)
        self.assertEqual((len(self.sleeps), self.store.load().settled.sha), (3, CAND))


class Pieces(unittest.TestCase):
    def test_cut_counts_characters_not_bytes(self):
        self.assertEqual(tick.cut('є' * 3500), 'є' * 3500)
        self.assertEqual(tick.cut('є' * 3501), 'є' * 3500 + '\n… truncated')

    def test_ci_of_a_scripted_answer(self):
        cases = {
            'pass': (TRUSTED, Ci('pass', trusted=TRUSTED)),
            'no run yet': (NoRunYet('no trusted CI run'), Ci('pending', 'no trusted CI run')),
            'failed run': (gt.RunFailed('run 7: failure'), Ci('failed', 'run 7: failure')),
            # (stage A review S2) an Untrusted that is not CI's verdict is no failure: it cannot be read now.
            'other untrusted': (Untrusted('workflow_runs listing shows 1 of 2'),
                                Ci('unreadable', 'Untrusted: workflow_runs listing shows 1 of 2')),
            'network': (HelperError('gh: HTTP 502'), Ci('unreadable', 'HelperError: gh: HTTP 502')),
        }
        for name, (answer, expected) in cases.items():
            with self.subTest(name):
                self.assertEqual(tick.ci_of(FakeHelpers(trusted=answer), CAND), expected)

    def test_ci_of_the_real_client(self):
        """(stage A review S2) github_trust.GitHubApi over a scripted transport: what GitHub answers, as it fails."""
        runs = f'/repos/{tg.REPO}/actions/workflows/ci.yml/runs'
        jobs = f'/repos/{tg.REPO}/actions/runs/{tg.RUN}/attempts/2/jobs'

        def client(token='tok', **failures):
            data = dict(tg.GOOD, **{k: v for k, v in failures.items() if isinstance(v, dict)})

            def urlopen(req, timeout):
                path = req.full_url[len(gt.API):].split('?')[0]
                key = {runs: 'runs', jobs: 'jobs'}.get(path, 'artifacts')
                answer = failures.get(key, data[key])
                if isinstance(answer, Exception):
                    raise answer
                return tg.Response(json.dumps(answer).encode())
            return FakeHelpers(trusted=lambda sha: gt.fetch_trusted(gt.GitHubApi(token, urlopen), tg.REPO, sha))

        def http(code):
            return urllib.error.HTTPError('u', code, 'x', email.message.Message(), None)

        cases = {
            'green': (client(), Ci('pass', trusted=gt.fetch_trusted(tg.fake_api(tg.GOOD), tg.REPO, tg.SHA))),
            '502 on runs': (client(runs=http(502)), Ci('unreadable', f'Untrusted: GitHub API 502 for {runs}')),
            '503 on jobs': (client(jobs=http(503)), Ci('unreadable', f'Untrusted: GitHub API 503 for {jobs}')),
            'unreachable': (client(runs=urllib.error.URLError('refused')),
                            Ci('unreadable', f'Untrusted: GitHub API unreachable for {runs}: URLError')),
            'no token': (client(token=''), Ci('unreadable', 'Untrusted: no GitHub token')),
            'partial listing': (client(runs={'total_count': 2, 'workflow_runs': [tg.run(conclusion='failure')]}),
                                Ci('unreadable', 'Untrusted: workflow_runs listing shows 1 of 2; refusing to decide '
                                                 'on a partial list')),
            'no run yet': (client(runs=tg.listing('workflow_runs', [])),
                           Ci('pending', f'no trusted CI run for {tg.SHA}')),
            'run failed': (client(runs=tg.listing('workflow_runs', [tg.run(conclusion='failure')])),
                           Ci('failed', f"no trusted CI run for {tg.SHA} (run {tg.RUN}: conclusion='failure')")),
            'package failed': (client(jobs=tg.listing('jobs', [tg.job('package', 'failure'), tg.job('ci')])),
                               Ci('failed', f"run {tg.RUN} attempt 2: 'package' is completed/failure")),
        }
        for name, (helpers, expected) in cases.items():
            with self.subTest(name):
                self.assertEqual(tick.ci_of(helpers, tg.SHA), expected)

    def test_a_timer_has_no_target_and_a_human_has_one(self):
        env = tick.Env('/nonexistent', None, None, None)
        with self.assertRaisesRegex(ValueError, 'a manual run deploys its checkout'):
            tick.tick(env, 'manual')
        with self.assertRaisesRegex(ValueError, "unknown mode 'cron'"):
            tick.tick(env, 'cron')


class Cli(unittest.TestCase):
    def run_main(self, argv, uid=1000):
        envs = []
        with mock.patch.object(tick, 'tick', side_effect=lambda env, mode, ack: (mode, tuple(ack))) as t, \
                contextlib.redirect_stderr(io.StringIO()):
            got = tick.main(argv, make_env=lambda mode: envs.append(mode) or f'env:{mode}', geteuid=lambda: uid)
        return got, envs, [c.args for c in t.call_args_list]

    def test_modes_and_acknowledgements(self):
        self.assertEqual(self.run_main(['timer']), (('timer', ()), ['timer'], [('env:timer', 'timer', [])]))
        self.assertEqual(self.run_main(['deploy']), (('manual', ()), ['manual'], [('env:manual', 'manual', [])]))
        self.assertEqual(self.run_main(['deploy', '--force', '--ack-holds', HELD, 'pr:12']),
                         (('force', (HELD, 'pr:12')), ['force'], [('env:force', 'force', [HELD, 'pr:12'])]))

    def test_root_is_refused_before_anything(self):
        self.assertEqual(self.run_main(['deploy'], uid=0), (64, [], []))

    def test_usage_errors(self):
        self.assertEqual(self.run_main(['deploy', '--bogus']), (64, [], []))
        self.assertEqual(self.run_main([]), (64, [], []))
        self.assertEqual(self.run_main(['timer', '--force']), (64, [], []))

    def test_without_the_host_adapters_it_does_not_run(self):
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(tick.main(['timer'], geteuid=lambda: 1000), 70)
        self.assertEqual(err.getvalue(), 'ERROR: the host adapters (Host, Helpers) are not installed yet (stage Б).\n')


if __name__ == '__main__':
    unittest.main()
