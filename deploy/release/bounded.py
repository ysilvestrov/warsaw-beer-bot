"""subprocess.run with a ceiling on what is kept from stdout and stderr.

#817 AI review: the sandbox's stdout is the candidate's to write, and npm's report is
the registry's; capture_output keeps all of it in the (root) helper's memory before any
size check can run. This reads both pipes as they fill and keeps at most `cap` bytes of
each, discarding the rest — the child is never blocked on a full pipe, and the helper's
memory stays bounded whatever the child prints. A CompletedProcess comes back as from
subprocess.run, with `truncated` set when anything was dropped.
"""
import subprocess
import threading

DEFAULT_CAP = 1024 * 1024


def _drain(pipe, cap, sink):
    kept = bytearray()
    dropped = False
    while True:
        chunk = pipe.read(64 * 1024)
        if not chunk:
            break
        room = cap - len(kept)
        if room > 0:
            kept += chunk[:room]
        if len(chunk) > room:
            dropped = True
    pipe.close()
    sink.append((bytes(kept), dropped))


def run(argv, *, timeout, cap=DEFAULT_CAP, cwd=None, env=None, stdin=subprocess.DEVNULL, text=False, check=False,
        capture_output=True):
    """Like subprocess.run(argv, capture_output=True, ...) but with bounded capture. Kills the child on timeout."""
    del capture_output  # always captured; accepted so callers can pass subprocess.run's keywords
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=stdin, cwd=cwd, env=env)
    out, err = [], []
    readers = [threading.Thread(target=_drain, args=(proc.stdout, cap, out), daemon=True),
               threading.Thread(target=_drain, args=(proc.stderr, cap, err), daemon=True)]
    for t in readers:
        t.start()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        for t in readers:
            t.join()
        raise
    for t in readers:
        t.join()
    (stdout, out_dropped), (stderr, err_dropped) = out[0], err[0]
    if text:
        stdout, stderr = stdout.decode('utf-8', 'replace'), stderr.decode('utf-8', 'replace')
    result = subprocess.CompletedProcess(argv, proc.returncode, stdout, stderr)
    result.truncated = out_dropped or err_dropped
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, argv, stdout, stderr)
    return result
