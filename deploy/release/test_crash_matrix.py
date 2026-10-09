"""Crash/recovery matrix of the activation engine (spec §10b; plan 2v, Task 4).

For each scenario one uninterrupted tick enumerates its crash points: every host call and every
save of the state, before and after the action. Then, for EACH point, a fresh world runs the
tick until the controller dies there, and a new engine over the same world and state file runs
the next tick to its end. The assertions are about the world — which release the bot process
serves, where `current` points, the database files, the post — not only about the state file.
"""
import hashlib
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import activate  # noqa: E402
import dbsnap  # noqa: E402
from deploy_state import Pre, Release, Settled, State  # noqa: E402
from fake_host import BOOT_A, BOOT_B, PRE_DB, T0, Crash, FakeHost, Faults, MemoryStore, World  # noqa: E402

OLD = 'b' * 40
CAND = 'c' * 40
CAND_REL = Release(CAND, '1' * 64)
OLD_SETTLED = Settled(OLD, '2' * 64, T0 - 86400)


def pre_db(world):
    return {'': PRE_DB}


def migrated(world):
    """The DB files as the candidate's LAST start left them (each start writes rows of its own)."""
    return world.cand_writes[-1]


def migrated_post(world):
    return {'bot.db' + suffix: data for suffix, data in migrated(world).items()}


def no_post(world):
    return None


# name: how the world behaves, and what must be true after the tick that follows ANY crash.
SCENARIOS = {
    'success': dict(
        healthy=lambda sha, age: True, tampered=set(),
        kind='settled', settled=Settled(CAND, '1' * 64, T0 + 600), last_failed=None, db=migrated, post=no_post,
        starts=[(CAND, T0)]),
    'rollback in startup': dict(
        healthy=lambda sha, age: sha == OLD, tampered=set(),
        kind='rolled-back', settled=OLD_SETTLED, last_failed=CAND, db=pre_db, post=migrated_post,
        starts=[(CAND, T0), (OLD, T0 + 120)]),
    # Healthy from 8 s, so the probes fall on 8, 18, ... 598 s: the third failure is the last probe.
    'rollback at 9:58': dict(
        healthy=lambda sha, age: sha == OLD or 8 <= age < 578, tampered=set(),
        kind='rolled-back', settled=OLD_SETTLED, last_failed=CAND, db=pre_db, post=migrated_post,
        starts=[(CAND, T0), (OLD, T0 + 598)]),
    'abort, switch refused': dict(
        healthy=lambda sha, age: True, tampered={CAND},
        kind='aborted', settled=OLD_SETTLED, last_failed=None, db=pre_db, post=no_post,
        starts=[(OLD, T0)]),
}


def post_files(world):
    """The post's data files (without post.json), or None when no post exists."""
    out = activate.post_dir(world.pre)
    if not os.path.isdir(out):
        return None
    return {name: pathlib.Path(out, name).read_bytes()
            for name in sorted(os.listdir(out)) if name != dbsnap.POST_MANIFEST}


def tick(store, host, pre):
    """One controller tick as the periphery runs it: finish what is in flight, else admit the candidate.

    begin() resets the evidence, so an empty evidence on a settled state means it never landed.
    """
    out = activate.resume(store, host)
    if out.kind == 'idle' and store.load().evidence == ():
        activate.begin(store, host, CAND_REL, pre)
        out = activate.run(store, host)
    return out


def max_gap(times):
    return max(b - a for a, b in zip(times, times[1:]))


class CrashMatrix(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._tmp.cleanup()

    def world(self, scenario, faults):
        sc = SCENARIOS[scenario]
        world = World(tempfile.mkdtemp(dir=self._tmp.name), OLD, CAND)
        world.tampered = set(sc['tampered'])
        world.healthy = sc['healthy']
        store = MemoryStore(faults, state=State('settled', BOOT_A, settled=OLD_SETTLED))
        pre = Pre(world.pre, hashlib.sha256(PRE_DB).hexdigest(), T0 - 60)
        return world, store, FakeHost(world, faults), pre

    def points(self, scenario):
        faults = Faults()
        world, store, host, pre = self.world(scenario, faults)
        out = tick(store, host, pre)
        self.assert_end(scenario, SCENARIOS[scenario]['kind'], out, store, world)
        return faults.points

    def assert_end(self, scenario, kind, out, store, world):
        sc = SCENARIOS[scenario]
        s = store.load()
        want = sc['settled']
        self.assertEqual((out.kind, s.phase, s.intent, s.txn, s.settled, s.last_failed_sha, s.evidence[-1]['what']),
                         (kind, 'settled', None, None, want, sc['last_failed'], sc['kind']))
        # The bot serves exactly the release the state calls settled, and `current` agrees.
        self.assertEqual((world.bot, world.running, world.current, world.litestream),
                         ('active', want.sha, want.sha, 'active'))
        self.assertEqual(world.violations, [])
        self.assertEqual((world.db_files(), post_files(world)), (sc['db'](world), sc['post'](world)))
        # Each release started once, at its time — a crash never causes a second start — and the
        # bot was never left unprobed for over 30 s: with `settled` above, the window was watched.
        self.assertEqual((world.starts, max_gap([at for at, _ in world.health_calls]) <= activate.GAP_S),
                         (sc['starts'], True))

    def check(self, scenario):
        # The crash is simulated in-process, so fsync (dbsnap's durability) proves nothing here
        # and only costs time; test_dbsnap covers it.
        with mock.patch('os.fsync'):
            return self._check(scenario)

    def _check(self, scenario):
        points = self.points(scenario)
        n = len(points)
        # The tick that follows reports the end itself — except after a crash right after the
        # final save: that end is already persisted, so the next tick is idle (its notification
        # is the periphery's to derive from the state's evidence).
        kinds = [SCENARIOS[scenario]['kind']] * (n - 1) + ['idle']
        self.assertEqual(points[-1], 'save settled/None after')
        for i, name in enumerate(points):
            with self.subTest(point=f'{scenario} {i + 1}/{n}: {name}'):
                faults = Faults(i)
                world, store, host, pre = self.world(scenario, faults)
                with self.assertRaises(Crash):
                    tick(store, host, pre)
                store = store.reopened()
                out = tick(store, FakeHost(world), pre)
                self.assert_end(scenario, kinds[i], out, store, world)
        return n

    def test_a_reboot_after_a_crash_in_the_window_is_unverified(self):
        with mock.patch('os.fsync'):
            points = self.points('success')
        # Every kind of point in the window (each observing step makes the same calls): those of
        # the startup and the first window probes, and of the last probes before `settled` lands.
        first, last = points.index('save observing/None after'), points.index('save settled/None before')
        n = len(points)
        for i in [*range(first, first + 40), *range(last - 20, last + 1)]:
            with self.subTest(point=f'reboot {i + 1}/{n}: {points[i]}'):
                world, store, host, pre = self.world('success', Faults(i))
                with self.assertRaises(Crash):
                    tick(store, host, pre)
                world.reboot()
                store = store.reopened()
                out = tick(store, FakeHost(world), pre)
                s = store.load()
                self.assertEqual((out.kind, s.phase, s.settled, s.last_failed_sha, s.unverified.sha, s.unverified.pre),
                                 ('unverified', 'unverified', OLD_SETTLED, None, CAND, pre))
                self.assertEqual(out.reason, f'reboot during the window (boot {BOOT_A} -> {BOOT_B})')
                # Nothing is rolled back: the boot restarted the candidate from `current`, on its own writes.
                self.assertEqual((world.running, world.current, world.db_files(), world.violations),
                                 (CAND, CAND, migrated(world), []))

    def reboot_after_the_switch(self, healthy, check):
        """Each crash point from the switch to the window's first save, then a reboot that starts the
        enabled unit from `current` — the candidate, which writes — then the next tick; check(out, state, world)."""
        with mock.patch('os.fsync'):
            points = self.points('success')
            first, last = points.index('switch after'), points.index('save observing/None before')
            n = len(points)
            for i in range(first, last + 1):
                with self.subTest(point=f'reboot {i + 1}/{n}: {points[i]}'):
                    world, store, host, pre = self.world('success', Faults(i))
                    world.healthy = healthy
                    with self.assertRaises(Crash):
                        tick(store, host, pre)
                    world.reboot()
                    self.assertEqual((world.running, world.db_files()), (CAND, migrated(world)))
                    store = store.reopened()
                    out = tick(store, FakeHost(world), pre)
                    check(out, store.load(), world)

    def rebooted(self, s):
        return [e['result'] for e in s.evidence if e['what'] == 'rebooted']

    def test_a_reboot_after_the_switch_goes_on_to_the_candidates_window(self):
        # 2v review: the boot may have started the candidate; §10b "start may already have happened":
        # no restart, its own window decides — never the no-DB abort, never a verdict for the reboot.
        def check(out, s, world):
            self.assertEqual((out.kind, s.phase, s.settled, s.last_failed_sha, self.rebooted(s)),
                             ('settled', 'settled', Settled(CAND, '1' * 64, T0 + 605), None,
                              [f'boot {BOOT_A} -> {BOOT_B} with current on ccccccc: the candidate may already run']))
            self.assertEqual((world.bot, world.running, world.current, world.litestream, world.violations,
                              world.starts[-1], world.db_files(), post_files(world)),
                             ('active', CAND, CAND, 'active', [], (CAND, T0 + 5), migrated(world), None))
        self.reboot_after_the_switch(lambda sha, age: True, check)

    def test_a_reboot_after_the_switch_then_a_failed_window_rolls_back_code_and_database(self):
        def check(out, s, world):
            self.assertEqual((out.kind, s.phase, s.settled, s.last_failed_sha, len(self.rebooted(s))),
                             ('rolled-back', 'settled', OLD_SETTLED, CAND, 1))
            self.assertEqual((world.bot, world.running, world.current, world.litestream, world.violations,
                              world.starts[-2:]),
                             ('active', OLD, OLD, 'active', [], [(CAND, T0 + 5), (OLD, T0 + 125)]))
            # The boot-time writes are kept in post; the DB is pre again.
            self.assertEqual((world.db_files(), post_files(world)), (pre_db(world), migrated_post(world)))
        self.reboot_after_the_switch(lambda sha, age: sha == OLD, check)

    def test_success(self):
        self.check('success')

    def test_rollback_in_startup(self):
        self.check('rollback in startup')

    def test_rollback_at_the_end_of_the_window(self):
        self.check('rollback at 9:58')

    def test_abort_without_the_database(self):
        self.check('abort, switch refused')


if __name__ == '__main__':
    unittest.main()
