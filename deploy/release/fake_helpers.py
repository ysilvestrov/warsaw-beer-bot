"""A scripted helpers.Helpers for the tick's tests (not a test module).

Plan: docs/superpowers/plans/2026-10/2026-10-10-wbb-artifact-deployment-2c-periphery-a.md, Tasks 2-3.

Every call is appended to `calls` as (method, *args) before it is answered. An answer is set per method
name in `answers`: a value is returned, an exception instance is raised, a callable is called with the
call's arguments and its result treated the same way (so one method can answer per SHA). A method with
no answer raises AssertionError: a test states every call it expects to happen.
"""


class FakeHelpers:
    def __init__(self, **answers):
        self.answers = dict(answers)
        self.calls = []

    def _answer(self, name, *args):
        self.calls.append((name, *args))
        if name not in self.answers:
            raise AssertionError(f'unexpected helper call {name}{args}')
        a = self.answers[name]
        if callable(a) and not isinstance(a, type):
            a = a(*args)
        if isinstance(a, BaseException):
            raise a
        return a

    def names(self):
        """The methods called, in order."""
        return [c[0] for c in self.calls]

    def fetch_main(self):
        return self._answer('fetch_main')

    def is_ancestor(self, a, b):
        return self._answer('is_ancestor', a, b)

    def changed_paths(self, a, b):
        return self._answer('changed_paths', a, b)

    def commits(self, a, b):
        return self._answer('commits', a, b)

    def pr_labels(self, sha):
        return self._answer('pr_labels', sha)

    def trusted(self, sha):
        return self._answer('trusted', sha)

    def download(self, sha, trusted):
        return self._answer('download', sha, trusted)

    def publish(self, sha, zip_path):
        return self._answer('publish', sha, zip_path)

    def verify(self, sha):
        return self._answer('verify', sha)

    def audit(self, sha):
        return self._answer('audit', sha)

    def probe(self, sha):
        return self._answer('probe', sha)

    def trial(self, sha, pre_name):
        return self._answer('trial', sha, pre_name)

    def manifest(self, sha):
        return self._answer('manifest', sha)

    def snapshot_pre(self, sha):
        return self._answer('snapshot_pre', sha)

    def discard_pre(self, pre):
        return self._answer('discard_pre', pre)

    def installed_stale(self, patterns):
        return self._answer('installed_stale', patterns)
