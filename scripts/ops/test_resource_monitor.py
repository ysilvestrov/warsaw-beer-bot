"""Literal counters, no allocation pressure or external notification traffic."""
import json
from pathlib import Path
import tempfile
import unittest

from resource_monitor import evaluate, tick

GIB = 1024**3


def sample(timestamp=0, **changes):
    return dict({'timestamp': timestamp, 'device': 1, 'inodes_total': 5_000_000,
                 'inodes_free': 2_000_000, 'bytes_total': 75*GIB,
                 'bytes_available': 30*GIB}, **changes)


class ResourceMonitor(unittest.TestCase):
    def test_inode_warning_waits_exactly_fifteen_minutes(self):
        state = None
        levels = []
        for at in (0, 300, 600, 900):
            state = evaluate(state, sample(at, inodes_free=1_000_000))
            levels.append(state['levels']['inode'])
        self.assertEqual(levels, ['normal', 'normal', 'normal', 'warning'])

    def test_exact_critical_and_free_inode_boundaries(self):
        for changes, expected in [
            ({'inodes_free': 500_000}, 'critical'),
            ({'inodes_free': 500_001}, 'normal'),
            ({'inodes_total': 500_000, 'inodes_free': 99_999}, 'critical'),
            ({'inodes_total': 500_000, 'inodes_free': 100_000}, 'normal'),
        ]:
            with self.subTest(changes=changes):
                self.assertEqual(evaluate(None, sample(**changes))['levels']['inode'], expected)

    def test_below_eighty_percent_never_warns(self):
        state = None
        for at in (0, 300, 600, 900):
            state = evaluate(state, sample(at, inodes_free=1_000_001))
        self.assertEqual(state['levels']['inode'], 'normal')

    def test_disk_has_separate_warning_and_critical(self):
        state = None
        for at in (0, 300, 600, 900):
            state = evaluate(state, sample(at, bytes_available=10*GIB))
        self.assertEqual(state['levels'], {'inode': 'normal', 'disk': 'warning'})
        self.assertEqual(evaluate(None, sample(bytes_available=5*GIB))['levels']['disk'], 'critical')
        self.assertEqual(evaluate(None, sample(bytes_available=5*GIB+1))['levels']['disk'], 'normal')

    def test_missing_sample_device_change_and_clock_reversal_reset_continuity(self):
        for final in [sample(1200, inodes_free=1_000_000),
                      sample(900, device=2, inodes_free=1_000_000),
                      sample(0, inodes_free=1_000_000)]:
            with self.subTest(final=final):
                state = None
                for at in (0, 300, 600):
                    state = evaluate(state, sample(at, inodes_free=1_000_000))
                self.assertEqual(evaluate(state, final)['levels']['inode'], 'normal')

    def test_does_not_announce_recovery_while_warning_is_pending(self):
        state = evaluate(None, sample(inodes_free=500_000))
        state = evaluate(state, sample(300, inodes_free=1_000_000))
        self.assertEqual(state['levels']['inode'], 'critical')
        state = evaluate(state, sample(600))
        self.assertEqual(state['levels']['inode'], 'normal')

    def test_history_has_a_fixed_bound(self):
        state = None
        for index in range(900):
            state = evaluate(state, sample(index*300))
        self.assertEqual(len(state['history']), 864)
        self.assertEqual(state['history'][0]['timestamp'], 10800)
        self.assertEqual(state['history'][-1]['timestamp'], 269700)

    def test_forecast_needs_thirteen_continuous_samples_and_no_cleanup(self):
        state = None
        for index in range(12):
            state = evaluate(state, sample(index*300, inodes_free=2_000_000-index*1000))
        self.assertEqual(state['forecast'], {'inode_seconds': None, 'disk_seconds': None})
        state = evaluate(state, sample(3600, inodes_free=1_988_000))
        self.assertEqual(state['forecast'], {'inode_seconds': 596400, 'disk_seconds': None})
        state = evaluate(state, sample(3900, inodes_free=2_000_000))
        self.assertEqual(state['forecast']['inode_seconds'], None)
        state = evaluate(state, sample(4800, inodes_free=1_987_000))
        self.assertEqual(state['forecast']['inode_seconds'], None)

    def test_invalid_counters_are_rejected(self):
        for changes in [{'inodes_free': -1}, {'inodes_total': 0},
                        {'inodes_free': 6_000_000}, {'bytes_available': -1},
                        {'timestamp': float('nan')}, {'bytes_available': 80*GIB}]:
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    evaluate(None, sample(**changes))

    def test_restart_delivers_transition_and_recovery_once(self):
        with tempfile.TemporaryDirectory() as directory:
            messages = []
            for at in (0, 300, 600, 900, 1200):
                tick(Path(directory), sample(at, inodes_free=1_000_000), messages.append, [])
            self.assertEqual(len(messages), 1)
            self.assertIn('inode: normal → warning', messages[0])
            tick(Path(directory), sample(1500), messages.append, [])
            tick(Path(directory), sample(1800), messages.append, [])
            self.assertEqual(len(messages), 2)
            self.assertIn('inode: warning → normal', messages[1])
            self.assertEqual(json.loads(Path(directory, 'state.json').read_text())['announced'],
                             {'inode': 'normal', 'disk': 'normal', 'runs': []})

    def test_delivery_failure_keeps_history_and_retries_without_false_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            def unavailable(_message):
                raise RuntimeError('transport unavailable')
            with self.assertRaises(RuntimeError):
                tick(Path(directory), sample(inodes_free=500_000), unavailable, [])
            recorded = json.loads(Path(directory, 'state.json').read_text())
            self.assertEqual(len(recorded['history']), 1)
            self.assertEqual(recorded['announced']['inode'], 'normal')
            messages = []
            tick(Path(directory), sample(300, inodes_free=500_000), messages.append, [])
            tick(Path(directory), sample(600, inodes_free=500_000), messages.append, [])
            self.assertEqual(len(messages), 1)

    def test_crash_inventory_announces_changes_without_deleting(self):
        with tempfile.TemporaryDirectory() as directory:
            messages = []
            active = [{'name': 'run-a', 'status': 'active'}]
            crashed = [{'name': 'run-a', 'status': 'uncertain_current_boot'}]
            tick(Path(directory), sample(0), messages.append, active)
            tick(Path(directory), sample(300), messages.append, crashed)
            tick(Path(directory), sample(600), messages.append, crashed)
            self.assertEqual(len(messages), 1)
            self.assertIn('run-a', messages[0])
            tick(Path(directory), sample(900), messages.append, [])
            self.assertEqual(len(messages), 2)

    def test_busy_inventory_preserves_previous_leftovers_without_false_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            messages = []
            crashed = [{'name': 'run-a', 'status': 'uncertain_current_boot'}]
            tick(Path(directory), sample(0), messages.append, crashed)
            state = tick(Path(directory), sample(300), messages.append, None)
            self.assertEqual(len(messages), 1)
            self.assertEqual(state['announced']['runs'], crashed)
            self.assertEqual(state['runs_inventory_available'], False)


if __name__ == '__main__':
    unittest.main()
