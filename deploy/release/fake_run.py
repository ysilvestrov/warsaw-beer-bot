"""A scripted `run` and a local HTTP server for the adapters' tests (not a test module).

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-b-core.md, Global Constraints.

FakeRun stands in for bounded.run: every call is recorded as (argv, timeout) and answered from `answers`, keyed
by the exact argv tuple — a test states every command it expects, word for word, and any other argv fails it.
An answer is (code, stdout, stderr), an exception instance (raised), or a list of those (one per call, in order).

Server is an HTTP server on 127.0.0.1 with a scripted answer per request: (status, body, delay seconds[, headers]).
"""
import http.server
import subprocess
import threading


def done(code=0, out=b'', err=b''):
    return code, out, err


class FakeRun:
    def __init__(self, answers=None):
        self.answers = dict(answers or {})
        self.calls = []

    def __call__(self, argv, *, timeout, **kwargs):
        argv = list(argv)
        self.calls.append((argv, timeout))
        key = tuple(argv)
        if key not in self.answers:
            raise AssertionError(f'unexpected command {argv}')
        a = self.answers[key]
        if isinstance(a, list):
            a = a.pop(0)
        if isinstance(a, BaseException):
            raise a
        code, out, err = a
        return subprocess.CompletedProcess(argv, code, out, err)

    def argvs(self):
        return [argv for argv, _ in self.calls]


class Server:
    """`with Server([(200, b'{}', 0)]) as s:` — s.url, s.requests [(method, path, body)]."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.requests = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _answer(self):
                n = int(self.headers.get('Content-Length') or 0)
                outer.requests.append((self.command, self.path, self.rfile.read(n)))
                status, body, delay, *headers = outer.answers.pop(0)
                if delay:
                    threading.Event().wait(delay)
                try:
                    self.send_response(status)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(body)))
                    for name, value in (headers[0] if headers else {}).items():
                        self.send_header(name, value)
                    self.end_headers()
                    self.wfile.write(body)
                except OSError:
                    pass  # the client gave up (a timeout test)

            do_GET = _answer
            do_POST = _answer

            def log_message(self, *args):
                pass

        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.url = f'http://127.0.0.1:{self.port}'

    def __enter__(self):
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(5)
