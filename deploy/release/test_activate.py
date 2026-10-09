import hashlib
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import activate  # noqa: E402
import deploy_state as ds  # noqa: E402
from activate import HostError, Outcome  # noqa: E402
from deploy_state import Pre, Release, Settled, State, Unverified  # noqa: E402
from fake_host import BOOT_A, PRE_DB, T0, FakeHost, MemoryStore, World  # noqa: E402
from safe_tar import Refused  # noqa: E402

OLD = 'b' * 40
CAND = 'c' * 40
CAND_REL = Release(CAND, '1' * 64)
OLD_SETTLED = Settled(OLD, '2' * 64, T0 - 86400)
SETTLED_STATE = State('settled', BOOT_A, settled=OLD_SETTLED)


class Engine(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.fresh(self._tmp.name)

    def fresh(self, base):
        """A new world in base, settled on OLD, with the engine's store and host over it."""
        self.world = World(base, OLD, CAND)
        self.store = MemoryStore(state=SETTLED_STATE)
        self.host = FakeHost(self.world)
        self.pre = Pre(self.world.pre, hashlib.sha256(PRE_DB).hexdigest(), T0 - 60)

    def tearDown(self):
        self._tmp.cleanup()

    def begin(self):
        return activate.begin(self.store, self.host, CAND_REL, self.pre)

    def run_engine(self):
        self.begin()
        return activate.run(self.store, self.host)

    def run_until(self, phase):
        """step from a fresh begin until the persisted phase is `phase`; the last Outcome."""
        self.begin()
        for _ in range(1000):
            out = activate.step(self.store, self.host)
            if self.store.load().phase == phase:
                return out
        raise AssertionError(f'never reached {phase}')

    def whats(self):
        return [e['what'] for e in self.store.load().evidence]

    def last_event(self):
        return dict(self.store.load().evidence[-1])


class Begin(Engine):
    def test_opens_an_activation_against_the_settled_baseline(self):
        s = self.begin()
        self.assertEqual((s.phase, s.intent, s.candidate, s.previous, s.pre, s.settled, s.boot_id),
                         ('activating', 'stop', CAND_REL, Release(OLD, '2' * 64), self.pre, OLD_SETTLED, BOOT_A))
        self.assertRegex(s.txn, r'^[0-9a-f]{32}$')
        self.assertEqual([dict(e) for e in s.evidence], [
            {'at': T0, 'what': 'begin', 'result': 'ok', 'candidate': CAND, 'previous': OLD, 'pre': self.world.pre}])
        self.assertEqual(self.store.load(), s)
        # Nothing on the host moved: begin only records the plan.
        self.assertEqual((self.world.bot, self.world.running, self.world.current), ('active', OLD, OLD))

    def test_refused_without_writing(self):
        cases = [
            ('first run', None, 'phase is absent (first run), not settled'),
            ('no baseline', State('settled', BOOT_A), 'no settled baseline to roll back to'),
            ('last failed', SETTLED_STATE.replace(last_failed_sha=CAND), f'{CAND} is the last failed SHA'),
            ('already settled', State('settled', BOOT_A, settled=Settled(CAND, '1' * 64, T0)),
             f'{CAND} is already settled'),
            ('unverified', State('unverified', BOOT_A, txn='0' * 32, candidate=Release('d' * 40, '3' * 64),
                                 unverified=Unverified('d' * 40, 'gap', None), settled=OLD_SETTLED),
             'phase is unverified, not settled'),
            ('mid-activation', State('observing', BOOT_A, txn='0' * 32, candidate=Release('d' * 40, '3' * 64),
                                     previous=Release(OLD, '2' * 64), pre=Pre('/p-pre.db', '4' * 64, 1),
                                     observe=ds.Observe(T0, BOOT_A, None, None, 0), settled=OLD_SETTLED),
             'phase is observing, not settled'),
        ]
        for name, state, why in cases:
            with self.subTest(name):
                store = MemoryStore(state=state)
                before = store.data
                with self.assertRaises(Refused) as cm:
                    activate.begin(store, self.host, CAND_REL, self.pre)
                self.assertEqual((str(cm.exception), store.data, store.saves), (why, before, 0))


class HappyPath(Engine):
    def test_settles_after_a_full_window_from_the_start(self):
        out = self.run_engine()
        self.assertEqual(out.kind, 'settled')
        s = self.store.load()
        self.assertEqual((s.phase, s.intent, s.txn, s.settled, s.last_failed_sha, s.candidate, s.pre),
                         ('settled', None, None, Settled(CAND, '1' * 64, T0 + 600), None, None, None))
        self.assertEqual(self.whats(), ['begin', 'stop', 'switch', 'start', 'healthy', 'settled'])
        self.assertEqual((self.world.bot, self.world.running, self.world.current, self.world.starts),
                         ('active', CAND, CAND, [(CAND, T0)]))
        self.assertEqual(self.world.violations, [])
        # Healthy at the first probe, then one probe every 10 s until 600 s after the start.
        self.assertEqual([t - T0 for t, _ in self.world.health_calls], [0, *range(10, 600, 10)])

    def test_the_window_counts_from_the_start_not_from_the_first_healthy_answer(self):
        self.world.healthy = lambda sha, age: age >= 100
        self.assertEqual(self.run_engine().kind, 'settled')
        self.assertEqual(self.store.load().settled.settled_at, T0 + 600)
        calls = [t - T0 for t, _ in self.world.health_calls]
        self.assertEqual(calls, [*range(0, 101, 2), *range(110, 600, 10)])

    def test_every_sample_is_persisted(self):
        self.run_until('observing')
        saves = self.store.saves
        out = activate.step(self.store, self.host)
        o = self.store.load().observe
        self.assertEqual((out.kind, self.store.saves - saves, o.last_sample_at, o.healthy_at, o.nrestarts0),
                         ('continue', 1, T0, T0, None))
        activate.step(self.store, self.host)
        o = self.store.load().observe
        self.assertEqual((self.store.saves - saves, o.last_sample_at, o.nrestarts0, o.fails), (2, T0 + 10, 0, 0))


class Startup(Engine):
    def test_an_old_process_answering_ok_is_not_the_candidate(self):
        # The restart did not take; the old process still owns the port and says ok (§7).
        self.world.port_owner = OLD
        self.run_until('rolling-back')
        s = self.store.load()
        self.assertEqual((s.intent, s.last_failed_sha, s.observe.healthy_at), ('stop-writers', CAND, None))
        self.assertEqual(self.last_event(), {
            'at': T0 + 120, 'what': 'rollback',
            'result': f'not healthy as ccccccc within 120 s (last: ok=True releaseSha={OLD[:7]})'})
        self.assertEqual([t - T0 for t, _ in self.world.health_calls], list(range(0, 121, 2)))

    def test_healthy_exactly_at_120_s_passes(self):
        self.world.healthy = lambda sha, age: age >= 120
        self.assertEqual(self.run_engine().kind, 'settled')
        self.assertEqual(self.store.load().settled, Settled(CAND, '1' * 64, T0 + 600))

    def test_healthy_only_after_120_s_rolls_back_at_120_s(self):
        self.world.healthy = lambda sha, age: age > 120
        self.run_until('rolling-back')
        self.assertEqual(self.last_event(), {
            'at': T0 + 120, 'what': 'rollback',
            'result': 'not healthy as ccccccc within 120 s (last: ok=False releaseSha=ccccccc)'})


class Window(Engine):
    def test_three_failures_in_a_row_at_the_end_roll_back(self):
        self.world.healthy = lambda sha, age: 8 <= age < 578
        self.run_until('rolling-back')
        s = self.store.load()
        self.assertEqual((s.intent, s.last_failed_sha, s.observe.fails), ('stop-writers', CAND, 2))
        self.assertEqual(self.last_event(), {
            'at': T0 + 598, 'what': 'rollback',
            'result': 'health failed 3 times in a row (last at +598 s: ok=False releaseSha=ccccccc)'})

    def test_two_failures_before_the_end_settle(self):
        self.world.healthy = lambda sha, age: 8 <= age < 588
        self.assertEqual(self.run_engine().kind, 'settled')
        self.assertEqual(self.store.load().settled, Settled(CAND, '1' * 64, T0 + 608))

    def test_failures_not_in_a_row_settle(self):
        self.world.healthy = lambda sha, age: age not in (100, 110, 130, 140, 300, 310)
        self.assertEqual(self.run_engine().kind, 'settled')
        self.assertEqual(self.store.load().settled, Settled(CAND, '1' * 64, T0 + 600))

    def test_an_nrestarts_change_rolls_back(self):
        self.world.restarts = lambda sha, age: 0 if age < 300 else 1
        self.run_until('rolling-back')
        self.assertEqual((self.store.load().last_failed_sha, self.last_event()), (CAND, {
            'at': T0 + 300, 'what': 'rollback', 'result': 'service restarted (NRestarts 0 -> 1) at +300 s'}))

    def test_nrestarts_never_read_is_unverified(self):
        self.world.restarts = lambda sha, age: None
        out = self.run_engine()
        reason = 'NRestarts could not be read once during the window'
        s = self.store.load()
        self.assertEqual((out.kind, out.reason, s.phase, s.unverified, s.settled, s.last_failed_sha),
                         ('unverified', reason, 'unverified', Unverified(CAND, reason, self.pre), OLD_SETTLED, None))
        # Nothing is rolled back: the candidate keeps running.
        self.assertEqual((self.world.running, self.world.current), (CAND, CAND))
        self.assertEqual(activate.step(self.store, self.host), Outcome('unverified', s, reason))

    def test_one_nrestarts_reading_is_enough(self):
        self.world.restarts = lambda sha, age: 4 if age == 590 else None
        self.assertEqual(self.run_engine().kind, 'settled')

    def test_the_baseline_is_the_first_reading(self):
        self.world.restarts = lambda sha, age: None if age < 200 else 3
        self.assertEqual(self.run_engine().kind, 'settled')
        self.assertEqual(self.store.load().settled, Settled(CAND, '1' * 64, T0 + 600))

    def test_an_unreachable_health_endpoint_is_a_failure(self):
        self.world.errors['health'] = HostError('connection refused')
        self.run_until('rolling-back')
        self.assertEqual(self.last_event(), {
            'at': T0 + 120, 'what': 'rollback',
            'result': 'not healthy as ccccccc within 120 s (last: ok=False releaseSha=None)'})


class Blocked(Engine):
    def test_a_bot_that_does_not_stop_blocks_without_a_change(self):
        self.world.stop_works = False
        self.begin()
        before = self.store.data
        out = activate.step(self.store, self.host)
        self.assertEqual((out.kind, out.reason, self.store.data), ('blocked', 'stop: the bot is active', before))
        self.assertEqual((self.world.running, self.world.current), (OLD, OLD))

    def test_a_host_error_blocks_and_is_not_a_verdict(self):
        for method, intent in (('stop_bot', 'stop'), ('switch', 'switch'), ('start_bot', 'start')):
            with self.subTest(method):
                self.fresh(tempfile.mkdtemp(dir=self._tmp.name))
                self.world.errors[method] = HostError('sudo: a password is required')
                self.begin()
                for _ in range(['stop', 'switch', 'start'].index(intent)):
                    activate.step(self.store, self.host)
                before = self.store.data
                out = activate.step(self.store, self.host)
                self.assertEqual((out.kind, out.reason, self.store.data, self.store.load().last_failed_sha),
                                 ('blocked', f'{intent}: sudo: a password is required', before, None))

    def test_a_host_error_outside_an_action_blocks_the_window(self):
        self.run_until('observing')
        before = self.store.data
        self.world.errors['now'] = HostError('clock unavailable')
        out = activate.step(self.store, self.host)
        self.assertEqual((out.kind, out.reason, self.store.data), ('blocked', 'observing/None: clock unavailable', before))

    def test_switch_refused_aborts_without_a_verdict(self):
        self.world.accepted = {OLD}
        self.begin()
        activate.step(self.store, self.host)
        out = activate.step(self.store, self.host)
        s = self.store.load()
        self.assertEqual((out.kind, s.phase, s.intent, s.last_failed_sha, s.post),
                         ('continue', 'rolling-back', 'switch-previous', None, None))
        self.assertEqual(self.last_event(), {
            'at': T0, 'what': 'abort', 'result': f'switch to ccccccc refused: {CAND}: no receipt — not an accepted release'})
        self.assertEqual((self.world.current, self.world.starts), (OLD, []))

    def test_switch_with_the_bot_running_goes_back_to_stop(self):
        self.begin()
        activate.step(self.store, self.host)
        self.world.bot, self.world.running = 'active', OLD
        out = activate.step(self.store, self.host)
        self.assertEqual((out.kind, self.store.load().intent, self.world.current, self.world.violations),
                         ('continue', 'stop', OLD, []))

    def test_start_does_not_restart_a_running_candidate(self):
        self.begin()
        activate.step(self.store, self.host)
        activate.step(self.store, self.host)
        self.world.start_bot()
        out = activate.step(self.store, self.host)
        self.assertEqual((out.kind, self.store.load().phase, self.world.starts), ('continue', 'observing', [(CAND, T0)]))


class FileStore(unittest.TestCase):
    def test_round_trips_through_the_state_file(self):
        with tempfile.TemporaryDirectory() as d:
            store = activate.Store(os.path.join(d, ds.STATE_NAME))
            self.assertEqual(store.load(), None)
            store.save(SETTLED_STATE)
            self.assertEqual(store.load(), SETTLED_STATE)


if __name__ == '__main__':
    unittest.main()
