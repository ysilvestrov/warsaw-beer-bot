import os
from pathlib import Path
import tempfile
import unittest

import reboot_request as rr

NOW = 1_791_461_800
REBOOT = ['systemctl', 'reboot']
AT_0400 = ['systemd-run', '--unit=wbb-reboot-0400', '--on-calendar=*-*-* 04:00:00 Europe/Warsaw',
           '--timer-property=AccuracySec=1min', 'systemctl', 'reboot']


class Recorder:
    """A fake command runner: records argv, answers (code, stderr)."""
    def __init__(self, answer=(0, '')):
        self.calls, self.answer = [], answer

    def __call__(self, argv):
        self.calls.append(argv)
        return self.answer


class Handler(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.path = self.dir / 'reboot-request'

    def tearDown(self):
        self.tmp.cleanup()

    def handle(self, content=None, runner=None, now=NOW):
        if content is not None:
            self.path.write_bytes(content)
        run = runner or Recorder()
        return rr.handle(str(self.path), run, now), run

    def test_now_reboots_and_deletes_the_request(self):
        (code, message), run = self.handle(f'now {NOW}\n'.encode())
        self.assertEqual((code, message, run.calls, self.path.exists()), (0, 'reboot now', [REBOOT], False))

    def test_0400_schedules_the_fixed_name_timer(self):
        (code, message), run = self.handle(f'0400 {NOW}\n'.encode())
        self.assertEqual((code, message, run.calls), (0, 'reboot scheduled for 04:00 Europe/Warsaw', [AT_0400]))

    def test_a_second_0400_is_already_scheduled_not_a_failure(self):
        busy = Recorder((1, 'Failed to start transient timer unit: Unit wbb-reboot-0400.timer was already loaded or has a fragment file.\n'))
        (code, message), _ = self.handle(f'0400 {NOW}\n'.encode(), busy)
        self.assertEqual((code, message), (0, 'reboot already scheduled for 04:00'))

    def test_any_other_systemd_run_failure_fails(self):
        (code, message), _ = self.handle(f'0400 {NOW}\n'.encode(), Recorder((1, 'Failed to connect to bus\n')))
        self.assertEqual((code, message), (1, 'systemd-run failed: Failed to connect to bus'))

    def test_a_request_exactly_600_seconds_old_is_accepted(self):
        (code, _), run = self.handle(f'now {NOW - 600}\n'.encode())
        self.assertEqual((code, run.calls), (0, [REBOOT]))

    def test_a_request_601_seconds_old_is_refused_and_deleted(self):
        (code, message), run = self.handle(f'now {NOW - 601}\n'.encode())
        self.assertEqual((code, message, run.calls, self.path.exists()), (1, 'refused: stale or future request', [], False))

    def test_a_request_more_than_60_seconds_in_the_future_is_refused(self):
        (code, _), run = self.handle(f'now {NOW + 61}\n'.encode())
        self.assertEqual((code, run.calls), (1, []))

    def test_a_request_60_seconds_in_the_future_is_accepted(self):
        (code, _), run = self.handle(f'now {NOW + 60}\n'.encode())
        self.assertEqual((code, run.calls), (0, [REBOOT]))

    def test_unknown_content_is_refused_and_deleted(self):
        for content in (b'reboot now\n', f'now {NOW} extra\n'.encode(), f'NOW {NOW}\n'.encode(), b'', f'now {NOW}\nnow {NOW}\n'.encode()):
            with self.subTest(content=content):
                (code, message), run = self.handle(content)
                self.assertEqual((code, message, run.calls, self.path.exists()), (1, 'refused: unknown content', [], False))

    def test_a_request_over_64_bytes_is_refused_and_deleted(self):
        (code, message), run = self.handle(b'now ' + b'1' * 61 + b'\n')
        self.assertEqual((code, message, run.calls, self.path.exists()), (1, 'refused: not a small regular file', [], False))

    def test_a_symlinked_request_is_refused_its_link_removed_and_its_target_untouched(self):
        target = self.dir / 'target'
        target.write_text(f'now {NOW}\n')
        self.path.symlink_to(target)
        (code, message), run = self.handle()
        self.assertEqual((code, message, run.calls, os.path.lexists(self.path), target.read_text()),
                         (1, 'refused: not a small regular file', [], False, f'now {NOW}\n'))

    def test_a_directory_in_its_place_is_refused(self):
        self.path.mkdir()
        (code, message), run = self.handle()
        self.assertEqual((code, message, run.calls), (1, 'refused: not a small regular file', []))

    def test_no_request_is_a_quiet_no_op(self):
        # PathChanged can fire again after the handler's own delete.
        (code, message), run = self.handle()
        self.assertEqual((code, message, run.calls), (0, 'no request', []))


if __name__ == '__main__':
    unittest.main()
