import os
import subprocess
import sys
import unittest

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
                        timeout=60, cap=1000)
        self.assertEqual((r.returncode, r.stdout, r.stderr, r.truncated), (0, b'x' * 1000, b'y' * 1000, True))

    def test_exactly_the_cap_is_not_truncated(self):
        r = bounded.run(py('import sys; sys.stdout.write("x" * 1000)'), timeout=30, cap=1000)
        self.assertEqual((len(r.stdout), r.truncated), (1000, False))

    def test_timeout_kills_the_child(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            bounded.run(py('import time; time.sleep(60)'), timeout=1)

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
