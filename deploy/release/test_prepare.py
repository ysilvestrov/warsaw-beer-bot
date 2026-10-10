import hashlib
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prepare as pp  # noqa: E402
import tree_manifest as tm  # noqa: E402
from deploy_state import Pre, Release, Settled  # noqa: E402
from fake_helpers import FakeHelpers  # noqa: E402
from helpers import HelperError, Run  # noqa: E402
from prepare import Noop, Prepared, Transient, Verdict  # noqa: E402

CAND = 'c' * 40
BASE = 'b' * 40
TRUSTED = object()
ZIP = '/home/ysi/.cache/wbb/ccccccc.zip'
PRE = Pre('/var/lib/warsaw-beer-bot/deploy-snapshots/20261010T120000Z-ccccccc-pre.db', '4' * 64, 1760000000)
PRE_NAME = '20261010T120000Z-ccccccc-pre.db'


def entries(release='a', index='1', mode=0o644, extra=(), drop=()):
    """A payload: a dir, its file, package.json and release.json (digests by one hex character)."""
    es = [
        {'path': 'dist', 'type': 'dir', 'mode': 0o755},
        {'path': 'dist/index.js', 'type': 'file', 'mode': mode, 'size': 10, 'sha256': index * 64},
        {'path': 'package.json', 'type': 'file', 'mode': 0o644, 'size': 5, 'sha256': '3' * 64},
        {'path': 'release.json', 'type': 'file', 'mode': 0o644, 'size': 200, 'sha256': release * 64},
        *extra,
    ]
    return [e for e in es if e['path'] not in drop]


def manifest(es):
    return tm.canonical_bytes({'formatVersion': 1, 'entries': sorted(es, key=lambda e: e['path'].encode())})


BASE_MANIFEST = manifest(entries(release='e'))
CAND_MANIFEST = manifest(entries(release='a', index='2'))
BASE_TREE = hashlib.sha256(BASE_MANIFEST).hexdigest()
CAND_TREE = hashlib.sha256(CAND_MANIFEST).hexdigest()
SETTLED = Settled(BASE, BASE_TREE, 1759990000)
PREPARED = Prepared(Release(CAND, CAND_TREE), PRE)

# Every call of a candidate that goes all the way, in order: the audit before the first execution.
FULL = [('download', CAND, TRUSTED), ('publish', CAND, ZIP), ('verify', CAND), ('verify', BASE),
        ('manifest', CAND), ('manifest', BASE), ('audit', CAND), ('probe', CAND), ('snapshot_pre', CAND),
        ('trial', CAND, PRE_NAME)]
UP_TO_AUDIT = [c[0] for c in FULL[:7]]
UP_TO_PROBE = [c[0] for c in FULL[:8]]
UP_TO_TRIAL = [c[0] for c in FULL]


def helpers(cand_manifest=CAND_MANIFEST, **answers):
    manifests = {CAND: cand_manifest, BASE: BASE_MANIFEST}
    trees = {CAND: hashlib.sha256(cand_manifest).hexdigest(), BASE: BASE_TREE}
    defaults = dict(
        download=ZIP,
        publish=Run(0, 'ACCEPTED', f'ACCEPTED {CAND}: run 7 attempt 1, artifact 9'),
        verify=lambda sha: Run(0, 'VERIFIED', f'VERIFIED {sha}: tree {trees[sha]}', trees[sha]),
        manifest=lambda sha: manifests[sha],
        audit=Run(0, 'CLEAN', 'AUDIT CLEAN', trees[CAND]),
        probe=Run(0, 'OK', 'PROBE OK'),
        snapshot_pre=PRE,
        trial=Run(0, 'OK', 'TRIAL OK'),
        discard_pre=None,
    )
    return FakeHelpers(**{**defaults, **answers})


def run(h):
    return pp.prepare(h, CAND, TRUSTED, SETTLED)


class Ready(unittest.TestCase):
    def test_a_good_candidate_is_prepared_with_the_audit_before_any_execution(self):
        h = helpers()
        self.assertEqual(run(h), PREPARED)
        self.assertEqual(h.calls, FULL)

    def test_an_already_published_release_goes_on(self):
        h = helpers(publish=Run(0, 'ALREADY-ACCEPTED', ''))
        self.assertEqual(run(h), PREPARED)


class NothingShips(unittest.TestCase):
    def test_only_release_json_differs_is_a_noop_that_runs_nothing_of_the_candidate(self):
        same = manifest(entries(release='a'))
        h = helpers(cand_manifest=same)
        self.assertEqual(run(h), Noop(CAND, hashlib.sha256(same).hexdigest()))
        self.assertEqual(h.calls, FULL[:6])

    def test_any_runtime_difference_is_a_release(self):
        cases = {
            'content': entries(index='2'),
            'mode': entries(mode=0o755),
            'added file': entries(extra=({'path': 'dist/new.js', 'type': 'file', 'mode': 0o644, 'size': 1,
                                          'sha256': '5' * 64},)),
            'removed file': entries(drop=('package.json',)),
        }
        for name, es in cases.items():
            with self.subTest(name):
                data = manifest(es)
                h = helpers(cand_manifest=data, audit=Run(0, 'CLEAN', '', hashlib.sha256(data).hexdigest()))
                self.assertEqual(run(h), Prepared(Release(CAND, hashlib.sha256(data).hexdigest()), PRE))
                self.assertEqual(h.names(), UP_TO_TRIAL)


class BeforeTheCandidateRuns(unittest.TestCase):
    """download, publish, verify, manifests: any failure is Transient and nothing of the candidate runs."""

    def check(self, answers, expected, names):
        h = helpers(**answers)
        self.assertEqual(run(h), expected)
        self.assertEqual(h.names(), names)

    def test_download(self):
        self.check(dict(download=HelperError('HTTP 410: artifact expired')),
                   Transient('download', 'HelperError: HTTP 410: artifact expired'), ['download'])

    def test_publish(self):
        cases = (
            (Run(2, None, 'REFUSED: digest mismatch'), 'exit 2, no verdict line: REFUSED: digest mismatch'),
            (Run(70, None, ''), 'exit 70, no verdict line'),
            (Run(1, 'ACCEPTED', 'odd'), 'exit 1, ACCEPTED: odd'),
            (OSError('sudo: a password is required'), 'OSError: sudo: a password is required'),
        )
        for answer, reason in cases:
            with self.subTest(reason):
                self.check(dict(publish=answer), Transient('publish', reason), ['download', 'publish'])

    def test_verify_of_the_candidate(self):
        cases = (
            (Run(2, None, 'REFUSED: release tree changed'), 'exit 2, no verdict line: REFUSED: release tree changed'),
            (Run(0, 'VERIFIED', 'VERIFIED', None), f'{CAND[:7]} verified without a tree digest'),
            (HelperError('timeout'), 'HelperError: timeout'),
        )
        for answer, reason in cases:
            with self.subTest(reason):
                self.check(dict(verify=answer), Transient('verify', reason), ['download', 'publish', 'verify'])

    def test_settled_that_verifies_as_another_tree(self):
        def verify(sha):
            return Run(0, 'VERIFIED', '', {CAND: CAND_TREE, BASE: '9' * 64}[sha])

        self.check(dict(verify=verify),
                   Transient('verify', f'settled bbbbbbb verifies as tree {"9" * 64}, recorded {BASE_TREE}'),
                   ['download', 'publish', 'verify', 'verify'])

    def test_manifest_that_is_not_the_verified_tree(self):
        def manifest_of(sha):
            return {CAND: CAND_MANIFEST + b' ', BASE: BASE_MANIFEST}[sha]

        self.check(dict(manifest=manifest_of),
                   Transient('manifest', f'the manifest of ccccccc is not its verified tree {CAND_TREE}'),
                   UP_TO_AUDIT[:5])

    def test_manifest_that_does_not_parse(self):
        pretty = b'{"entries": [], "formatVersion": 1}'
        self.check(dict(cand_manifest=pretty),
                   Transient('manifest', 'the manifest of ccccccc: manifest bytes are not canonical'),
                   UP_TO_AUDIT[:5])

    def test_manifest_read_failure(self):
        self.check(dict(manifest=PermissionError('denied')), Transient('manifest', 'PermissionError: denied'),
                   UP_TO_AUDIT[:5])


class Audit(unittest.TestCase):
    def test_answers(self):
        cases = (
            (Run(1, 'ADVISORY', 'AUDIT ADVISORY\nlodash high', CAND_TREE),
             Verdict('audit', 'ADVISORY', 'AUDIT ADVISORY\nlodash high')),
            (Run(75, 'UNRUNNABLE', 'no report', CAND_TREE), Transient('audit', 'exit 75, UNRUNNABLE: no report')),
            (Run(1, None, 'Traceback'), Transient('audit', 'exit 1, no verdict line: Traceback')),
            (Run(0, 'ADVISORY', 'x', CAND_TREE), Transient('audit', 'exit 0, ADVISORY: x')),
            (Run(1, 'CLEAN', 'x', CAND_TREE), Transient('audit', 'exit 1, CLEAN: x')),
            (Run(2, None, 'REFUSED'), Transient('audit', 'exit 2, no verdict line: REFUSED')),
            (Run(70, None, ''), Transient('audit', 'exit 70, no verdict line')),
            (HelperError('npm missing'), Transient('audit', 'HelperError: npm missing')),
        )
        for answer, expected in cases:
            with self.subTest(expected):
                h = helpers(audit=answer)
                self.assertEqual(run(h), expected)
                self.assertEqual(h.names(), UP_TO_AUDIT)

    def test_a_tree_that_changed_since_verify_is_never_a_verdict(self):
        for kind, code in (('CLEAN', 0), ('ADVISORY', 1)):
            with self.subTest(kind):
                h = helpers(audit=Run(code, kind, '', '7' * 64))
                self.assertEqual(run(h), Transient(
                    'audit', f'the tree changed between steps: verified {CAND_TREE}, audited {"7" * 64}'))
                self.assertEqual(h.names(), UP_TO_AUDIT)


class Probe(unittest.TestCase):
    def test_answers(self):
        cases = (
            (Run(1, 'FAILED', 'PROBE FAILED: better-sqlite3'), Verdict('probe', 'FAILED', 'PROBE FAILED: better-sqlite3')),
            (Run(75, 'TRANSIENT', 'no wbb-trial'), Transient('probe', 'exit 75, TRANSIENT: no wbb-trial')),
            (Run(1, None, ''), Transient('probe', 'exit 1, no verdict line')),
            (Run(0, 'FAILED', ''), Transient('probe', 'exit 0, FAILED')),
            (Run(2, None, 'REFUSED'), Transient('probe', 'exit 2, no verdict line: REFUSED')),
            (Run(70, None, 'Traceback'), Transient('probe', 'exit 70, no verdict line: Traceback')),
            (HelperError('sudo'), Transient('probe', 'HelperError: sudo')),
        )
        for answer, expected in cases:
            with self.subTest(expected):
                h = helpers(probe=answer)
                self.assertEqual(run(h), expected)
                self.assertEqual(h.names(), UP_TO_PROBE)


class SnapshotAndTrial(unittest.TestCase):
    def test_a_failed_snapshot_is_transient_with_nothing_to_discard(self):
        h = helpers(snapshot_pre=HelperError('disk full'))
        self.assertEqual(run(h), Transient('snapshot', 'HelperError: disk full'))
        self.assertEqual(h.names(), UP_TO_PROBE + ['snapshot_pre'])

    def test_every_trial_that_did_not_pass_discards_the_pre(self):
        cases = (
            (Run(1, 'FAILED', 'TRIAL FAILED: integrity'), Verdict('trial', 'FAILED', 'TRIAL FAILED: integrity')),
            (Run(75, 'TRANSIENT', 'busy'), Transient('trial', 'exit 75, TRANSIENT: busy')),
            (Run(1, None, ''), Transient('trial', 'exit 1, no verdict line')),
            (Run(2, None, 'REFUSED: bad name'), Transient('trial', 'exit 2, no verdict line: REFUSED: bad name')),
            (Run(70, None, ''), Transient('trial', 'exit 70, no verdict line')),
            (HelperError('sudo'), Transient('trial', 'HelperError: sudo')),
        )
        for answer, expected in cases:
            with self.subTest(expected):
                h = helpers(trial=answer)
                self.assertEqual(run(h), expected)
                self.assertEqual(h.calls, FULL + [('discard_pre', PRE)])

    def test_a_discard_that_fails_is_noted_and_does_not_change_the_result(self):
        h = helpers(trial=Run(1, 'FAILED', 'TRIAL FAILED'), discard_pre=HelperError('busy'))
        self.assertEqual(run(h), Verdict('trial', 'FAILED', 'TRIAL FAILED',
                                         f'could not discard {PRE.path}: HelperError: busy'))


class Fake(unittest.TestCase):
    def test_an_unscripted_call_fails_the_test(self):
        with self.assertRaisesRegex(AssertionError, r"unexpected helper call fetch_main\(\)"):
            FakeHelpers().fetch_main()


if __name__ == '__main__':
    unittest.main()
