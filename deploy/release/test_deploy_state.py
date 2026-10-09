import dataclasses
import json
import os
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deploy_state as ds  # noqa: E402
from deploy_state import Observe, Pre, Release, Settled, State, StateError, Unverified  # noqa: E402

BOOT = '0f0e0d0c-0b0a-4908-8706-050403020100'
OTHER_BOOT = '11111111-2222-4333-8444-555555555555'
TXN = '0123456789abcdef0123456789abcdef'
CAND = Release('c' * 40, '1' * 64)
PREV = Release('b' * 40, '2' * 64)
PRE = Pre('/var/lib/warsaw-beer-bot/deploy-snapshots/20261009T080000Z-pre.db', '3' * 64, 1760000000)
POST = '/var/lib/warsaw-beer-bot/deploy-snapshots/20261009T080000Z-rollback-post'
POST2 = POST + '-2'
OBS = Observe(1760000100, BOOT, 0, 1760000110.5, 1, 1760000102)
SETTLED = Settled(PREV.sha, PREV.tree_sha256, 1759990000)

# A full, valid state of every phase/intent pair, written out by hand.
OPEN = dict(txn=TXN, candidate=CAND, previous=PREV, pre=PRE, settled=SETTLED)
EXAMPLES = [
    State('settled', BOOT),
    State('settled', BOOT, settled=SETTLED, last_failed_sha='d' * 40, last_txn=TXN),
    State('activating', BOOT, intent='stop', **OPEN),
    State('activating', BOOT, intent='switch', **OPEN),
    State('activating', BOOT, intent='start', **OPEN),
    State('observing', BOOT, observe=OBS, **OPEN),
    State('observing', BOOT, observe=Observe(1760000100, BOOT, None, None, 0), **OPEN),
    State('rolling-back', BOOT, intent='stop-writers', **OPEN),
    State('rolling-back', BOOT, intent='save-post', **OPEN),
    State('rolling-back', BOOT, intent='restore-pre', posts=(POST,), **OPEN),
    State('rolling-back', BOOT, intent='switch-previous', **OPEN),
    State('rolling-back', BOOT, intent='start-baseline', posts=(POST, POST2), **OPEN),
    State('unverified', OTHER_BOOT, observe=OBS, unverified=Unverified(CAND.sha, 'reboot during the window', PRE),
          **OPEN),
    State('unverified', BOOT, unverified=Unverified(CAND.sha, 'gap 41 s', None), **OPEN),
    State('recovery-failed', BOOT, posts=(POST,), **OPEN).log(1760000200, 'start-baseline', 'health timeout',
                                                          sha=PREV.sha, fails=3, ok=False, note=None),
]


def as_json(state):
    return json.loads(state.to_bytes())


class Tmp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.path = os.path.join(self.dir, ds.STATE_NAME)

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, data):
        with open(self.path, 'wb') as f:
            f.write(data)

    def read(self):
        with open(self.path, 'rb') as f:
            return f.read()


class RoundTrip(Tmp):
    def test_every_phase_and_intent_survives_save_and_load(self):
        for state in EXAMPLES:
            with self.subTest(phase=state.phase, intent=state.intent):
                ds.save(self.path, state)
                self.assertEqual(ds.load(self.path), state)
                self.assertEqual(ds.load(self.path).to_bytes(), self.read())

    def test_examples_cover_every_phase_and_intent(self):
        pairs = {(s.phase, s.intent) for s in EXAMPLES}
        self.assertEqual(pairs, {(p, i) for p, intents in ds.INTENTS.items() for i in intents})

    def test_bytes_are_canonical_json_with_camel_case_keys(self):
        ds.save(self.path, State('settled', BOOT, settled=SETTLED).log(5, 'settle', 'ok'))
        self.assertEqual(self.read(), (
            '{"bootId":"0f0e0d0c-0b0a-4908-8706-050403020100","candidate":null,'
            '"evidence":[{"at":5,"result":"ok","txn":null,"what":"settle"}],"formatVersion":2,"intent":null,'
            '"lastFailedSha":null,"lastTxn":null,"observe":null,"phase":"settled","posts":[],"pre":null,"previous":null,'
            '"settled":{"settledAt":1759990000,"sha":"' + 'b' * 40 + '","treeSha256":"' + '2' * 64 + '"},'
            '"txn":null,"unverified":null}').encode())

    def test_nested_records_use_their_json_keys(self):
        got = as_json(EXAMPLES[12])
        self.assertEqual((got['observe'], got['unverified'], got['pre']), (
            {'startedAt': 1760000100, 'bootId': BOOT, 'nrestarts0': 0, 'lastSampleAt': 1760000110.5, 'fails': 1,
             'healthyAt': 1760000102},
            {'sha': CAND.sha, 'reason': 'reboot during the window',
             'pre': {'path': PRE.path, 'sha256': '3' * 64, 'takenAt': 1760000000}},
            {'path': PRE.path, 'sha256': '3' * 64, 'takenAt': 1760000000}))


class Load(Tmp):
    def refused(self, data):
        self.write(data)
        with self.assertRaises(StateError) as cm:
            ds.load(self.path)
        return str(cm.exception)

    def mutated(self, base=EXAMPLES[2], **changes):
        obj = as_json(base)
        obj.update(changes)
        return self.refused(json.dumps(obj).encode())

    def test_missing_file_is_the_first_run(self):
        self.assertIsNone(ds.load(self.path))

    def test_empty(self):
        self.assertEqual(self.refused(b''), f'{self.path}: empty')

    def test_not_json(self):
        self.assertEqual(self.refused(b'{"phase": '),
                         f'{self.path}: not JSON (Expecting value: line 1 column 11 (char 10))')

    def test_not_an_object(self):
        self.assertEqual(self.refused(b'[]'), f'{self.path}: state: not an object: list')

    def test_version_1(self):
        self.assertEqual(self.mutated(formatVersion=1), f'{self.path}: state: formatVersion 1, expected 2')

    def test_version_missing_or_not_an_int(self):
        obj = as_json(EXAMPLES[0])
        del obj['formatVersion']
        self.assertEqual(self.refused(json.dumps(obj).encode()), f'{self.path}: state: formatVersion None, expected 2')
        self.assertEqual(self.mutated(formatVersion=2.0), f'{self.path}: state: formatVersion 2.0, expected 2')

    def test_unknown_phase(self):
        self.assertEqual(self.mutated(phase='deploying'),
                         f"{self.path}: state.phase: not a known phase: 'deploying'")

    def test_activating_without_candidate(self):
        self.assertEqual(self.mutated(candidate=None), f'{self.path}: State.candidate: required in activating')

    def test_intent_of_another_phase(self):
        self.assertEqual(self.mutated(intent='save-post'),
                         f"{self.path}: State.intent: 'save-post' is not an intent of phase activating")

    def test_settled_carries_no_intent(self):
        self.assertEqual(self.mutated(EXAMPLES[0], intent='stop'),
                         f"{self.path}: State.intent: 'stop' is not an intent of phase settled")

    def test_settled_has_no_open_transaction(self):
        self.assertEqual(self.mutated(EXAMPLES[0], txn=TXN),
                         f'{self.path}: State.txn: a settled state has no open transaction')

    def test_observing_without_observe(self):
        self.assertEqual(self.mutated(EXAMPLES[5], observe=None), f'{self.path}: State.observe: required in observing')

    def test_restore_without_a_complete_post(self):
        self.assertEqual(self.mutated(EXAMPLES[9], posts=[]),
                         f'{self.path}: State.posts: required in rolling-back/restore-pre')

    def test_posts_is_a_list(self):
        self.assertEqual(self.mutated(EXAMPLES[9], posts=POST),
                         f'{self.path}: state.posts: not a list: {POST!r}')

    def test_a_post_absent_is_an_error_not_an_empty_list(self):
        obj = as_json(EXAMPLES[0])
        del obj['posts']
        self.assertEqual(self.refused(json.dumps(obj).encode()), f"{self.path}: state: missing ['posts'], unknown []")

    def test_unverified_without_its_record(self):
        self.assertEqual(self.mutated(EXAMPLES[13], unverified=None),
                         f'{self.path}: State.unverified: required in unverified')

    def test_missing_and_unknown_keys(self):
        obj = as_json(EXAMPLES[0])
        del obj['evidence']
        obj['extra'] = 1
        self.assertEqual(self.refused(json.dumps(obj).encode()),
                         f"{self.path}: state: missing ['evidence'], unknown ['extra']")

    def test_nested_record_with_an_unknown_key(self):
        obj = as_json(EXAMPLES[2])
        obj['candidate']['runId'] = 7
        self.assertEqual(self.refused(json.dumps(obj).encode()),
                         f"{self.path}: state.candidate: missing [], unknown ['runId']")

    def test_duplicate_key(self):
        self.assertEqual(self.refused(b'{"phase":"settled","phase":"observing"}'),
                         f"{self.path}: duplicate keys ['phase']")

    def test_short_sha(self):
        obj = as_json(EXAMPLES[2])
        obj['candidate']['sha'] = 'c' * 39
        self.assertEqual(self.refused(json.dumps(obj).encode()),
                         f"{self.path}: state.candidate.sha: not a full lowercase SHA: '{'c' * 39}'")

    def test_bool_is_not_a_count(self):
        obj = as_json(EXAMPLES[5])
        obj['observe']['fails'] = True
        self.assertEqual(self.refused(json.dumps(obj).encode()),
                         f'{self.path}: state.observe.fails: not a non-negative integer: True')

    def test_nan_time(self):
        obj = as_json(EXAMPLES[5])
        obj['observe']['startedAt'] = float('nan')
        self.assertEqual(self.refused(json.dumps(obj).encode()),
                         f'{self.path}: state.observe.startedAt: not a finite non-negative number: nan')

    def test_an_int_too_big_for_a_float_time_is_refused(self):
        # 2v review: math.isfinite(10**400) raised OverflowError instead of a StateError.
        obj = as_json(EXAMPLES[5])
        obj['observe']['startedAt'] = 10 ** 400
        self.assertEqual(self.refused(json.dumps(obj).encode()),
                         f'{self.path}: state.observe.startedAt: not a finite non-negative number: 1{"0" * 400}')

    def test_observe_without_healthy_at(self):
        # The window cannot tell startup from the watch without it, so a file lacking it is refused.
        obj = as_json(EXAMPLES[5])
        del obj['observe']['healthyAt']
        self.assertEqual(self.refused(json.dumps(obj).encode()),
                         f"{self.path}: state.observe: missing ['healthyAt'], unknown []")

    def test_negative_healthy_at(self):
        obj = as_json(EXAMPLES[5])
        obj['observe']['healthyAt'] = -1
        self.assertEqual(self.refused(json.dumps(obj).encode()),
                         f'{self.path}: state.observe.healthyAt: not a finite non-negative number: -1')

    def test_relative_post_path(self):
        self.assertEqual(self.mutated(EXAMPLES[11], posts=[POST, 'post']),
                         f"{self.path}: state.posts[1]: not an absolute path: 'post'")

    def test_evidence_entry_without_result(self):
        self.assertEqual(self.mutated(EXAMPLES[0], evidence=[{'at': 1, 'what': 'stop'}]),
                         f'{self.path}: state.evidence[0]: missing result')

    def test_evidence_detail_that_is_not_a_scalar(self):
        self.assertEqual(self.mutated(EXAMPLES[0], evidence=[{'at': 1, 'what': 'stop', 'result': 'ok', 'x': [1]}]),
                         f"{self.path}: state.evidence[0]: detail 'x' is not a finite JSON scalar or a list of strings: [1]")

    def test_evidence_detail_list_with_an_empty_string(self):
        self.assertEqual(self.mutated(EXAMPLES[0], evidence=[{'at': 1, 'what': 'x', 'result': 'ok', 'posts': [POST, '']}]),
                         f"{self.path}: state.evidence[0]: detail 'posts' is not a finite JSON scalar or a list of strings: "
                         f"[{POST!r}, '']")

    def test_oversized_file(self):
        self.assertEqual(self.refused(b' ' * (ds.MAX_BYTES + 1)), f'{self.path}: over {ds.MAX_BYTES} bytes')

    def test_exactly_the_size_cap_is_read(self):
        data = EXAMPLES[0].to_bytes()
        self.write(data + b' ' * (ds.MAX_BYTES - len(data)))
        self.assertEqual(ds.load(self.path), EXAMPLES[0])


class Immutable(unittest.TestCase):
    def test_replace_validates_and_leaves_the_original(self):
        with self.assertRaises(StateError) as cm:
            EXAMPLES[2].replace(intent='restore-pre')
        self.assertEqual((str(cm.exception), EXAMPLES[2].intent),
                         ("State.intent: 'restore-pre' is not an intent of phase activating", 'stop'))

    def test_replace_returns_the_changed_state(self):
        moved = EXAMPLES[2].replace(intent='switch')
        self.assertEqual((moved, EXAMPLES[2].intent), (EXAMPLES[3], 'stop'))

    def test_fields_cannot_be_assigned(self):
        with self.assertRaises(dataclasses.FrozenInstanceError):
            EXAMPLES[0].phase = 'observing'

    def test_evidence_events_are_frozen_copies(self):
        event = {'at': 1, 'what': 'stop', 'result': 'ok'}
        state = State('settled', BOOT, evidence=[event])
        event['result'] = 'changed'
        with self.assertRaises(TypeError):
            state.evidence[0]['result'] = 'x'
        self.assertEqual(dict(state.evidence[0]), {'at': 1, 'what': 'stop', 'result': 'ok'})

    def test_log_appends_one_event(self):
        state = EXAMPLES[2].log(10, 'stop', 'ok').log(11, 'switch', 'ok', sha=CAND.sha)
        self.assertEqual([dict(e) for e in state.evidence],
                         [{'at': 10, 'what': 'stop', 'result': 'ok', 'txn': TXN},
                          {'at': 11, 'what': 'switch', 'result': 'ok', 'sha': CAND.sha, 'txn': TXN}])

    def test_an_event_after_the_transaction_ended_carries_the_last_txn(self):
        # 2в e2e review Ф6: the ending event is logged once txn is cleared; it still names its txn.
        ended = EXAMPLES[2].replace(phase='settled', intent=None, txn=None, last_txn=TXN)
        self.assertEqual((dict(ended.log(12, 'settled', 'ok').evidence[0]),
                          dict(EXAMPLES[0].log(1, 'x', 'ok').evidence[0])),
                         ({'at': 12, 'what': 'settled', 'result': 'ok', 'txn': TXN},
                          {'at': 1, 'what': 'x', 'result': 'ok', 'txn': None}))

    def test_last_txn_must_be_a_txn(self):
        with self.assertRaises(StateError) as cm:
            State('settled', BOOT, last_txn='x' * 32)
        self.assertEqual(str(cm.exception), f"State.lastTxn: not a 32-hex transaction id: '{'x' * 32}'")

    def test_log_refuses_a_detail_that_is_not_a_scalar(self):
        with self.assertRaises(StateError) as cm:
            EXAMPLES[2].log(10, 'stop', 'ok', units={'bot': 1})
        self.assertEqual(str(cm.exception),
                         "State.evidence[0]: detail 'units' is not a finite JSON scalar or a list of strings: {'bot': 1}")

    def test_a_list_of_strings_is_kept_frozen_and_round_trips(self):
        # 2в e2e review Ф1: the rolled-back event names every post of the rollback.
        posts = [POST, POST2]
        state = EXAMPLES[0].log(10, 'rolled-back', 'ok', posts=posts)
        posts.append('/x')
        self.assertEqual((state.evidence[0]['posts'], as_json(state)['evidence'][0]['posts'],
                          State.from_json(as_json(state)) == state),
                         ((POST, POST2), [POST, POST2], True))

    def test_replace_carries_the_frozen_events_as_a_plain_tuple(self):
        logged = EXAMPLES[2].log(10, 'stop', 'ok')
        moved = logged.replace(intent='switch')
        self.assertEqual((type(moved.evidence), moved.evidence[0] is logged.evidence[0], moved),
                         (tuple, True, State('activating', BOOT, intent='switch', evidence=[
                             {'at': 10, 'what': 'stop', 'result': 'ok', 'txn': TXN}], **OPEN)))

    def test_constructor_refuses_a_bad_record(self):
        with self.assertRaises(StateError) as cm:
            State('activating', BOOT, intent='stop', **{**OPEN, 'candidate': {'sha': CAND.sha}})
        self.assertEqual(str(cm.exception), "State.candidate: not a Release: {'sha': '" + CAND.sha + "'}")

    def test_negative_time(self):
        with self.assertRaises(StateError) as cm:
            Pre(PRE.path, PRE.sha256, -1)
        self.assertEqual(str(cm.exception), 'Pre.takenAt: not a finite non-negative number: -1')

    def test_the_largest_int_a_float_holds_is_a_time_and_the_next_power_of_two_is_not(self):
        # 2v review: the boundary of the OverflowError fix — 2**1024 is the first int no float can hold.
        biggest = int(sys.float_info.max)
        with self.assertRaises(StateError) as cm:
            Pre(PRE.path, PRE.sha256, 2 ** 1024)
        self.assertEqual((Pre(PRE.path, PRE.sha256, biggest).taken_at, str(cm.exception)),
                         (biggest, f'Pre.takenAt: not a finite non-negative number: {2 ** 1024}'))


class Save(Tmp):
    def test_success_leaves_only_the_state_file(self):
        ds.save(self.path, EXAMPLES[0])
        ds.save(self.path, EXAMPLES[2])
        self.assertEqual((os.listdir(self.dir), self.read(), stat.S_IMODE(os.stat(self.path).st_mode)),
                         ([ds.STATE_NAME], EXAMPLES[2].to_bytes(), 0o600))

    def test_failed_rename_keeps_the_old_file_and_no_temp(self):
        ds.save(self.path, EXAMPLES[0])
        with mock.patch.object(ds.pub.os, 'rename', side_effect=OSError(28, 'No space left on device')):
            with self.assertRaises(OSError):
                ds.save(self.path, EXAMPLES[2])
        self.assertEqual((os.listdir(self.dir), self.read()), ([ds.STATE_NAME], EXAMPLES[0].to_bytes()))

    def test_fsyncs_the_file_then_renames_then_fsyncs_its_directory(self):
        events = []
        real_fsync, real_rename = os.fsync, os.rename
        dir_ino = os.stat(self.dir).st_ino

        def fsync(fd):
            st = os.fstat(fd)
            kind = 'file' if stat.S_ISREG(st.st_mode) else ('state-dir' if st.st_ino == dir_ino else 'other-dir')
            events.append(('fsync', kind))
            return real_fsync(fd)

        def rename(src, dst):
            events.append(('rename', os.path.dirname(src) == self.dir, dst == self.path))
            return real_rename(src, dst)

        with mock.patch.object(os, 'fsync', fsync), mock.patch.object(os, 'rename', rename):
            ds.save(self.path, EXAMPLES[0])
        self.assertEqual(events, [('fsync', 'file'), ('rename', True, True), ('fsync', 'state-dir')])

    def test_refuses_anything_but_a_state(self):
        with self.assertRaises(TypeError):
            ds.save(self.path, as_json(EXAMPLES[0]))
        self.assertEqual(os.listdir(self.dir), [])


class Helpers(Tmp):
    def test_new_txn_is_32_hex_and_fresh(self):
        a, b = ds.new_txn(), ds.new_txn()
        self.assertEqual((len(a), set(a) <= set('0123456789abcdef'), a == b), (32, True, False))
        self.assertEqual(State('activating', BOOT, intent='stop', **{**OPEN, 'txn': a}).txn, a)

    def test_read_boot_id(self):
        self.write(f'{BOOT}\n'.encode())
        self.assertEqual(ds.read_boot_id(self.path), BOOT)

    def test_read_boot_id_refuses_anything_else(self):
        self.write(b'not-a-boot-id\n')
        with self.assertRaises(StateError) as cm:
            ds.read_boot_id(self.path)
        self.assertEqual(str(cm.exception), f"{self.path}: not a boot id: 'not-a-boot-id\\n'")

    def test_read_boot_id_of_a_missing_file(self):
        with self.assertRaises(FileNotFoundError):
            ds.read_boot_id(self.path)

    def test_production_paths(self):
        self.assertEqual((ds.BOOT_ID_PATH, ds.STATE_NAME, ds.FORMAT_VERSION),
                         ('/proc/sys/kernel/random/boot_id', 'deploy-state.json', 2))


if __name__ == '__main__':
    unittest.main()
