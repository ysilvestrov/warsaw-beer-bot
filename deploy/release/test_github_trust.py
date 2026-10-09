import copy
import email.message
import io
import os
import sys
import unittest
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import github_trust as gt  # noqa: E402

REPO = 'ysilvestrov/warsaw-beer-bot'
SHA = 'e58da52c0e62d17929d3f199f36462cc0c4ba0bc'
DIGEST = '906bc06a1b321a39df234cf1c619842bc983387270da4dafe9ed465b931e0741'
RUN = 37901278240
NAME = f'wbb-release-{SHA}-{RUN}-2'


def run(**over):
    r = {'id': RUN, 'run_attempt': 2, 'path': '.github/workflows/ci.yml', 'event': 'push', 'head_branch': 'main',
         'head_sha': SHA, 'status': 'completed', 'conclusion': 'success',
         'repository': {'full_name': REPO}, 'head_repository': {'full_name': REPO}}
    r.update(over)
    return r


def job(name, conclusion='success', attempt=2, run_id=RUN):
    return {'name': name, 'run_id': run_id, 'run_attempt': attempt, 'status': 'completed', 'conclusion': conclusion}


def artifact(**over):
    a = {'id': 11602159138, 'name': NAME, 'expired': False, 'digest': f'sha256:{DIGEST}',
         'workflow_run': {'id': RUN, 'head_sha': SHA}}
    a.update(over)
    return a


def listing(key, items):
    return {'total_count': len(items), key: items}


GOOD = {
    'runs': listing('workflow_runs', [run()]),
    'jobs': listing('jobs', [job('build (root)'), job('build (extension)'), job('package'), job('ci')]),
    'artifacts': listing('artifacts', [artifact()]),
}


def fake_api(data):
    calls = []

    def api(path):
        calls.append(path)
        if '/workflows/ci.yml/runs?' in path:
            return data['runs']
        if path.startswith(f'/repos/{REPO}/actions/runs/{RUN}/attempts/2/jobs'):
            return data['jobs']
        if path.startswith(f'/repos/{REPO}/actions/runs/{RUN}/artifacts'):
            return data['artifacts']
        raise AssertionError(f'unexpected path {path}')
    api.calls = calls
    return api


def with_(**changes):
    d = copy.deepcopy(GOOD)
    d.update(changes)
    return d


class FetchTrusted(unittest.TestCase):
    def refused(self, data):
        with self.assertRaises(gt.Untrusted) as cm:
            gt.fetch_trusted(fake_api(data), REPO, SHA)
        return str(cm.exception)

    def test_trusted_identity(self):
        self.assertEqual(gt.fetch_trusted(fake_api(GOOD), REPO, SHA), gt.Trusted(
            REPO, SHA, '.github/workflows/ci.yml', RUN, 2, 11602159138, NAME, DIGEST))

    def test_queries_are_run_scoped(self):
        api = fake_api(GOOD)
        gt.fetch_trusted(api, REPO, SHA)
        self.assertEqual(api.calls, [
            f'/repos/{REPO}/actions/workflows/ci.yml/runs?head_sha={SHA}&event=push&branch=main&status=completed&per_page=100',
            f'/repos/{REPO}/actions/runs/{RUN}/attempts/2/jobs?per_page=100',
            f'/repos/{REPO}/actions/runs/{RUN}/artifacts?per_page=100'])

    def test_short_sha(self):
        with self.assertRaisesRegex(gt.Untrusted, "not a full lowercase SHA: 'e58da52'"):
            gt.fetch_trusted(fake_api(GOOD), REPO, 'e58da52')

    def test_fork_pull_request_run(self):
        fork = run(event='pull_request', head_branch='feature', head_repository={'full_name': 'evil/fork'})
        self.assertEqual(self.refused(with_(runs=listing('workflow_runs', [fork]))),
                         f"no trusted CI run for {SHA} (run {RUN}: event='pull_request', head_branch='feature', "
                         "head_repository.full_name='evil/fork')")

    def test_other_workflow_path(self):
        self.assertEqual(self.refused(with_(runs=listing('workflow_runs', [run(path='.github/workflows/evil.yml')]))),
                         f"no trusted CI run for {SHA} (run {RUN}: path='.github/workflows/evil.yml')")

    def test_failed_run(self):
        self.assertEqual(self.refused(with_(runs=listing('workflow_runs', [run(conclusion='failure')]))),
                         f"no trusted CI run for {SHA} (run {RUN}: conclusion='failure')")

    def test_no_runs(self):
        self.assertEqual(self.refused(with_(runs=listing('workflow_runs', []))), f'no trusted CI run for {SHA}')

    def test_two_trusted_runs_are_ambiguous(self):
        runs = listing('workflow_runs', [run(), run(id=RUN + 1)])
        self.assertEqual(self.refused(with_(runs=runs)),
                         f'2 trusted CI runs for {SHA}: [{RUN}, {RUN + 1}]; refusing to choose')

    def test_partial_listing(self):
        self.assertEqual(self.refused(with_(runs={'total_count': 2, 'workflow_runs': [run()]})),
                         'workflow_runs listing shows 1 of 2; refusing to decide on a partial list')

    def test_attempt_as_bool_is_not_an_int(self):
        self.assertEqual(self.refused(with_(runs=listing('workflow_runs', [run(run_attempt=True)]))),
                         f'no trusted CI run for {SHA} (run {RUN}: run_attempt=True)')

    def test_package_skipped(self):
        jobs = listing('jobs', [job('package', 'skipped'), job('ci')])
        self.assertEqual(self.refused(with_(jobs=jobs)), f"run {RUN} attempt 2: 'package' is completed/skipped")

    def test_ci_failed_in_this_attempt(self):
        jobs = listing('jobs', [job('package'), job('ci', 'failure')])
        self.assertEqual(self.refused(with_(jobs=jobs)), f"run {RUN} attempt 2: 'ci' is completed/failure")

    def test_job_from_an_older_attempt(self):
        jobs = listing('jobs', [job('package', attempt=1), job('ci')])
        self.assertEqual(self.refused(with_(jobs=jobs)),
                         f"run {RUN} attempt 2: 'package' job belongs to run {RUN} attempt 1")

    def test_package_job_missing(self):
        self.assertEqual(self.refused(with_(jobs=listing('jobs', [job('ci')]))),
                         f"run {RUN} attempt 2: expected one 'package' job, found 0")

    def test_artifact_of_another_attempt(self):
        arts = listing('artifacts', [artifact(name=f'wbb-release-{SHA}-{RUN}-1')])
        self.assertEqual(self.refused(with_(artifacts=arts)), f'run {RUN}: expected one artifact {NAME}, found 0')

    def test_expired_artifact(self):
        self.assertEqual(self.refused(with_(artifacts=listing('artifacts', [artifact(expired=True)]))),
                         f'{NAME}: expired or expiry unknown — re-run the main CI workflow for {SHA} or push a new commit')

    def test_artifact_under_another_run(self):
        arts = listing('artifacts', [artifact(workflow_run={'id': 1, 'head_sha': SHA})])
        self.assertEqual(self.refused(with_(artifacts=arts)), f'{NAME}: listed under a different run or SHA')

    def test_missing_digest(self):
        self.assertEqual(self.refused(with_(artifacts=listing('artifacts', [artifact(digest=None)]))),
                         f'{NAME}: no valid sha256 digest (None); operator recovery required')

    def test_non_hex_digest(self):
        bad = 'sha256:' + 'Z' * 64
        self.assertEqual(self.refused(with_(artifacts=listing('artifacts', [artifact(digest=bad)]))),
                         f"{NAME}: no valid sha256 digest ({bad!r}); operator recovery required")


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def redirect(url, code=302):
    headers = email.message.Message()
    headers['Location'] = url
    return urllib.error.HTTPError('https://api.github.com/x', code, 'Found', headers, None)


class Transport(unittest.TestCase):
    def opener(self, *answers):
        seen = []

        def urlopen(req, timeout):
            seen.append(req)
            answer = answers[len(seen) - 1]
            if isinstance(answer, Exception):
                raise answer
            return Response(answer)
        return seen, urlopen

    def test_json_call_sends_the_token_to_the_api(self):
        seen, urlopen = self.opener(b'{"a": 1}')
        self.assertEqual(gt.GitHubApi('tok', urlopen)('/x'), {'a': 1})
        self.assertEqual((seen[0].full_url, seen[0].get_header('Authorization')), ('https://api.github.com/x', 'Bearer tok'))

    def test_http_error_names_the_path_without_the_query(self):
        _, urlopen = self.opener(urllib.error.HTTPError('u', 404, 'nf', email.message.Message(), None))
        with self.assertRaisesRegex(gt.Untrusted, '^GitHub API 404 for /x$'):
            gt.GitHubApi('tok', urlopen)('/x?secret=1')

    def test_oversized_json(self):
        _, urlopen = self.opener(b'1' * (gt.MAX_JSON_BYTES + 1))
        with self.assertRaisesRegex(gt.Untrusted, 'response over'):
            gt.GitHubApi('tok', urlopen)('/x')

    def test_non_object_json(self):
        _, urlopen = self.opener(b'[1]')
        with self.assertRaisesRegex(gt.Untrusted, 'non-object'):
            gt.GitHubApi('tok', urlopen)('/x')

    def test_download_drops_credentials_at_the_redirect(self):
        signed = 'https://store.example/blob?sig=SECRET'
        seen, urlopen = self.opener(redirect(signed), b'zipbytes')
        out = io.BytesIO()
        self.assertEqual(gt.GitHubApi('tok', urlopen).download(REPO, 5, out, 100), 8)
        self.assertEqual(out.getvalue(), b'zipbytes')
        self.assertEqual([(r.full_url, r.get_header('Authorization')) for r in seen], [
            (f'https://api.github.com/repos/{REPO}/actions/artifacts/5/zip', 'Bearer tok'), (signed, None)])

    def test_download_cap(self):
        _, urlopen = self.opener(redirect('https://store.example/b?sig=SECRET'), b'x' * 11)
        with self.assertRaises(gt.Untrusted) as cm:
            gt.GitHubApi('tok', urlopen).download(REPO, 5, io.BytesIO(), 10)
        self.assertEqual(str(cm.exception), 'artifact download exceeds 10 bytes')

    def test_storage_error_does_not_print_the_signed_url(self):
        signed = 'https://store.example/b?sig=SECRET'
        _, urlopen = self.opener(redirect(signed), urllib.error.HTTPError(signed, 403, 'no', email.message.Message(), None))
        with self.assertRaises(gt.Untrusted) as cm:
            gt.GitHubApi('tok', urlopen).download(REPO, 5, io.BytesIO(), 10)
        self.assertEqual(str(cm.exception), 'artifact storage returned 403')

    def test_plain_http_redirect_is_refused(self):
        _, urlopen = self.opener(redirect('http://store.example/b'))
        with self.assertRaisesRegex(gt.Untrusted, '^artifact download: redirect is not https$'):
            gt.GitHubApi('tok', urlopen).download(REPO, 5, io.BytesIO(), 10)

    def test_no_redirect_is_refused(self):
        _, urlopen = self.opener(b'unexpected body')
        with self.assertRaisesRegex(gt.Untrusted, '^artifact download did not redirect to storage$'):
            gt.GitHubApi('tok', urlopen).download(REPO, 5, io.BytesIO(), 10)

    def test_empty_token(self):
        with self.assertRaisesRegex(gt.Untrusted, '^no GitHub token$'):
            gt.GitHubApi('')

    def test_default_opener_does_not_follow_redirects(self):
        handler = gt._NoRedirect()
        self.assertEqual(handler.redirect_request(None, None, 302, 'Found', {}, 'https://elsewhere'), None)


if __name__ == '__main__':
    unittest.main()
