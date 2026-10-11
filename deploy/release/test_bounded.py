import hashlib
import inspect
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounded  # noqa: E402


def py(code):
    return [sys.executable, '-c', code]


class Bounded(unittest.TestCase):
    def tmp(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        return d

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

    def recording_popen(self):
        """A real Popen that records the signals bounded.run sends it, and the last instance."""
        sent, procs = [], []

        class Recording(subprocess.Popen):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                procs.append(self)

            def terminate(self):
                sent.append('TERM')
                super().terminate()

            def kill(self):
                sent.append('KILL')
                super().kill()
        return Recording, sent, procs

    def test_a_timeout_sends_sigterm_first_and_a_child_that_handles_it_exits_without_sigkill(self):
        # plan periphery-b2 "Рішення" п.6: sudo relays SIGTERM to its child; SIGKILL it cannot relay.
        marker = os.path.join(self.tmp(), 'marker')
        code = ('import signal, sys, time\n'
                'def on_term(signum, frame):\n'
                f'    open({marker!r}, "w").write("TERM")\n'
                '    sys.exit(0)\n'
                'signal.signal(signal.SIGTERM, on_term)\n'
                'time.sleep(60)\n')
        Recording, sent, procs = self.recording_popen()
        start = time.monotonic()
        with mock.patch.object(bounded.subprocess, 'Popen', Recording), self.assertRaises(subprocess.TimeoutExpired):
            bounded.run(py(code), timeout=5, term_grace=30)
        with open(marker) as f:
            self.assertEqual((f.read(), sent, procs[0].returncode), ('TERM', ['TERM'], 0))
        self.assertLess(time.monotonic() - start, 15)

    def test_a_child_that_ignores_sigterm_is_killed_after_the_grace(self):
        Recording, sent, procs = self.recording_popen()
        start = time.monotonic()
        with mock.patch.object(bounded.subprocess, 'Popen', Recording), self.assertRaises(subprocess.TimeoutExpired):
            bounded.run(py('import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'),
                        timeout=4, term_grace=1)
        elapsed = time.monotonic() - start
        self.assertEqual((sent, procs[0].returncode), (['TERM', 'KILL'], -signal.SIGKILL))
        # SIGKILL came only after the grace: the timeout (4 s) and the grace (1 s) both passed first.
        self.assertGreaterEqual(elapsed, 5)
        self.assertLess(elapsed, 15)

    def test_the_grace_is_ten_seconds_unless_a_test_says_otherwise(self):
        self.assertEqual((bounded.TERM_GRACE_S, inspect.signature(bounded.run).parameters['term_grace'].default),
                         (10, 10))

    def test_an_interrupted_grace_still_kills_the_child(self):
        Recording, sent, procs = self.recording_popen()

        class InterruptedGrace(Recording):
            def wait(self, timeout=None):
                # The real 1 s timeout lets the child ignore SIGTERM; Ctrl-C then lands inside the grace.
                if timeout == 30:
                    raise KeyboardInterrupt
                return super().wait(timeout)
        with mock.patch.object(bounded.subprocess, 'Popen', InterruptedGrace), self.assertRaises(KeyboardInterrupt):
            bounded.run(py('import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'),
                        timeout=4, term_grace=30, join_grace=1)
        self.assertEqual((sent, procs[0].returncode), (['TERM', 'KILL'], -signal.SIGKILL))

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

    def test_a_file_given_as_stdin_reaches_the_child_whole(self):
        """e2e review S1: publish hands root the ZIP as stdin, opened by the operator."""
        path = os.path.join(self.tmp(), 'in')
        data = bytes(range(256)) * 4096
        with open(path, 'wb') as f:
            f.write(data)
        with open(path, 'rb') as f:
            r = bounded.run(py('import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'),
                            timeout=30, stdin=f, text=True)
        self.assertEqual(r.stdout, hashlib.sha256(data).hexdigest() + '\n')

    def test_without_stdin_the_child_reads_nothing(self):
        r = bounded.run(py('import sys; print(repr(sys.stdin.read()))'), timeout=30, text=True)
        self.assertEqual(r.stdout, "''\n")

    def test_a_timeout_with_a_file_on_stdin_still_sends_sigterm_first(self):
        path = os.path.join(self.tmp(), 'in')
        with open(path, 'wb') as f:
            f.write(b'zip')
        Recording, sent, procs = self.recording_popen()
        with open(path, 'rb') as f, mock.patch.object(bounded.subprocess, 'Popen', Recording), \
                self.assertRaises(subprocess.TimeoutExpired):
            bounded.run(py('import sys, time; sys.stdin.read(); time.sleep(60)'), timeout=2, term_grace=5, stdin=f)
        self.assertEqual((sent, procs[0].returncode), (['TERM'], -signal.SIGTERM))

    def test_environment_and_directory_are_passed(self):
        r = bounded.run(py('import os; print(os.environ["X"], os.getcwd())'), timeout=30, text=True,
                        env={'X': 'y'}, cwd='/')
        self.assertEqual(r.stdout, 'y /\n')


if __name__ == '__main__':
    unittest.main()
