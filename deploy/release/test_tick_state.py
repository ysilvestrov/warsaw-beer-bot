import json
import os
import stat
import sys
import tempfile
import unittest
from types import MappingProxyType

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tick_state as ts  # noqa: E402
from deploy_state import StateError  # noqa: E402
from tick_state import Abort, Blocked, Regression, Seen, TickState  # noqa: E402

A = 'a' * 40
B = 'b' * 40
TXN = '0123456789abcdef0123456789abcdef'
TXN2 = 'fedcba9876543210fedcba9876543210'
FULL = TickState(
    main_seen=Seen(A, 1760000000), noop_sha=B, abort=Abort(A, 2, 1760000100.5, TXN2), notified_txn=TXN,
    last_seen_settled=B, regression=Regression(A, B),
    notices={'hold': '2026-10-10', f'ci-failed:{A}': '2026-10-01'},
    blocked=Blocked(TXN2, 'rolling-back/start-baseline', 1760000200, 1),
)
# The file FULL is, written out by hand (canonical: sorted keys, no whitespace).
FULL_JSON = {
    'formatVersion': 1,
    'mainSeen': {'sha': A, 'at': 1760000000},
    'noopSha': B,
    'abort': {'sha': A, 'count': 2, 'at': 1760000100.5, 'txn': TXN2},
    'notifiedTxn': TXN,
    'lastSeenSettled': B,
    'regression': {'from': A, 'to': B},
    'notices': {'hold': '2026-10-10', f'ci-failed:{A}': '2026-10-01'},
    'blocked': {'txn': TXN2, 'step': 'rolling-back/start-baseline', 'at': 1760000200, 'alerts': 1},
}


class Tmp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._tmp.name, ts.STATE_NAME)

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, data):
        with open(self.path, 'wb') as f:
            f.write(data)


class Files(Tmp):
    def test_missing_file_is_a_first_tick(self):
        self.assertIsNone(ts.load(self.path))

    def test_full_state_is_written_as_canonical_json_and_read_back(self):
        ts.save(self.path, FULL)
        with open(self.path, 'rb') as f:
            data = f.read()
        self.assertEqual(json.loads(data), FULL_JSON)
        self.assertEqual(data, json.dumps(FULL_JSON, sort_keys=True, separators=(',', ':')).encode())
        self.assertEqual(ts.load(self.path), FULL)

    def test_empty_state_round_trips(self):
        ts.save(self.path, TickState())
        self.assertEqual(ts.load(self.path), TickState())

    def test_file_is_private(self):
        ts.save(self.path, FULL)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)

    def test_save_refuses_what_is_not_a_tick_state(self):
        with self.assertRaisesRegex(TypeError, 'not a TickState'):
            ts.save(self.path, FULL_JSON)
        self.assertFalse(os.path.exists(self.path))

    def test_broken_files_are_errors_never_a_blank_slate(self):
        def without(key):
            return {k: v for k, v in FULL_JSON.items() if k != key}

        cases = {
            'empty': (b'', 'empty$'),
            'not json': (b'{', 'not JSON'),
            'other version': (json.dumps(dict(FULL_JSON, formatVersion=2)).encode(), 'formatVersion 2, expected 1'),
            'missing key': (json.dumps(without('noopSha')).encode(), r"missing \['noopSha'\]"),
            'unknown key': (json.dumps(dict(FULL_JSON, extra=1)).encode(), r"unknown \['extra'\]"),
            'duplicate key': (b'{"formatVersion":1,"formatVersion":1}', r"duplicate keys \['formatVersion'\]"),
            'short sha': (json.dumps(dict(FULL_JSON, noopSha='abc')).encode(), 'noopSha: not a full lowercase SHA'),
            'zero aborts': (json.dumps(dict(FULL_JSON, abort={'sha': A, 'count': 0, 'at': 1, 'txn': None})).encode(),
                            'tick-state.abort.count: not a positive integer: 0'),
            'bool count': (json.dumps(dict(FULL_JSON, abort={'sha': A, 'count': True, 'at': 1, 'txn': None})).encode(),
                           'tick-state.abort.count: not a positive integer: True'),
            'abort without txn key': (json.dumps(dict(FULL_JSON, abort={'sha': A, 'count': 1, 'at': 1})).encode(),
                                      r"tick-state.abort: missing \['txn'\]"),
            'zero alerts': (json.dumps(dict(FULL_JSON, blocked=dict(FULL_JSON['blocked'], alerts=0))).encode(),
                            'tick-state.blocked.alerts: not a positive integer: 0'),
            'blocked without step': (json.dumps(dict(FULL_JSON, blocked=dict(FULL_JSON['blocked'], step=''))).encode(),
                                     'tick-state.blocked.step: not a non-empty string'),
            'bad txn': (json.dumps(dict(FULL_JSON, notifiedTxn='x')).encode(), 'notifiedTxn: not a 32-hex'),
            'bad day': (json.dumps(dict(FULL_JSON, notices={'hold': '2026-02-30'})).encode(),
                        'notices.hold: not a YYYY-MM-DD day'),
            'bad key': (json.dumps(dict(FULL_JSON, notices={'Hold!': '2026-02-03'})).encode(), 'not a notice key'),
            'array': (b'[]', 'not an object: list'),
        }
        for name, (data, message) in cases.items():
            with self.subTest(name):
                self.write(data)
                with self.assertRaisesRegex(StateError, message):
                    ts.load(self.path)

    def test_oversized_file_is_an_error(self):
        self.write(b' ' * (ts.MAX_BYTES + 1))
        with self.assertRaisesRegex(StateError, 'over 1048576 bytes'):
            ts.load(self.path)


class Transitions(unittest.TestCase):
    def test_an_invalid_record_cannot_be_built(self):
        with self.assertRaisesRegex(StateError, 'Abort.count: not a positive integer: 0'):
            Abort(A, 0, 1)
        with self.assertRaisesRegex(StateError, 'Regression.from: not a full lowercase SHA'):
            Regression('abc', B)

    def test_main_seen_keeps_its_first_sighting_while_main_stays(self):
        s = ts.seen_main(TickState(), A, 100)
        self.assertEqual(s.main_seen, Seen(A, 100))
        self.assertEqual(ts.seen_main(s, A, 700).main_seen, Seen(A, 100))

    def test_main_seen_restarts_when_main_moves(self):
        s = ts.seen_main(TickState(main_seen=Seen(A, 100)), B, 700)
        self.assertEqual(s.main_seen, Seen(B, 700))

    def test_aborts_of_one_sha_count_up_and_another_sha_starts_at_one(self):
        s = ts.aborted(TickState(), A, 10)
        self.assertEqual(s.abort, Abort(A, 1, 10))
        s = ts.aborted(s, A, 20)
        self.assertEqual(s.abort, Abort(A, 2, 20))
        self.assertEqual(ts.aborted(s, B, 30).abort, Abort(B, 1, 30))

    def test_an_abort_is_counted_once_per_transaction(self):
        s = ts.aborted(TickState(), A, 10, TXN)
        self.assertEqual(s.abort, Abort(A, 1, 10, TXN))
        self.assertEqual(ts.aborted(s, A, 70, TXN), s)
        self.assertEqual(ts.aborted(s, A, 70, TXN2).abort, Abort(A, 2, 70, TXN2))

    def test_daily_notice_is_due_once_per_day(self):
        s = TickState(notices={'hold': '2026-10-10'})
        self.assertFalse(ts.notice_due(s, 'hold', '2026-10-10'))
        self.assertTrue(ts.notice_due(s, 'hold', '2026-10-11'))
        self.assertTrue(ts.notice_due(s, 'ancestry', '2026-10-10'))

    def test_once_notice_is_due_only_before_the_first(self):
        s = TickState(notices={f'ci-failed:{A}': '2026-10-01'})
        self.assertFalse(ts.notice_due(s, f'ci-failed:{A}', '2026-10-10', 'once'))
        self.assertTrue(ts.notice_due(s, f'ci-failed:{B}', '2026-10-10', 'once'))

    def test_unknown_repeat_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "unknown repeat 'hourly'"):
            ts.notice_due(TickState(), 'hold', '2026-10-10', 'hourly')

    def test_noted_records_the_day_and_drops_keys_older_than_the_keep_period(self):
        s = TickState(notices={'hold': '2026-09-10', 'ancestry': '2026-09-09', 'ci-stuck': '2026-10-01'})
        # 2026-10-10 minus 2026-09-10 is 30 days (kept), minus 2026-09-09 is 31 (dropped).
        got = ts.noted(s, 'fetch-failed', '2026-10-10')
        self.assertEqual(dict(got.notices), {'hold': '2026-09-10', 'ci-stuck': '2026-10-01',
                                             'fetch-failed': '2026-10-10'})
        self.assertIsInstance(got.notices, MappingProxyType)
        self.assertEqual(dict(s.notices), {'hold': '2026-09-10', 'ancestry': '2026-09-09', 'ci-stuck': '2026-10-01'})


if __name__ == '__main__':
    unittest.main()
