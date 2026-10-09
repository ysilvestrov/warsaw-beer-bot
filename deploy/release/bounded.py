"""subprocess.run with a ceiling on what is kept from stdout and stderr, and on how long it waits.

#817 AI review: the sandbox's stdout is the candidate's to write, and npm's report is
the registry's; capture_output keeps all of it in the (root) helper's memory before any
size check can run. This reads both pipes as they fill and keeps at most `cap` bytes from
the head of each plus `tail` bytes from its end — systemd-run's "Finished with result:"
footer and the probe's result line come last, so a flood must not push them out. The
rest is discarded, so the child is never blocked on a full pipe.

Pipes can outlive the child: with systemd-run --pipe the unit's own processes hold them.
Readers are daemon threads joined with a grace period, never forever, and the child is
killed on any exception (a timeout, Ctrl-C) before the exception propagates.
A CompletedProcess comes back as from subprocess.run, with `truncated` set when anything
was dropped.
"""
import collections
import subprocess
import threading

DEFAULT_CAP = 1024 * 1024
DEFAULT_TAIL = 64 * 1024
JOIN_GRACE_S = 5
MARK = b'\n[... output truncated ...]\n'


class _Drain:
    def __init__(self, pipe, cap, tail):
        self.pipe, self.cap, self.tail = pipe, cap, tail
        self.head = bytearray()
        self.end = collections.deque()
        self.end_len = 0
        self.dropped = False
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        try:
            while True:
                # read1, not read: read(n) waits for n bytes or EOF, and EOF may never come
                # while a descendant holds the pipe — what already arrived must still count.
                chunk = self.pipe.read1(64 * 1024)
                if not chunk:
                    break
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
        except (OSError, ValueError):
            pass

    def value(self):
        end = b''.join(self.end)
        if len(end) > self.tail:
            end = end[-self.tail:]
            self.dropped = True
        return bytes(self.head) + (MARK + end if self.dropped else end)


def run(argv, *, timeout, cap=DEFAULT_CAP, tail=DEFAULT_TAIL, cwd=None, env=None, stdin=subprocess.DEVNULL,
        text=False, check=False, capture_output=True, join_grace=JOIN_GRACE_S):
    """Like subprocess.run(argv, capture_output=True, ...) with bounded capture and bounded waiting."""
    del capture_output  # always captured; accepted so callers can pass subprocess.run's keywords
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=stdin, cwd=cwd, env=env)
    drains = [_Drain(proc.stdout, cap, tail), _Drain(proc.stderr, cap, tail)]
    for d in drains:
        d.thread.start()
    try:
        proc.wait(timeout=timeout)
    except BaseException:
        proc.kill()
        proc.wait()
        for d in drains:
            d.thread.join(join_grace)
        raise
    for d in drains:
        # A descendant may still hold the pipe open; do not wait for it beyond the grace.
        d.thread.join(join_grace)
    stdout, stderr = drains[0].value(), drains[1].value()
    truncated = drains[0].dropped or drains[1].dropped or any(d.thread.is_alive() for d in drains)
    if text:
        stdout, stderr = stdout.decode('utf-8', 'replace'), stderr.decode('utf-8', 'replace')
    result = subprocess.CompletedProcess(argv, proc.returncode, stdout, stderr)
    result.truncated = truncated
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, argv, stdout, stderr)
    return result
