"""subprocess.run with a ceiling on what is kept from stdout and stderr, and on how long it waits.

A copy of deploy/release/bounded.py for the root helper wbb-image (plus a lock between the reader thread and
value(), #858 AI review: a descendant still writing after the join grace mutated the deque under value()): deploy/release/ is removed in
stage «в» of the image transition (plan 2026-10-12-wbb-image-transition-core, "Рішення" п.5), so the helper
imports nothing from there.

#817 AI review: the sandbox's stdout is the candidate's to write, and npm's report is
the registry's; capture_output keeps all of it in the (root) helper's memory before any
size check can run. This reads both pipes as they fill and keeps at most `cap` bytes from
the head of each plus `tail` bytes from its end — systemd-run's "Finished with result:"
footer and the probe's result line come last, so a flood must not push them out. The
rest is discarded, so the child is never blocked on a full pipe.

Pipes can outlive the child: with systemd-run --pipe the unit's own processes hold them.
Readers are daemon threads joined with a grace period, never forever, and the child is
stopped on any exception before the exception propagates. A timeout stops it with SIGTERM
first and SIGKILL only after TERM_GRACE_S (plan periphery-b2 "Рішення" п.6): the child is
often `sudo`, which relays SIGTERM to the root process it started but cannot relay SIGKILL,
so a bare kill would leave that process running as an orphan. Any other exception (Ctrl-C,
which the terminal already delivers to the whole process group) kills at once.
A CompletedProcess comes back as from subprocess.run, with `truncated` set when anything
was dropped.
"""
import collections
import subprocess
import threading

DEFAULT_CAP = 1024 * 1024
DEFAULT_TAIL = 64 * 1024
JOIN_GRACE_S = 5
# After a timeout's SIGTERM, how long the child has to exit before SIGKILL.
TERM_GRACE_S = 10
MARK = b'\n[... output truncated ...]\n'


class _Drain:
    def __init__(self, pipe, cap, tail):
        self.pipe, self.cap, self.tail = pipe, cap, tail
        self.head = bytearray()
        self.end = collections.deque()
        self.end_len = 0
        self.dropped = False
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        try:
            while True:
                # read1, not read: read(n) waits for n bytes or EOF, and EOF may never come
                # while a descendant holds the pipe — what already arrived must still count.
                chunk = self.pipe.read1(64 * 1024)
                if not chunk:
                    break
                with self.lock:
                    self._keep(chunk)
        except (OSError, ValueError):
            # A read that failed part-way leaves the capture incomplete: say so (#817 AI review).
            with self.lock:
                self.dropped = True

        finally:
            # EOF may arrive after run's join grace: the reader owns the pipe until then (#841).
            try:
                self.pipe.close()
            except (OSError, ValueError):
                with self.lock:
                    self.dropped = True

    def _keep(self, chunk):
        room = self.cap - len(self.head)
        if room > 0:
            self.head += chunk[:room]
            chunk = chunk[room:]
        if chunk:
            self.end.append(chunk)
            self.end_len += len(chunk)
            while self.end_len - len(self.end[0]) >= self.tail:
                self.end_len -= len(self.end.popleft())
                self.dropped = True

    def value(self):
        # The reader may still be running (a descendant holds the pipe past the join grace): read under its lock.
        with self.lock:
            end = b''.join(self.end)
            if len(end) > self.tail:
                end = end[-self.tail:]
                self.dropped = True
            return bytes(self.head) + (MARK + end if self.dropped else end)


def _terminate(proc, term_grace):
    """SIGTERM, up to term_grace seconds for the child to exit, then SIGKILL; reaped either way."""
    try:
        proc.terminate()
        proc.wait(timeout=term_grace)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # Also when something interrupted the grace (Ctrl-C): the child never outlives the call.
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def run(argv, *, timeout, cap=DEFAULT_CAP, tail=DEFAULT_TAIL, cwd=None, env=None, stdin=subprocess.DEVNULL,
        text=False, check=False, capture_output=True, join_grace=JOIN_GRACE_S, term_grace=TERM_GRACE_S):
    """Like subprocess.run(argv, capture_output=True, ...) with bounded capture and bounded waiting."""
    del capture_output  # always captured; accepted so callers can pass subprocess.run's keywords
    if not (isinstance(cap, int) and cap >= 0 and isinstance(tail, int) and tail >= 1):
        raise ValueError(f'cap must be >= 0 and tail >= 1, got cap={cap!r} tail={tail!r}')
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=stdin, cwd=cwd, env=env)
    drains = [_Drain(proc.stdout, cap, tail), _Drain(proc.stderr, cap, tail)]
    for d in drains:
        d.thread.start()
    try:
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _terminate(proc, term_grace)
            raise
        except BaseException:
            proc.kill()
            proc.wait()
            raise
    except BaseException:
        for d in drains:
            d.thread.join(join_grace)
        raise
    for d in drains:
        # A descendant may still hold the pipe open; do not wait for it beyond the grace.
        d.thread.join(join_grace)
    # Whether a reader is still running is taken BEFORE the snapshot (#858 AI review): one that reads a last chunk
    # and exits between value() and the check would otherwise leave that chunk out with truncated False.
    still_reading = any(d.thread.is_alive() for d in drains)
    stdout, stderr = drains[0].value(), drains[1].value()
    truncated = drains[0].dropped or drains[1].dropped or still_reading
    if text:
        stdout, stderr = stdout.decode('utf-8', 'replace'), stderr.decode('utf-8', 'replace')
    result = subprocess.CompletedProcess(argv, proc.returncode, stdout, stderr)
    result.truncated = truncated
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, argv, stdout, stderr)
    return result
