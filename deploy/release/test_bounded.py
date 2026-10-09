import os
import subprocess
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounded  # noqa: E402


def py(code):
    return [sys.executable, '-c', code]


class Bounded(unittest.TestCase):
    def test_small_output_is_kept_whole(self):
        r = bounded.run(py('import sys; print("out"); print("err", file=sys.stderr); sys.exit(3)'), timeout=30, text=True)
        self.assertEqual((r.returncode, r.stdout, r.stderr, r.truncated), (3, 'out\n', 'err\n', False))

    def test_a_flood_is_cut_at_the_cap_and_the_child_still_finishes(self):
        # 8 MiB on each stream against a 1000-byte cap: kept bytes stay bounded, nothing blocks.
        r = bounded.run(py('import sys; sys.stdout.write("x" * (8 << 20)); sys.stderr.write("y" * (8 << 20))'),
                        timeout=60, cap=1000, tail=10)
        self.assertEqual((r.returncode, r.stdout, r.stderr, r.truncated),
                         (0, b'x' * 1000 + bounded.MARK + b'x' * 10, b'y' * 1000 + bounded.MARK + b'y' * 10, True))

    def test_the_last_line_survives_a_flood(self):
        # #817 AI review: systemd-run's footer comes after whatever the candidate wrote.
        r = bounded.run(py('import sys; sys.stderr.write("y" * (4 << 20)); sys.stderr.write("\\nFinished with result: success\\n")'),
                        timeout=60, cap=100, tail=64, text=True)
        footer = '\nFinished with result: success\n'
        self.assertEqual(r.stderr, 'y' * 100 + bounded.MARK.decode() + 'y' * (64 - len(footer)) + footer)

    def test_exactly_the_cap_is_not_truncated(self):
        r = bounded.run(py('import sys; sys.stdout.write("x" * 1010)'), timeout=30, cap=1000, tail=10)
        self.assertEqual((r.stdout, r.truncated), (b'x' * 1010, False))

    def test_timeout_kills_the_child(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            bounded.run(py('import time; time.sleep(60)'), timeout=1)

    def test_a_descendant_holding_the_pipe_does_not_hang_the_timeout(self):
        # #817 AI review: with --pipe the unit's processes keep our pipes open after systemd-run dies.
        start = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            bounded.run(py('import subprocess, time; subprocess.Popen(["sleep", "30"]); time.sleep(30)'),
                        timeout=1, join_grace=1)
        self.assertLess(time.monotonic() - start, 10)

    def test_a_descendant_holding_the_pipe_does_not_hang_a_normal_exit(self):
        start = time.monotonic()
        r = bounded.run(py('import subprocess; subprocess.Popen(["sleep", "30"]); print("done")'),
                        timeout=20, join_grace=1, text=True)
        self.assertEqual((r.returncode, r.stdout, r.truncated), (0, 'done\n', True))
        self.assertLess(time.monotonic() - start, 10)

    def test_any_exception_kills_the_child(self):
        # #817 AI review: Ctrl-C while waiting must not leave the child (systemd-run) running.
        killed = []

        class Interrupted(subprocess.Popen):
            def wait(self, timeout=None):
                if timeout is not None and not killed:
                    raise KeyboardInterrupt
                return super().wait(timeout)

            def kill(self):
                killed.append(self.pid)
                super().kill()
        with mock.patch.object(bounded.subprocess, 'Popen', Interrupted), self.assertRaises(KeyboardInterrupt):
            bounded.run(py('import time; time.sleep(30)'), timeout=20, join_grace=1)
        self.assertEqual(len(killed), 1)

    def test_limits_are_validated_before_anything_runs(self):
        # #817 AI review: tail=0 used to kill the reader thread with IndexError.
        for cap, tail in ((0, 0), (-1, 10), (10, -5)):
            with self.subTest(cap=cap, tail=tail), self.assertRaisesRegex(ValueError, '^cap must be >= 0 and tail >= 1'):
                bounded.run(py('print(1)'), timeout=5, cap=cap, tail=tail)

    def test_zero_head_keeps_only_the_tail(self):
        r = bounded.run(py('import sys; sys.stdout.write("abcdef")'), timeout=30, cap=0, tail=3)
        self.assertEqual((r.stdout, r.truncated), (bounded.MARK + b'def', True))

    def test_a_failed_read_marks_the_capture_truncated(self):
        # #817 AI review: a read error part-way must not pass for a complete capture.
        class Broken:
            calls = 0

            def read1(self, n):
                Broken.calls += 1
                if Broken.calls == 1:
                    return b'partial'
                raise OSError(5, 'Input/output error')

            def close(self):
                pass
        d = bounded._Drain(Broken(), 100, 10)
        d._run()
        self.assertEqual((bytes(d.head), d.dropped), (b'partial', True))

    def test_check_raises_on_failure(self):
        with self.assertRaises(subprocess.CalledProcessError) as cm:
            bounded.run(py('import sys; sys.exit(2)'), timeout=30, check=True)
        self.assertEqual(cm.exception.returncode, 2)

    def test_missing_binary_raises_file_not_found(self):
        with self.assertRaises(FileNotFoundError):
            bounded.run(['/nonexistent/binary'], timeout=5)

    def test_environment_and_directory_are_passed(self):
        r = bounded.run(py('import os; print(os.environ["X"], os.getcwd())'), timeout=30, text=True,
                        env={'X': 'y'}, cwd='/')
        self.assertEqual(r.stdout, 'y /\n')


if __name__ == '__main__':
    unittest.main()
