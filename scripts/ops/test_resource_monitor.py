"""Literal counters, no allocation pressure or external notification traffic."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

import resource_monitor
from resource_monitor import evaluate, main, telegram, tick

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

    def test_disk_above_ten_gib_stays_normal_after_fifteen_minutes(self):
        state = None
        for at in (0, 300, 600, 900):
            state = evaluate(state, sample(at, bytes_available=10*GIB+1))
        self.assertEqual(state['levels']['disk'], 'normal')

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

    def test_forecast_uses_an_hour_despite_cron_jitter(self):
        state = None
        for index, at in enumerate((0, 302, 600, 900, 1200, 1500, 1800,
                                    2100, 2400, 2700, 3000, 3300, 3600, 3901)):
            state = evaluate(state, sample(at, inodes_free=2_000_000-index*1000))
        self.assertEqual(state['forecast'], {'inode_seconds': 596253, 'disk_seconds': None})

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

    def test_manual_none_mode_does_not_acknowledge_the_operational_channel(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('sys.argv', ['resource_monitor.py', '--state-dir', directory,
                                     '--runs-dir', str(Path(directory)/'missing'), '--notify', 'none']), \
                    patch('resource_monitor.collect', return_value=sample(inodes_free=500_000)), \
                    patch('resource_monitor.telegram') as send, patch('builtins.print'):
                self.assertEqual(main(), 0)
                send.assert_not_called()
            recorded = json.loads(Path(directory, 'state.json').read_text())
            self.assertEqual(recorded['levels']['inode'], 'critical')
            self.assertEqual(recorded['announced']['inode'], 'normal')
            messages = []
            tick(Path(directory), sample(300, inodes_free=500_000), messages.append, [])
            self.assertEqual(len(messages), 1)

    def test_telegram_requires_json_acceptance(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":false}'
        credential = MagicMock(returncode=0, stdout='synthetic-secret')
        with patch('resource_monitor.subprocess.run', return_value=credential), \
                patch('resource_monitor.urlopen', return_value=response):
            with self.assertRaisesRegex(RuntimeError, '^operational notification delivery failed$') as raised:
                telegram('test')
        self.assertEqual(raised.exception.__cause__, None)

    def test_telegram_http_error_is_token_free(self):
        credential = MagicMock(returncode=0, stdout='synthetic-secret')
        error = HTTPError('https://example.invalid/botsynthetic-secret/sendMessage',
                          500, 'synthetic-secret', {}, None)
        with patch('resource_monitor.subprocess.run', return_value=credential), \
                patch('resource_monitor.urlopen', side_effect=error):
            with self.assertRaisesRegex(RuntimeError, '^operational notification delivery failed$') as raised:
                telegram('test')
        self.assertEqual(raised.exception.__cause__, None)

    def test_telegram_accepts_only_confirmed_delivery(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        credential = MagicMock(returncode=0, stdout='synthetic-secret')
        with patch('resource_monitor.subprocess.run', return_value=credential), \
                patch('resource_monitor.urlopen', return_value=response) as transport:
            self.assertEqual(telegram('test'), None)
        transport.assert_called_once()
        self.assertEqual(transport.call_args.kwargs, {'timeout': 10})
        response.__enter__.return_value.read.assert_called_once_with(65536)

    def test_crash_inventory_appearance_and_disappearance_are_silent(self):
        with tempfile.TemporaryDirectory() as directory:
            messages = []
            active = [{'name': 'run-a', 'status': 'active'}]
            crashed = [{'name': 'run-a', 'status': 'uncertain_current_boot'}]
            tick(Path(directory), sample(0), messages.append, active)
            tick(Path(directory), sample(300), messages.append, crashed)
            tick(Path(directory), sample(600), messages.append, crashed)
            self.assertEqual(messages, [])
            tick(Path(directory), sample(900), messages.append, [])
            self.assertEqual(messages, [])

    def test_busy_inventory_is_unavailable_without_notification(self):
        with tempfile.TemporaryDirectory() as directory:
            messages = []
            crashed = [{'name': 'run-a', 'status': 'uncertain_current_boot'}]
            tick(Path(directory), sample(0), messages.append, crashed)
            state = tick(Path(directory), sample(300), messages.append, None)
            self.assertEqual(messages, [])
            self.assertEqual(state['runs_inventory_available'], False)

    def test_upgrade_does_not_send_recovery_for_old_announced_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            prior = evaluate(None, sample())
            prior['announced']['runs'] = [{'name': 'run-a', 'status': 'uncertain_current_boot'}]
            Path(directory, 'state.json').write_text(json.dumps(prior))
            messages = []
            state = tick(Path(directory), sample(300), messages.append, [])
            self.assertEqual(messages, [])
            self.assertEqual(state['announced']['inode'], 'normal')
            self.assertEqual(len(state['history']), 2)

    def test_inventory_never_appears_in_real_resource_alert(self):
        with tempfile.TemporaryDirectory() as directory:
            messages = []
            tick(Path(directory), sample(inodes_free=500_000), messages.append,
                 [{'name': 'run-secret-name', 'status': 'uncertain_current_boot'}])
            self.assertEqual(messages, ['wbb root filesystem\ninode: normal → critical\n'
                                        'free inodes: 500,000; disk: 30.00 GiB'])

    def test_shared_snapshot_exact_payload_and_readable_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory, 'state')
            summary = Path(directory, 'summary')
            summary.mkdir(mode=0o755)
            messages = []
            tick(state, sample(300), messages.append,
                 [{'name': 'run-a', 'status': 'uncertain_current_boot'},
                  {'name': 'run-b', 'status': 'active'}], summary)
            self.assertEqual(json.loads((summary/'summary.json').read_text()), {
                'version': 1, 'timestamp': 300, 'inodes_free': 2_000_000,
                'bytes_available': 32_212_254_720,
                'runs_inventory_available': True, 'pending_runs': 1})
            self.assertEqual((summary/'summary.json').stat().st_mode & 0o777, 0o644)
            self.assertEqual((state/'state.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual(messages, [])
            self.assertEqual(sorted(p.name for p in summary.iterdir()), ['summary.json'])

    def test_empty_inventory_exports_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory, 'summary')
            summary.mkdir(mode=0o755)
            tick(Path(directory, 'state'), sample(), None, [], summary)
            exported = json.loads((summary/'summary.json').read_text())
            self.assertEqual(exported['pending_runs'], 0)
            self.assertEqual(exported['runs_inventory_available'], True)

    def test_incomplete_inventory_exports_unknown_instead_of_false_count(self):
        for runs in [None,
                     [{'name': '(inventory truncated)', 'status': 'uncertain_metadata'}],
                     [{'name': 'run-a', 'status': 'active', 'audit_errors': 1}]]:
            with self.subTest(runs=runs), tempfile.TemporaryDirectory() as directory:
                summary = Path(directory, 'summary')
                summary.mkdir(mode=0o755)
                tick(Path(directory, 'state'), sample(), None, runs, summary)
                exported = json.loads((summary/'summary.json').read_text())
                self.assertEqual(exported['pending_runs'], None)
                self.assertEqual(exported['runs_inventory_available'], False)

    def test_export_precedes_alert_and_survives_transport_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory, 'summary')
            summary.mkdir(mode=0o755)

            def unavailable(_message):
                self.assertEqual(json.loads((summary/'summary.json').read_text())['pending_runs'], 0)
                raise RuntimeError('transport unavailable')

            with self.assertRaisesRegex(RuntimeError, '^transport unavailable$'):
                tick(Path(directory, 'state'), sample(inodes_free=500_000), unavailable, [], summary)
            self.assertEqual(json.loads((summary/'summary.json').read_text())['inodes_free'], 500_000)
            recorded = json.loads(Path(directory, 'state/state.json').read_text())
            self.assertEqual(recorded['announced']['inode'], 'normal')

    def test_unsafe_export_directory_cannot_prevent_resource_alert(self):
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory, 'summary')
            summary.mkdir(mode=0o777)
            summary.chmod(0o777)
            messages = []
            with self.assertLogs('resource-monitor', level='ERROR'):
                tick(Path(directory, 'state'), sample(inodes_free=500_000), messages.append, [], summary)
            self.assertEqual(messages, ['wbb root filesystem\ninode: normal → critical\n'
                                        'free inodes: 500,000; disk: 30.00 GiB'])
            self.assertEqual(list(summary.iterdir()), [])

    def test_symlink_export_directory_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            real = Path(directory, 'real')
            real.mkdir(mode=0o755)
            link = Path(directory, 'summary')
            link.symlink_to(real, target_is_directory=True)
            with self.assertRaises(OSError):
                resource_monitor.publish_summary(link, sample(), [])
            self.assertEqual(list(real.iterdir()), [])

    def test_inventory_error_in_main_is_unavailable_and_silent(self):
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory, 'summary')
            summary.mkdir(mode=0o755)
            with patch('sys.argv', ['resource_monitor.py', '--state-dir', str(Path(directory, 'state')),
                                   '--summary-dir', str(summary), '--notify', 'telegram']), \
                    patch('resource_monitor.inventory', side_effect=OSError('audit failed')), \
                    patch('resource_monitor.collect', return_value=sample()), \
                    patch('resource_monitor.telegram') as send, patch('builtins.print'):
                self.assertEqual(main(), 0)
                send.assert_not_called()
            exported = json.loads((summary/'summary.json').read_text())
            self.assertEqual(exported['pending_runs'], None)
            self.assertEqual(exported['runs_inventory_available'], False)


if __name__ == '__main__':
    unittest.main()
