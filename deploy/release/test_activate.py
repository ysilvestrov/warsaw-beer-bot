import hashlib
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import activate  # noqa: E402
import deploy_state as ds  # noqa: E402
from activate import HostError, Outcome  # noqa: E402
from deploy_state import Pre, Release, Settled, State, Unverified  # noqa: E402
from fake_host import BOOT_A, BOOT_B, PRE_DB, T0, FakeHost, MemoryStore, World  # noqa: E402
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
        s = activate.begin(self.store, self.host, CAND_REL, self.pre)
        self.txn = s.txn
        return s

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

    def migrated(self):
        """The DB files as the candidate's process leaves them."""
        db, wal = self.world.candidate_writes()
        return {'': db, '-wal': wal}

    def whats(self):
        return [e['what'] for e in self.store.load().evidence]

    def last_event(self):
        """The last evidence event without its txn, which must be this activation's (2в e2e review Ф6)."""
        e = dict(self.store.load().evidence[-1])
        self.assertEqual(e.pop('txn'), self.txn)
        return e


class Begin(Engine):
    def test_opens_an_activation_against_the_settled_baseline(self):
        s = self.begin()
        self.assertEqual((s.phase, s.intent, s.candidate, s.previous, s.pre, s.settled, s.boot_id),
                         ('activating', 'stop', CAND_REL, Release(OLD, '2' * 64), self.pre, OLD_SETTLED, BOOT_A))
        self.assertRegex(s.txn, r'^[0-9a-f]{32}$')
        self.assertEqual([dict(e) for e in s.evidence], [
            {'at': T0, 'what': 'begin', 'result': 'ok', 'candidate': CAND, 'previous': OLD, 'pre': self.world.pre,
             'txn': s.txn}])
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


    def test_both_trees_are_verified_before_anything_is_written(self):
        # 2в e2e review Ф4 (§8, §10b row switch): a baseline that does not verify is found before the
        # bot is stopped, not in the middle of a rollback.
        cases = (
            ('candidate refused', dict(accepted={OLD}),
             f'candidate ccccccc does not verify: {CAND}: no receipt — not an accepted release'),
            ('previous refused', dict(accepted={CAND}),
             f'previous bbbbbbb does not verify: {OLD}: no receipt — not an accepted release'),
            ('candidate tree', dict(trees={OLD: '2' * 64, CAND: '9' * 64}),
             f'candidate ccccccc: its receipt accepted tree {"9" * 64}, recorded {"1" * 64}'),
            ('previous tree', dict(trees={OLD: '9' * 64, CAND: '1' * 64}),
             f'previous bbbbbbb: its receipt accepted tree {"9" * 64}, recorded {"2" * 64}'),
        )
        for name, world, why in cases:
            with self.subTest(name):
                self.fresh(tempfile.mkdtemp(dir=self._tmp.name))
                for k, v in world.items():
                    setattr(self.world, k, v)
                before = self.store.data
                with self.assertRaises(Refused) as cm:
                    activate.begin(self.store, self.host, CAND_REL, self.pre)
                self.assertEqual((str(cm.exception), self.store.data, self.store.saves),
                                 (why, before, 0))
                self.assertEqual((self.world.bot, self.world.running, self.world.current), ('active', OLD, OLD))


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
        # The pause is a step of its own and persists nothing; the sample after it is judged afresh.
        self.assertEqual((activate.step(self.store, self.host).kind, self.store.saves - saves, self.world.now),
                         ('continue', 1, T0 + 10))
        activate.step(self.store, self.host)
        o = self.store.load().observe
        self.assertEqual((self.store.saves - saves, o.last_sample_at, o.nrestarts0, o.fails), (2, T0 + 10, 0, 0))


class Transactions(Engine):
    """2в e2e review Ф6: notifications are idempotent per transaction."""

    def test_every_event_of_a_rollback_carries_its_txn_and_the_end_keeps_it(self):
        self.world.healthy = lambda sha, age: sha == OLD
        self.assertEqual(self.run_engine().kind, 'rolled-back')
        s = self.store.load()
        self.assertEqual((s.txn, s.last_txn, {e['txn'] for e in s.evidence}, len(s.evidence)),
                         (None, self.txn, {self.txn}, 10))

    def test_settled_and_aborted_keep_the_txn_they_ended(self):
        for name, tampered, kind in (('settled', set(), 'settled'), ('aborted', {CAND}, 'aborted')):
            with self.subTest(name):
                self.fresh(tempfile.mkdtemp(dir=self._tmp.name))
                self.world.tampered = tampered
                self.assertEqual(self.run_engine().kind, kind)
                s = self.store.load()
                self.assertEqual((s.txn, s.last_txn, s.evidence[-1]['txn']), (None, self.txn, self.txn))

    def test_the_next_activation_keeps_the_last_txn_until_it_ends(self):
        self.assertEqual(self.run_engine().kind, 'settled')
        first = self.txn
        state = self.store.load()
        store = MemoryStore(state=state.replace(settled=OLD_SETTLED))
        s = activate.begin(store, self.host, CAND_REL, self.pre)
        self.assertEqual((s.last_txn, s.txn != first, s.evidence[0]['txn']), (first, True, s.txn))


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
        self.world.tampered = {CAND}
        self.begin()
        activate.step(self.store, self.host)
        out = activate.step(self.store, self.host)
        s = self.store.load()
        self.assertEqual((out.kind, s.phase, s.intent, s.last_failed_sha, s.posts),
                         ('continue', 'rolling-back', 'switch-previous', None, ()))
        self.assertEqual(self.last_event(), {
            'at': T0, 'what': 'abort', 'result': f'switch to ccccccc refused: {CAND}: release tree changed:\ndist/index.js: differs from manifest (sha256)'})
        self.assertEqual((self.world.current, self.world.starts), (OLD, []))

    def test_a_switch_to_another_tree_than_admitted_aborts_without_a_verdict(self):
        # 2в e2e review Ф4: the receipt changed after begin; the candidate is never started.
        self.begin()
        self.world.trees[CAND] = '9' * 64
        out = activate.run(self.store, self.host)
        s = self.store.load()
        self.assertEqual((out.kind, s.last_failed_sha, s.evidence[2]['what'], s.evidence[2]['result']),
                         ('aborted', None, 'abort', f'switch to ccccccc: its receipt accepted tree {"9" * 64}, '
                                                    f'admitted {"1" * 64}'))
        self.assertEqual((self.world.running, self.world.current, self.world.starts, self.world.db_files()),
                         (OLD, OLD, [(OLD, T0)], {'': PRE_DB}))

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


POST_DIR_NAME = '20261009T080000Z-ccccccc-rollback-post'


class Rollback(Engine):
    def post_dir(self):
        return os.path.join(self._tmp.name, POST_DIR_NAME)

    def test_startup_failure_restores_code_and_database(self):
        self.world.healthy = lambda sha, age: sha == OLD
        out = self.run_engine()
        s = self.store.load()
        reason = ('ccccccc rolled back to bbbbbbb, code and database; writes between 2025-10-09T08:52:20Z and '
                  f'2025-10-09T08:55:20Z '
                  f'exist only in {self.post_dir()}')
        self.assertEqual((out.kind, out.reason), ('rolled-back', reason))
        self.assertEqual((s.phase, s.intent, s.txn, s.settled, s.last_failed_sha, s.candidate, s.posts),
                         ('settled', None, None, OLD_SETTLED, CAND, None, ()))
        self.assertEqual(self.whats(), ['begin', 'stop', 'switch', 'start', 'rollback', 'stop-writers', 'save-post',
                                        'restore-pre', 'switch-previous', 'rolled-back'])
        self.assertEqual(self.last_event(), {
            'at': T0 + 120, 'what': 'rolled-back', 'result': reason, 'candidate': CAND, 'previous': OLD,
            'pre': self.world.pre, 'posts': (self.post_dir(),), 'lostFrom': T0 - 60, 'lostTo': T0 + 120})
        # The world: the old release runs again on exactly pre; what the candidate wrote is in post.
        self.assertEqual((self.world.bot, self.world.running, self.world.current, self.world.litestream),
                         ('active', OLD, OLD, 'active'))
        self.assertEqual(self.world.starts, [(CAND, T0), (OLD, T0 + 120)])
        self.assertEqual(self.world.db_files(), {'': PRE_DB})
        post = {name: pathlib.Path(self.post_dir(), name).read_bytes() for name in ('bot.db', 'bot.db-wal')}
        self.assertEqual(post, {'bot.db': self.migrated()[''], 'bot.db-wal': self.migrated()['-wal']})
        self.assertEqual(self.world.violations, [])

    def test_an_aborted_activation_never_touches_the_database(self):
        self.world.tampered = {CAND}
        out = self.run_engine()
        s = self.store.load()
        reason = 'ccccccc never started; back on bbbbbbb, database untouched'
        self.assertEqual((out.kind, out.reason, s.phase, s.settled, s.last_failed_sha),
                         ('aborted', reason, 'settled', OLD_SETTLED, None))
        self.assertEqual(self.whats(), ['begin', 'stop', 'abort', 'switch-previous', 'aborted'])
        self.assertEqual((self.world.running, self.world.current, self.world.starts), (OLD, OLD, [(OLD, T0)]))
        self.assertEqual((self.world.db_files(), self.world.posts, self.world.restores), ({'': PRE_DB}, [], []))

    def roll_to(self, intent):
        """Fail the candidate at startup and step until the rollback's persisted intent is `intent`."""
        self.world.healthy = lambda sha, age: sha == OLD
        self.run_until('rolling-back')
        for _ in range(10):
            if self.store.load().intent == intent:
                return
            activate.step(self.store, self.host)
        raise AssertionError(f'never reached {intent}')

    def test_a_post_is_never_taken_while_a_writer_runs(self):
        # Writers a reboot (or an operator) started again between stop-writers and save-post: stop
        # them again first — the post of a live DB is not the DB a restore will replace.
        for writer in ('bot', 'litestream'):
            with self.subTest(writer):
                self.fresh(tempfile.mkdtemp(dir=self._tmp.name))
                self.roll_to('save-post')
                setattr(self.world, writer, 'active')
                out = activate.step(self.store, self.host)
                s = self.store.load()
                self.assertEqual((out.kind, s.intent, s.posts, self.world.posts, self.last_event()),
                                 ('continue', 'stop-writers', (), [],
                                  {'at': T0 + 120, 'what': 'save-post', 'result': 'writers running'}))

    def test_a_writer_that_will_not_stop_blocks_the_rollback(self):
        self.roll_to('stop-writers')
        self.world.stop_works = False
        before = self.store.data
        out = activate.step(self.store, self.host)
        self.assertEqual((out.kind, out.reason, self.store.data),
                         ('blocked', 'stop-writers: the bot is active, litestream is inactive', before))

    def test_a_foreign_post_directory_fails_the_recovery(self):
        self.roll_to('save-post')
        os.mkdir(self.post_dir())
        out = activate.run(self.store, self.host)
        s = self.store.load()
        why = f'{self.post_dir()}: no post.json — not a complete post'
        self.assertEqual((out.kind, out.reason, s.phase, s.last_failed_sha), ('recovery-failed', f'save-post: {why}',
                                                                           'recovery-failed', CAND))
        self.assertEqual((self.world.restores, self.world.db_files(), self.world.bot), ([], self.migrated(), 'inactive'))
        self.assertEqual(activate.resume(self.store, self.host), Outcome('recovery-failed', s, why))

    def test_a_corrupt_pre_fails_the_recovery_and_leaves_the_database(self):
        self.roll_to('restore-pre')
        with open(self.world.pre, 'ab') as f:
            f.write(b'!')
        out = activate.run(self.store, self.host)
        want, got = hashlib.sha256(PRE_DB).hexdigest(), hashlib.sha256(PRE_DB + b'!').hexdigest()
        self.assertEqual((out.kind, out.reason),
                         ('recovery-failed', f'restore-pre: checksum mismatch for {self.world.pre}: want {want}, got {got}'))
        self.assertEqual((self.world.db_files(), self.world.current, self.world.bot), (self.migrated(), CAND, 'inactive'))

    def test_a_previous_release_that_does_not_verify_is_never_replaced_by_another(self):
        self.roll_to('switch-previous')
        self.world.accepted = {CAND}
        out = activate.run(self.store, self.host)
        self.assertEqual((out.kind, out.reason),
                         ('recovery-failed', f'switch-previous: {OLD}: no receipt — not an accepted release'))
        self.assertEqual((self.world.current, self.world.bot, self.world.db_files()), (CAND, 'inactive', {'': PRE_DB}))

    def test_a_previous_release_with_another_tree_than_settled_is_never_started(self):
        # 2в e2e review Ф4: the baseline's receipt is not the one that settled.
        self.roll_to('switch-previous')
        self.world.trees[OLD] = '9' * 64
        out = activate.run(self.store, self.host)
        self.assertEqual((out.kind, out.reason, self.store.load().phase),
                         ('recovery-failed', f'switch-previous: its receipt accepted tree {"9" * 64}, settled {"2" * 64}',
                          'recovery-failed'))
        self.assertEqual((self.world.bot, self.world.starts, self.world.db_files()),
                         ('inactive', [(CAND, T0)], {'': PRE_DB}))

    def test_a_previous_release_that_stays_unhealthy_stays_pending_and_is_retried(self):
        # 2в e2e review Ф5 (§10b start baseline: "Fail — лишити pending/evidence й critical alert"):
        # not the terminal phase, which nothing would ever retry.
        self.world.healthy = lambda sha, age: False
        self.run_until('rolling-back')
        out = activate.run(self.store, self.host)
        why = 'bbbbbbb not healthy within 120 s (last: ok=False releaseSha=bbbbbbb)'
        s = self.store.load()
        self.assertEqual((out.kind, out.reason, s.phase, s.intent, s.settled, s.last_failed_sha),
                         ('recovery-failed', f'start-baseline: {why}', 'rolling-back', 'start-baseline', OLD_SETTLED, CAND))
        self.assertEqual(self.last_event(), {'at': T0 + 240, 'what': 'start-baseline', 'result': why})
        self.assertEqual((self.world.now, self.world.running, self.world.starts, self.world.db_files()),
                         (T0 + 240, OLD, [(CAND, T0), (OLD, T0 + 120)], {'': PRE_DB}))
        # The next tick tries again: no restart of the active unit, no second evidence event.
        saved = self.store.load()
        out = activate.resume(self.store, self.host)
        self.assertEqual((out.kind, self.store.load(), self.world.now, self.world.starts),
                         ('recovery-failed', saved, T0 + 360, [(CAND, T0), (OLD, T0 + 120)]))
        # Once it answers as itself, the rollback ends as usual.
        self.world.healthy = lambda sha, age: True
        out = activate.resume(self.store, self.host)
        self.assertEqual((out.kind, self.store.load().phase, self.store.load().settled), ('rolled-back', 'settled', OLD_SETTLED))

    def test_a_previous_release_that_is_down_is_started_again_on_the_retry(self):
        # Inactive (it crashed, or a reboot left it down): start only what does not run.
        self.world.healthy = lambda sha, age: False
        self.run_until('rolling-back')
        self.assertEqual(activate.run(self.store, self.host).kind, 'recovery-failed')
        self.world.stop_bot()
        self.world.healthy = lambda sha, age: True
        self.assertEqual(activate.resume(self.store, self.host).kind, 'rolled-back')
        self.assertEqual(self.world.starts, [(CAND, T0), (OLD, T0 + 120), (OLD, T0 + 240)])

    def test_another_release_answering_ok_is_not_the_baseline(self):
        # A process of another SHA still on the port (the candidate's) says ok: not the previous release.
        self.roll_to('start-baseline')
        self.world.port_owner = CAND
        out = activate.run(self.store, self.host)
        self.assertEqual((out.kind, out.reason), (
            'recovery-failed', 'start-baseline: bbbbbbb not healthy within 120 s (last: ok=True releaseSha=ccccccc)'))

    def post_files(self, path):
        return {name: pathlib.Path(path, name).read_bytes() for name in ('bot.db', 'bot.db-wal')}

    def test_a_reboot_onto_an_aborted_switch_restores_the_database_without_a_verdict(self):
        # #823 AI review: the switch moved `current` and then answered another tree, so the abort is
        # persisted with `current` still on the candidate; a reboot starts the unit from it and the
        # candidate writes. Before, switch-previous just stopped it and reported "database untouched".
        self.begin()
        self.world.trees[CAND] = '9' * 64
        activate.step(self.store, self.host)
        activate.step(self.store, self.host)
        self.assertEqual((self.store.load().intent, self.world.current), ('switch-previous', CAND))
        self.world.reboot()
        self.assertEqual((self.world.running, self.world.db_files()), (CAND, self.migrated()))
        out = activate.run(self.store, self.host)
        s = self.store.load()
        self.assertEqual((out.kind, s.phase, s.last_failed_sha, s.settled),
                         ('rolled-back', 'settled', None, OLD_SETTLED))
        self.assertEqual((self.world.running, self.world.current, self.world.db_files()), (OLD, OLD, {'': PRE_DB}))
        db1, wal1 = self.world.candidate_writes(1)
        self.assertEqual((self.post_files(self.post_dir()), self.world.violations),
                         ({'bot.db': db1, 'bot.db-wal': wal1}, []))
        self.assertEqual(self.whats(), ['begin', 'stop', 'abort', 'switch-previous', 'stop-writers', 'save-post',
                                        'restore-pre', 'switch-previous', 'rolled-back'])
        self.assertEqual(s.evidence[3]['result'], 'candidate started by a reboot during the abort')

    def test_writers_started_by_a_reboot_are_stopped_before_the_restore(self):
        self.roll_to('restore-pre')
        # The reboot starts both units, the bot from `current` — the candidate, on the post-state DB,
        # where it applies the first start's WAL and writes rows of its own.
        self.world.reboot()
        db1, wal1 = self.world.candidate_writes(1)
        db2, wal2 = db1 + wal1 + f' | migrated by {CAND}, start 2'.encode(), f'WAL of {CAND}, start 2'.encode()
        self.assertEqual((self.world.running, self.world.db_files()), (CAND, {'': db2, '-wal': wal2}))
        self.assertEqual(activate.resume(self.store, self.host).kind, 'rolled-back')
        self.assertEqual(self.whats()[-7:], ['save-post', 'restore-pre', 'stop-writers', 'save-post', 'restore-pre',
                                             'switch-previous', 'rolled-back'])
        self.assertEqual((self.world.db_files(), self.world.running, self.world.violations), ({'': PRE_DB}, OLD, []))
        # 2в e2e review Ф1: the second stop takes a post of its own, which holds the second start's rows;
        # the first post is left as it was.
        second = self.post_dir() + '-2'
        self.assertEqual((self.post_files(self.post_dir()), self.post_files(second), self.world.restores[-1]),
                         ({'bot.db': db1, 'bot.db-wal': wal1}, {'bot.db': db2, 'bot.db-wal': wal2},
                          (self.world.pre, second)))

    def test_a_post_that_landed_before_a_reboot_is_not_the_post_of_the_next_stop(self):
        # 2в e2e review Ф1: the tick died after the post was complete but before its completion was
        # saved; the reboot started the candidate, which wrote. The next stop needs a NEW post.
        self.roll_to('save-post')
        self.host.post(self.post_dir())
        self.world.reboot()
        db1, wal1 = self.world.candidate_writes(1)
        db2 = db1 + wal1 + f' | migrated by {CAND}, start 2'.encode()
        self.assertEqual(activate.resume(self.store, self.host).kind, 'rolled-back')
        second = self.post_dir() + '-2'
        self.assertEqual((self.post_files(self.post_dir()), self.post_files(second)['bot.db'], self.world.restores,
                          self.last_event()['posts']),
                         ({'bot.db': db1, 'bot.db-wal': wal1}, db2, [(self.world.pre, second)], (second,)))

    def test_a_candidate_rebooted_onto_the_restored_database_is_restored_again(self):
        self.roll_to('switch-previous')
        self.world.reboot()
        # The second start found the restored pre: its rows are not in the first post.
        db2, wal2 = self.world.candidate_writes(2)
        self.assertEqual(self.world.db_files(), {'': db2, '-wal': wal2})
        # The previous release answers healthy 4 s after its start: the end is later than the last stop.
        self.world.healthy = lambda sha, age: sha == OLD and age >= 4
        out = activate.resume(self.store, self.host)
        self.assertEqual((out.kind, self.world.db_files(), self.world.running, self.world.current),
                         ('rolled-back', {'': PRE_DB}, OLD, OLD))
        # 2в e2e review Ф1: before, save-post handed back the first (complete) post and the restore
        # destroyed the second start's rows. Now the second stop has a post of its own.
        second = self.post_dir() + '-2'
        db1, wal1 = self.world.candidate_writes(1)
        self.assertEqual((self.post_files(self.post_dir()), self.post_files(second), self.world.restores[-1]),
                         ({'bot.db': db1, 'bot.db-wal': wal1}, {'bot.db': db2, 'bot.db-wal': wal2},
                          (self.world.pre, second)))
        # The writes are lost to the live DB until the LAST stop (T0 + 125, after the 5 s reboot), not the
        # first (T0 + 120) nor the end (T0 + 129); the evidence names both posts.
        e = self.last_event()
        self.assertEqual((e['at'], e['lostFrom'], e['lostTo'], e['posts']),
                         (T0 + 129, T0 - 60, T0 + 125, (self.post_dir(), second)))
        self.assertEqual(out.reason, 'ccccccc rolled back to bbbbbbb, code and database; writes between '
                                     f'2025-10-09T08:52:20Z and 2025-10-09T08:55:25Z exist only in '
                                     f'{self.post_dir()}, {second}')


class Resume(Engine):
    def test_nothing_to_do(self):
        for name, state in (('first run', None), ('no baseline', State('settled', BOOT_A)), ('settled', SETTLED_STATE)):
            with self.subTest(name):
                store = MemoryStore(state=state)
                self.assertEqual(activate.resume(store, self.host), Outcome('idle', store.load()))
                self.assertEqual(store.saves, 0)

    def test_drift_is_reported_without_any_action(self):
        cases = (
            ('current moved', dict(current=CAND), f'settled is bbbbbbb, current is ccccccc, the running process says bbbbbbb'),
            ('another process', dict(running=CAND), f'settled is bbbbbbb, current is bbbbbbb, the running process says ccccccc'),
            ('bot down', dict(bot='inactive', running=None), 'settled is bbbbbbb, current is bbbbbbb, the running process says None'),
        )
        for name, world, why in cases:
            with self.subTest(name):
                self.fresh(tempfile.mkdtemp(dir=self._tmp.name))
                for k, v in world.items():
                    setattr(self.world, k, v)
                before = (self.world.bot, self.world.running, self.world.current)
                self.assertEqual(activate.resume(self.store, self.host), Outcome('drift', SETTLED_STATE, why))
                self.assertEqual(((self.world.bot, self.world.running, self.world.current), self.store.saves),
                                 (before, 0))

    def test_held_phases_do_nothing(self):
        self.world.restarts = lambda sha, age: None
        self.run_engine()
        self.host.faults.points.clear()
        out = activate.resume(self.store, self.host)
        self.assertEqual((out.kind, out.reason, self.host.faults.points),
                         ('unverified', 'NRestarts could not be read once during the window', []))

    def test_a_reboot_in_the_window_is_unverified_not_settled(self):
        self.run_until('observing')
        for _ in range(5):
            activate.step(self.store, self.host)
        self.world.reboot()
        out = activate.resume(self.store, self.host)
        s = self.store.load()
        why = 'reboot during the window (boot 0f0e0d0c-0b0a-4908-8706-050403020100 -> 11111111-2222-4333-8444-555555555555)'
        self.assertEqual((out.kind, out.reason, s.phase, s.unverified, s.settled, s.last_failed_sha),
                         ('unverified', why, 'unverified', Unverified(CAND, why, self.pre), OLD_SETTLED, None))
        # Nothing is rolled back: the candidate (restarted by the boot) keeps running on its own writes.
        self.assertEqual((self.world.running, len(self.world.cand_writes), self.world.db_files(), self.world.restores),
                         (CAND, 2, self.world.cand_writes[-1], []))

    def test_a_gap_over_30_s_is_unverified(self):
        self.run_until('observing')
        for _ in range(3):
            activate.step(self.store, self.host)
        # The last sample was taken just now; 31 s later there has been none for 31 s.
        self.world.now += 31
        out = activate.resume(self.store, self.host)
        self.assertEqual((out.kind, out.reason, self.store.load().settled),
                         ('unverified', 'no sample for 31 s (over 30 s)', OLD_SETTLED))

    def test_a_clock_stepped_back_is_unverified_without_a_sleep(self):
        # 2в e2e review Ф2: in startup, with the candidate not healthy yet; before, the next probe waited
        # for `due` — a sleep as long as the step — and the window went on over broken timestamps.
        self.world.healthy = lambda sha, age: False
        self.run_until('observing')
        # Samples at T0, T0 + 2, T0 + 4, each pause a step of its own.
        for _ in range(5):
            activate.step(self.store, self.host)
        self.assertEqual(self.store.load().observe.last_sample_at, T0 + 4)
        self.world.now -= 300
        calls = len(self.world.health_calls)
        out = activate.resume(self.store, self.host)
        s = self.store.load()
        why = 'the clock went back 300 s behind the last sample'
        self.assertEqual((out.kind, out.reason, s.phase, s.unverified, s.last_failed_sha),
                         ('unverified', why, 'unverified', Unverified(CAND, why, self.pre), None))
        self.assertEqual((self.world.now, len(self.world.health_calls), self.world.running), (T0 + 4 - 300, calls, CAND))

    def test_the_same_time_as_the_last_sample_is_not_a_step_back(self):
        # The boundary: a sample at the very time of the last one waits for its pause, as always.
        self.run_until('observing')
        activate.step(self.store, self.host)
        self.assertEqual(self.store.load().observe.last_sample_at, T0)
        self.assertEqual((activate.step(self.store, self.host).kind, self.store.load().observe.last_sample_at),
                         ('continue', T0))
        self.assertEqual((activate.step(self.store, self.host).kind, self.store.load().observe.last_sample_at),
                         ('continue', T0 + 10))

    def test_a_pause_that_outlasts_the_gap_is_unverified_not_a_sample(self):
        # #823 AI review: a 10 s pause that returns 40 s later (a suspended process) used to probe and
        # persist that time as the next sample, hiding a 40 s hole in the window.
        self.run_until('observing')
        activate.step(self.store, self.host)
        self.assertEqual(self.store.load().observe.last_sample_at, T0)
        self.host.sleep = lambda seconds: setattr(self.world, 'now', self.world.now + 40)
        calls = len(self.world.health_calls)
        out = activate.run(self.store, self.host)
        self.assertEqual((out.kind, out.reason, self.store.load().settled, len(self.world.health_calls)),
                         ('unverified', 'no sample for 40 s (over 30 s)', OLD_SETTLED, calls))

    def test_a_reboot_during_a_pause_is_unverified(self):
        self.run_until('observing')
        activate.step(self.store, self.host)
        self.host.sleep = lambda seconds: self.world.reboot(seconds)
        out = activate.run(self.store, self.host)
        self.assertEqual((out.kind, self.store.load().settled), ('unverified', OLD_SETTLED))
        self.assertEqual(out.reason, f'reboot during the window (boot {BOOT_A} -> {BOOT_B})')

    def test_a_gap_of_exactly_30_s_continues_the_window(self):
        self.run_until('observing')
        for _ in range(3):
            activate.step(self.store, self.host)
        self.world.now += 30
        self.assertEqual(activate.resume(self.store, self.host).kind, 'settled')
        self.assertEqual(self.store.load().settled, Settled(CAND, '1' * 64, T0 + 600))

    def switched_then_rebooted(self):
        """The tick died right after `current` moved to the candidate; the boot started the unit from it."""
        self.begin()
        activate.step(self.store, self.host)
        self.host.switch(CAND)
        self.world.reboot()
        self.assertEqual((self.store.load().intent, self.world.running, self.world.db_files()),
                         ('switch', CAND, self.migrated()))

    def test_a_candidate_a_reboot_started_is_never_aborted_without_the_database(self):
        # 2v review: repeating the switch after the boot could be refused (the tree no longer
        # verifies) — the no-DB abort, old code on the candidate's writes. The step goes on to `start`.
        self.switched_then_rebooted()
        self.world.accepted = {OLD}
        out = activate.resume(self.store, self.host)
        s = self.store.load()
        self.assertEqual((out.kind, s.settled.sha, s.last_failed_sha, self.whats()[:5]),
                         ('settled', CAND, None, ['begin', 'stop', 'rebooted', 'start', 'healthy']))
        # Not restarted: the process the boot started is the one watched; its writes stay.
        self.assertEqual((self.world.starts, self.world.db_files(), self.world.posts, self.world.restores,
                          self.world.violations), ([(CAND, T0 + 5)], self.migrated(), [], [], []))

    def test_a_reboot_before_the_switch_is_not_a_started_candidate(self):
        # The boundary of the rule: `current` still on the old release, so the boot started that one.
        self.begin()
        activate.step(self.store, self.host)
        self.world.reboot()
        out = activate.resume(self.store, self.host)
        self.assertEqual((out.kind, 'rebooted' in self.whats(), self.world.starts, self.world.db_files()),
                         ('settled', False, [(OLD, T0 + 5), (CAND, T0 + 5)], self.migrated()))

    def test_a_dead_start_is_finished_by_the_next_tick(self):
        self.begin()
        activate.step(self.store, self.host)
        activate.step(self.store, self.host)
        self.assertEqual(self.store.load().intent, 'start')
        self.assertEqual(activate.resume(self.store, self.host).kind, 'settled')


class ForeignCurrent(Engine):
    """2в e2e review, item 4: `current()` raising Refused (a pointer publish does not understand)."""
    TARGET = '/srv/elsewhere'

    def why(self):
        return f"current: {self.world.base}/current -> '{self.TARGET}': not releases/<full sha>"

    def test_before_start_it_is_the_abort_without_a_verdict(self):
        self.begin()
        activate.step(self.store, self.host)
        self.world.foreign = self.TARGET
        out = activate.step(self.store, self.host)
        s = self.store.load()
        self.assertEqual((out.kind, s.phase, s.intent, s.last_failed_sha, self.last_event()),
                         ('continue', 'rolling-back', 'switch-previous', None,
                          {'at': T0, 'what': 'abort', 'result': self.why()}))
        # The way back refuses the same pointer: recovery-failed, nothing started, the DB untouched.
        out = activate.run(self.store, self.host)
        self.assertEqual((out.kind, self.store.load().phase, self.world.bot, self.world.starts, self.world.db_files()),
                         ('recovery-failed', 'recovery-failed', 'inactive', [], {'': PRE_DB}))

    def test_after_a_reboot_before_the_switch_it_is_the_abort(self):
        self.begin()
        self.world.foreign = self.TARGET
        self.world.reboot()
        self.assertEqual(activate.step(self.store, self.host).kind, 'continue')
        s = self.store.load()
        self.assertEqual((s.phase, s.intent, s.last_failed_sha, self.last_event()['what'], self.last_event()['result']),
                         ('rolling-back', 'switch-previous', None, 'abort', self.why()))

    def test_at_start_it_blocks(self):
        self.begin()
        activate.step(self.store, self.host)
        activate.step(self.store, self.host)
        self.world.foreign = self.TARGET
        before = self.store.data
        out = activate.step(self.store, self.host)
        self.assertEqual((out.kind, out.reason, self.store.data), ('blocked', f'activating/start: {self.why()}', before))

    def test_in_a_rollback_it_is_recovery_failed(self):
        self.world.healthy = lambda sha, age: sha == OLD
        self.run_until('rolling-back')
        for _ in range(4):
            activate.step(self.store, self.host)
        self.assertEqual(self.store.load().intent, 'start-baseline')
        self.world.foreign = self.TARGET
        out = activate.step(self.store, self.host)
        s = self.store.load()
        self.assertEqual((out.kind, out.reason, s.phase, s.last_failed_sha, self.last_event()),
                         ('recovery-failed', f'start-baseline: {self.why()}', 'recovery-failed', CAND,
                          {'at': T0 + 120, 'what': 'start-baseline', 'result': self.why()}))
        self.assertEqual((self.world.bot, self.world.litestream), ('inactive', 'inactive'))

    def test_settled_it_is_drift(self):
        self.world.foreign = self.TARGET
        out = activate.resume(self.store, self.host)
        self.assertEqual((out, self.store.saves),
                         (Outcome('drift', SETTLED_STATE, f'settled is bbbbbbb, {self.why()}'), 0))


class FileStore(unittest.TestCase):
    def test_round_trips_through_the_state_file(self):
        with tempfile.TemporaryDirectory() as d:
            store = activate.Store(os.path.join(d, ds.STATE_NAME))
            self.assertEqual(store.load(), None)
            store.save(SETTLED_STATE)
            self.assertEqual(store.load(), SETTLED_STATE)


if __name__ == '__main__':
    unittest.main()
