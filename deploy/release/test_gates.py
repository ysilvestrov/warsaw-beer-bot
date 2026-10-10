"""gates.admission by row of the spec §5 table "Гейти за шляхом" (timer / manual / manual --force).

Rows that are not admission's: trusted origin/digests/tree, host audit and snapshot+trial are prepare's
(test_prepare.py); the shared lock is the tick's. "Internal rollback" is the engine's (test_activate.py).
"""
import os
import sys
import unittest
from dataclasses import replace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gates  # noqa: E402
from gates import UNREAD, Ci, CommitPrs, Decision, Inputs, Observation, Pr  # noqa: E402
from tick_state import Abort, Regression, Seen  # noqa: E402

SETTLED = '5' * 40
MAIN = 'a' * 40
OLDER = '9' * 40      # a main commit between settled and MAIN
OTHER = 'e' * 40
NOW = 1_760_000_000
TRUSTED = object()
MODES = ('timer', 'manual', 'force')

# Every gate passes: the facts a tick would have read for a quiet, green, unheld main.
GREEN = dict(
    now=NOW, main=MAIN, target=MAIN, paused=False, settled_sha=SETTLED, noop_sha=None, last_failed_sha=None,
    abort=None, main_seen=Seen(MAIN, NOW - 600), regression=None,
    settled_in_target=True, target_in_main=True, installed_stale=None,
    changed_paths=('src/index.ts', 'docs/x.md'),
    commit_prs=(CommitPrs(MAIN, (Pr(11, ('dependencies',)),)), CommitPrs(OLDER, ())),
    ci=Ci('pass', trusted=TRUSTED),
)
ADMIT = Decision('admit', 'aaaaaaa admitted')


def decide(mode, **changes):
    return gates.admission(Inputs(mode=mode, **{**GREEN, **changes}))


class Green(unittest.TestCase):
    def test_every_mode_admits_a_quiet_green_unheld_main(self):
        for mode in MODES:
            with self.subTest(mode):
                self.assertEqual(decide(mode), ADMIT)

    def test_unknown_mode_and_ci_kind_are_errors(self):
        with self.assertRaisesRegex(ValueError, "unknown mode 'cron'"):
            Inputs(mode='cron', **GREEN)
        with self.assertRaisesRegex(ValueError, "unknown CI kind 'green'"):
            Ci('green')


class ExactShaCi(unittest.TestCase):
    """Row: exact-SHA CI+package success — every mode."""

    def test_failed_ci_is_refused_once_per_sha_in_every_mode(self):
        expected = {
            'timer': Decision('refuse', 'CI failed on aaaaaaa: package is completed/failure',
                              f'ci-failed:{MAIN}', 'once'),
            'manual': Decision('refuse', 'CI failed on aaaaaaa: package is completed/failure', None, 'once'),
            'force': Decision('refuse', 'CI failed on aaaaaaa: package is completed/failure', None, 'once'),
        }
        for mode in MODES:
            with self.subTest(mode):
                self.assertEqual(decide(mode, ci=Ci('failed', 'package is completed/failure')), expected[mode])

    def test_pending_ci_waits_in_every_mode(self):
        for mode in MODES:
            with self.subTest(mode):
                self.assertEqual(decide(mode, ci=Ci('pending')).kind, 'wait')

    def test_unreadable_ci_waits_and_is_not_a_failure(self):
        self.assertEqual(decide('timer', ci=Ci('unreadable', 'HTTP 502')),
                         Decision('wait', 'cannot read CI for aaaaaaa: HTTP 502', 'ci-unreadable'))
        self.assertEqual(decide('force', ci=Ci('unreadable', 'HTTP 502')),
                         Decision('wait', 'cannot read CI for aaaaaaa: HTTP 502', None))

    def test_pending_ci_is_reported_from_sixty_minutes_after_main_was_seen(self):
        at_59m59s = decide('timer', ci=Ci('pending'), main_seen=Seen(MAIN, NOW - 3599))
        at_60m = decide('timer', ci=Ci('pending'), main_seen=Seen(MAIN, NOW - 3600))
        self.assertEqual(at_59m59s, Decision('wait', 'CI has not concluded on aaaaaaa', None))
        self.assertEqual(at_60m, Decision('wait', 'CI has not concluded on aaaaaaa', 'ci-stuck'))


class MainHead(unittest.TestCase):
    """Row: main head == candidate before activation."""

    def test_timer_defers_on_any_new_head_even_a_descendant(self):
        # Step 13: the recheck right before begin sees main moved on from the target.
        self.assertEqual(decide('timer', main=OTHER, target=MAIN), Decision('wait', 'main moved to eeeeeee'))

    def test_manual_deploys_a_target_reachable_in_fresh_main(self):
        self.assertEqual(decide('manual', main=OTHER, target=MAIN), ADMIT)

    def test_manual_refuses_a_target_main_does_not_reach(self):
        self.assertEqual(decide('manual', main=OTHER, target=MAIN, target_in_main=False),
                         Decision('refuse', 'aaaaaaa is not reachable from main eeeeeee'))

    def test_force_allows_a_historical_target(self):
        self.assertEqual(decide('force', main=OTHER, target=MAIN, target_in_main=False, settled_in_target=False),
                         ADMIT)

    def test_failed_fetch_is_no_evidence_in_any_mode(self):
        expected = {'timer': 'fetch-failed', 'manual': None, 'force': None}
        for mode in MODES:
            with self.subTest(mode):
                self.assertEqual(decide(mode, main=None),
                                 Decision('wait', 'could not fetch main', expected[mode]))


class Quiet(unittest.TestCase):
    """Row: quiet 10 min — timer only."""

    def test_timer_waits_until_exactly_ten_minutes_after_the_first_sighting(self):
        self.assertEqual(decide('timer', main_seen=Seen(MAIN, NOW - 599)),
                         Decision('wait', 'main moved 599 s ago; waiting'))
        self.assertEqual(decide('timer', main_seen=Seen(MAIN, NOW - 600)), ADMIT)

    def test_timer_waits_for_a_head_it_has_not_seen(self):
        self.assertEqual(decide('timer', main_seen=Seen(OTHER, NOW - 9999)),
                         Decision('wait', 'new main head aaaaaaa; waiting 600 s of quiet'))
        self.assertEqual(decide('timer', main_seen=None),
                         Decision('wait', 'new main head aaaaaaa; waiting 600 s of quiet'))

    def test_manual_and_force_do_not_wait_for_quiet(self):
        for mode in ('manual', 'force'):
            with self.subTest(mode):
                self.assertEqual(decide(mode, main_seen=Seen(MAIN, NOW)), ADMIT)


HELD_PATHS = ('deploy/sudoers.d/warsaw-beer-bot', 'src/index.ts', 'deploy/release/gates.py')
HELD_PRS = (CommitPrs(MAIN, (Pr(11, ('dependencies',)), Pr(12, ('deploy:hold', 'x')))),
            CommitPrs(OLDER, (Pr(12, ('deploy:hold', 'x')),)))
HELD_KEYS = ('path:deploy/sudoers.d/warsaw-beer-bot', 'path:deploy/release/gates.py', 'pr:12')
HELD_TEXT = ('held:\n• path deploy/sudoers.d/warsaw-beer-bot needs a human step\n'
             '• path deploy/release/gates.py needs a human step\n• PR #12 carries deploy:hold')


class Holds(unittest.TestCase):
    """Row: path/label hold — blocks the timer; manual and force pass with the exact acknowledgement."""

    def held(self, mode, **changes):
        return decide(mode, changed_paths=HELD_PATHS, commit_prs=HELD_PRS, **changes)

    def test_timer_is_held_and_names_every_reason_once(self):
        self.assertEqual(self.held('timer'), Decision('hold', HELD_TEXT, 'hold', holds=HELD_KEYS))

    def test_timer_never_takes_an_acknowledgement(self):
        self.assertEqual(self.held('timer', ack_holds=HELD_KEYS), Decision('hold', HELD_TEXT, 'hold', holds=HELD_KEYS))

    def test_manual_and_force_without_acknowledgement_are_held(self):
        for mode in ('manual', 'force'):
            with self.subTest(mode):
                self.assertEqual(self.held(mode), Decision('hold', HELD_TEXT, None, holds=HELD_KEYS))

    def test_manual_and_force_pass_with_exactly_the_shown_keys(self):
        for mode in ('manual', 'force'):
            with self.subTest(mode):
                self.assertEqual(self.held(mode, ack_holds=reversed(HELD_KEYS)), ADMIT)

    def test_an_acknowledgement_missing_a_shown_key_is_held(self):
        self.assertEqual(self.held('manual', ack_holds=HELD_KEYS[:2]),
                         Decision('hold', HELD_TEXT, None, holds=HELD_KEYS))

    def test_an_acknowledgement_with_a_key_not_shown_is_held(self):
        self.assertEqual(self.held('force', ack_holds=HELD_KEYS + ('pr:13',)),
                         Decision('hold', HELD_TEXT, None, holds=HELD_KEYS))

    def test_an_acknowledgement_when_nothing_is_held_is_refused(self):
        self.assertEqual(decide('manual', ack_holds=('pr:12',)),
                         Decision('refuse', '--ack-holds names pr:12, but nothing of it is held'))

    def test_a_label_alone_holds(self):
        got = decide('timer', commit_prs=(CommitPrs(MAIN, (Pr(7, ('deploy:hold',)),)),))
        self.assertEqual(got, Decision('hold', 'held:\n• PR #7 carries deploy:hold', 'hold', holds=('pr:7',)))

    def test_what_could_not_be_read_blocks_and_cannot_be_acknowledged(self):
        cases = {
            'paths': (dict(changed_paths=None), 'could not list the changed paths'),
            'commits': (dict(commit_prs=None), 'could not list the commits'),
            'labels': (dict(commit_prs=(CommitPrs(MAIN, None),)), 'could not read PR labels for aaaaaaa'),
        }
        for name, (changes, why) in cases.items():
            with self.subTest(name):
                self.assertEqual(decide('timer', **changes),
                                 Decision('wait', f'cannot tell whether the range is held: {why}', 'holds-unreadable'))
                self.assertEqual(decide('manual', ack_holds=HELD_KEYS, **changes),
                                 Decision('wait', f'cannot tell whether the range is held: {why}', None))


class HeldPaths(unittest.TestCase):
    """Plan "Рішення" п.4: control-plane files the payload does not carry."""

    def test_held(self):
        for path in ('deploy/release/gates.py', 'deploy/release/sub/x.py', 'deploy/sudoers.d/warsaw-beer-bot',
                     'deploy/warsaw-beer-bot.service', 'deploy/wbb-autodeploy.service', 'deploy/wbb-autodeploy.timer',
                     'deploy/wbb-reboot-request.path', 'deploy/install-autodeploy.sh', 'deploy/litestream.yml',
                     'deploy/litestream.service', 'deploy/litestream.env.example', '.github/workflows/ci.yml',
                     'scripts/ops/host_patch_collect.py', 'scripts/ops/reboot_request.py'):
            with self.subTest(path):
                self.assertTrue(gates.path_is_held(path))

    def test_not_held(self):
        for path in ('src/index.ts', 'docs/deploy.md', 'deploy/README.md', 'deploy/deploy.sh', 'deploy/rsync-filter',
                     'deploy/sub/x.service', 'deploy/install-autodeploy.txt', 'deploy/releases/x.py',
                     'deploy/release', 'deploy/litestream', '.github/workflows/codeql.yml',
                     'scripts/ops/other.py', 'x/deploy/release/a.py', 'package-lock.json'):
            with self.subTest(path):
                self.assertFalse(gates.path_is_held(path))


class InstalledCurrent(unittest.TestCase):
    """Row: installed infrastructure current — every mode."""

    def test_stale_installed_copies_hold_every_mode(self):
        expected = {'timer': 'installed-stale', 'manual': None, 'force': None}
        for mode in MODES:
            with self.subTest(mode):
                self.assertEqual(decide(mode, installed_stale='wbb-trial: differs'),
                                 Decision('hold', 'the installed deployer is out of date:\nwbb-trial: differs',
                                          expected[mode]))


FENCE = Regression('c' * 40, 'd' * 40)
FENCE_TEXT = 'production regression ccccccc → ddddddd: aaaaaaa does not contain ccccccc'


class Ancestry(unittest.TestCase):
    """Row: ancestry / regression fence."""

    def test_timer_and_manual_hold_a_target_that_does_not_descend_from_settled(self):
        expected = {'timer': 'ancestry', 'manual': None}
        for mode in ('timer', 'manual'):
            with self.subTest(mode):
                self.assertEqual(decide(mode, settled_in_target=False), Decision(
                    'hold', 'settled 5555555 is not an ancestor of aaaaaaa: refusing what could be a downgrade',
                    expected[mode]))

    def test_force_bypasses_ancestry(self):
        self.assertEqual(decide('force', settled_in_target=False), ADMIT)

    def test_fence_holds_every_mode_for_a_target_without_its_from(self):
        expected = {'timer': 'regression', 'manual': None, 'force': None}
        for mode in MODES:
            with self.subTest(mode):
                self.assertEqual(decide(mode, regression=FENCE, from_in_target=False),
                                 Decision('hold', FENCE_TEXT, expected[mode]))

    def test_fence_holds_the_timer_even_for_a_target_with_its_from(self):
        self.assertEqual(decide('timer', regression=FENCE, from_in_target=True),
                         Decision('hold', FENCE_TEXT, 'regression'))

    def test_by_hand_a_target_with_its_from_is_the_recovery_forward(self):
        for mode in ('manual', 'force'):
            with self.subTest(mode):
                self.assertEqual(decide(mode, regression=FENCE, from_in_target=True), ADMIT)


class LastFailed(unittest.TestCase):
    """Row: LAST_FAILED_SHA."""

    def test_timer_is_silent_and_by_hand_needs_a_rearm(self):
        self.assertEqual(decide('timer', last_failed_sha=MAIN),
                         Decision('idle', 'aaaaaaa is the last failed SHA; waiting for the next merge'))
        for mode in ('manual', 'force'):
            with self.subTest(mode):
                self.assertEqual(decide(mode, last_failed_sha=MAIN),
                                 Decision('refuse', 'aaaaaaa is the last failed SHA; it needs an explicit rearm'))

    def test_a_new_sha_is_not_the_failed_one(self):
        self.assertEqual(decide('timer', last_failed_sha=OTHER), ADMIT)


class Backoff(unittest.TestCase):
    """Ф7: after an abort the same SHA waits 1 h, doubling per abort in a row, at most 24 h (timer)."""

    def test_boundaries(self):
        cases = (  # (count, seconds since the abort, expected kind)
            (1, 3599, 'wait'), (1, 3600, 'admit'),
            (2, 7199, 'wait'), (2, 7200, 'admit'),
            (3, 14399, 'wait'), (3, 14400, 'admit'),
            (6, 86399, 'wait'), (6, 86400, 'admit'),   # 32 h uncapped
            (60, 86399, 'wait'), (60, 86400, 'admit'),
        )
        for count, ago, kind in cases:
            with self.subTest(count=count, ago=ago):
                self.assertEqual(decide('timer', abort=Abort(MAIN, count, NOW - ago)).kind, kind)

    def test_wait_says_how_long_is_left(self):
        self.assertEqual(decide('timer', abort=Abort(MAIN, 2, NOW - 7000)),
                         Decision('wait', 'aaaaaaa aborted 2 time(s); next try in 200 s'))

    def test_backoff_formula(self):
        self.assertEqual([gates.backoff_s(n) for n in (1, 2, 3, 4, 5, 6, 7)],
                         [3600, 7200, 14400, 28800, 57600, 86400, 86400])

    def test_another_sha_is_not_backed_off(self):
        self.assertEqual(decide('timer', abort=Abort(OTHER, 3, NOW)), ADMIT)

    def test_by_hand_is_not_backed_off(self):
        for mode in ('manual', 'force'):
            with self.subTest(mode):
                self.assertEqual(decide(mode, abort=Abort(MAIN, 1, NOW)), ADMIT)


class NothingToDo(unittest.TestCase):
    def test_settled_and_noop_targets_are_idle_in_every_mode(self):
        for mode in MODES:
            with self.subTest(mode):
                self.assertEqual(decide(mode, settled_sha=MAIN), Decision('idle', 'up to date at aaaaaaa'))
                self.assertEqual(decide(mode, noop_sha=MAIN),
                                 Decision('idle', 'aaaaaaa changes nothing in the runtime payload'))

    def test_paused_stops_the_timer_quietly_and_not_a_human(self):
        self.assertEqual(decide('timer', paused=True), Decision('idle', 'paused'))
        for mode in ('manual', 'force'):
            with self.subTest(mode):
                self.assertEqual(decide(mode, paused=True), ADMIT)

    def test_no_settled_baseline_holds_every_mode(self):
        expected = {'timer': 'no-baseline', 'manual': None, 'force': None}
        for mode in MODES:
            with self.subTest(mode):
                self.assertEqual(decide(mode, settled_sha=None), Decision(
                    'hold', 'no settled baseline: the first installation is an operator step', expected[mode]))


LAZY = dict(from_in_target=UNREAD, settled_in_target=UNREAD, target_in_main=UNREAD, installed_stale=UNREAD,
            changed_paths=UNREAD, commit_prs=UNREAD, ci=UNREAD)


class ReadOnDemand(unittest.TestCase):
    """The costly facts are asked for one at a time, in gate order, and only once a gate needs them."""

    def test_timer_waiting_for_quiet_asks_github_nothing(self):
        # Ancestry is a local git question and comes first (plan order 6 before 8); labels and CI wait.
        self.assertEqual(decide('timer', main_seen=Seen(MAIN, NOW - 10), **{**LAZY, 'settled_in_target': True}),
                         Decision('wait', 'main moved 10 s ago; waiting'))

    def test_timer_order(self):
        i = Inputs(mode='timer', **{**GREEN, **LAZY})
        self.assertEqual(gates.admission(i), Decision('need', 'settled_in_target'))
        i = replace(i, settled_in_target=True)
        self.assertEqual(gates.admission(i), Decision('need', 'installed_stale'))
        i = replace(i, installed_stale=None)
        self.assertEqual(gates.admission(i), Decision('need', 'changed_paths'))
        i = replace(i, changed_paths=())
        self.assertEqual(gates.admission(i), Decision('need', 'commit_prs'))
        i = replace(i, commit_prs=())
        self.assertEqual(gates.admission(i), Decision('need', 'ci'))
        self.assertEqual(gates.admission(replace(i, ci=Ci('pass'))), ADMIT)

    def test_manual_reads_the_fence_and_reachability_first(self):
        i = Inputs(mode='manual', **{**GREEN, **LAZY, 'regression': FENCE})
        self.assertEqual(gates.admission(i), Decision('need', 'from_in_target'))
        i = replace(i, from_in_target=True)
        self.assertEqual(gates.admission(i), Decision('need', 'target_in_main'))
        i = replace(i, target_in_main=True)
        self.assertEqual(gates.admission(i), Decision('need', 'settled_in_target'))

    def test_force_reads_no_ancestry(self):
        i = Inputs(mode='force', **{**GREEN, **LAZY})
        self.assertEqual(gates.admission(i), Decision('need', 'installed_stale'))


# A history: C0 <- C1 <- C2 <- C3 on main; D1 forks from C0.
C0, C1, C2, C3, D1 = ('0' * 40, '1' * 40, '2' * 40, '3' * 40, 'd' * 40)
PARENTS = {C1: C0, C2: C1, C3: C2, D1: C0}


def is_ancestor(a, b):
    chain = [b]
    while chain[-1] in PARENTS:
        chain.append(PARENTS[chain[-1]])
    return a in chain


class Observe(unittest.TestCase):
    """The regression fence (merge-deploy observe_deployment)."""

    def test_nothing_settled_changes_nothing(self):
        self.assertEqual(gates.observe(C1, None, None, is_ancestor), Observation(C1, None, None))

    def test_first_sighting_is_recorded_without_an_event(self):
        self.assertEqual(gates.observe(None, None, C1, is_ancestor), Observation(C1, None, None))

    def test_forward_is_no_event(self):
        self.assertEqual(gates.observe(C1, None, C3, is_ancestor), Observation(C3, None, None, C1))

    def test_backwards_raises_the_fence(self):
        self.assertEqual(gates.observe(C2, None, C1, is_ancestor),
                         Observation(C1, Regression(C2, C1), 'went-backwards', C2))

    def test_diverged_raises_the_fence(self):
        self.assertEqual(gates.observe(C2, None, D1, is_ancestor),
                         Observation(D1, Regression(C2, D1), 'diverged', C2))

    def test_an_open_fence_keeps_its_from(self):
        self.assertEqual(gates.observe(C1, Regression(C3, C1), D1, is_ancestor),
                         Observation(D1, Regression(C3, D1), 'diverged', C1))

    def test_the_fence_stays_until_settled_contains_its_from(self):
        fence = Regression(C3, C1)
        # A manual deploy that is admitted or settles on c2 does not clear it: c2 lacks c3.
        self.assertEqual(gates.observe(C1, fence, C1, is_ancestor), Observation(C1, fence, None, C1))
        self.assertEqual(gates.observe(C1, fence, C2, is_ancestor), Observation(C2, fence, None, C1))
        self.assertEqual(gates.observe(C2, fence, C3, is_ancestor), Observation(C3, None, 'cleared', C2))

    def test_an_unknown_commit_is_an_error_for_the_tick(self):
        def broken(a, b):
            raise LookupError(f'{a} is not a local commit')

        with self.assertRaisesRegex(LookupError, f'{C1} is not a local commit'):
            gates.observe(C1, None, C2, broken)


if __name__ == '__main__':
    unittest.main()
