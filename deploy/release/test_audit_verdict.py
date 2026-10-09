import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import audit_verdict as av  # noqa: E402

FIXTURES = os.path.join(HERE, '..', '..', 'scripts', 'autodeploy', 'fixtures', 'npm-audit')


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as f:
        return f.read()


def report(vulns):
    return json.dumps({'auditReportVersion': 2, 'vulnerabilities': vulns})


class Fixtures(unittest.TestCase):
    def test_clean(self):
        self.assertEqual(av.audit_verdict(fixture('clean.json')), av.Verdict('clean'))

    def test_advisory_is_named(self):
        v = av.audit_verdict(fixture('advisory.json'))
        self.assertEqual((v.kind, [(f.name, f.severity) for f in v.findings]), ('advisory', [('proxy-addr', 'critical')]))

    def test_missing_lockfile(self):
        self.assertEqual(av.audit_verdict(fixture('enolock.json')), av.Verdict('unrunnable', reason=(
            'reports an error, not an audit: ENOLOCK — This command requires an existing lockfile.')))

    def test_registry_down(self):
        self.assertEqual(av.audit_verdict(fixture('registry-down.json')).reason, (
            'reports an error, not an audit: request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk '
            'failed, reason: connect ECONNREFUSED 127.0.0.1:9'))


class Malformed(unittest.TestCase):
    def reason(self, stdout):
        v = av.audit_verdict(stdout)
        self.assertEqual(v.kind, 'unrunnable')
        return v.reason

    def test_empty(self):
        self.assertEqual(self.reason('  \n'), 'is empty — npm audit did not produce a report')

    def test_not_json(self):
        self.assertEqual(self.reason('npm ERR!'), 'is not JSON — npm audit did not produce a report')

    def test_nan_is_not_json(self):
        self.assertEqual(self.reason('{"vulnerabilities": NaN}'), 'is not JSON — npm audit did not produce a report')

    def test_array(self):
        self.assertEqual(self.reason('[]'), 'is not a JSON object — npm audit did not produce a report')

    def test_error_without_strings(self):
        self.assertEqual(self.reason('{"error": {"summary": "", "detail": ""}}'),
                         'reports an error, not an audit: {"summary":"","detail":""}')

    def test_no_vulnerabilities_field(self):
        self.assertEqual(self.reason('{"auditReportVersion": 2}'),
                         'has no "vulnerabilities" field — not a well-formed audit report')

    def test_unknown_severity(self):
        self.assertEqual(self.reason(report({'x': {'severity': 'severe'}})),
                         'has a malformed entry for "x" — not a well-formed audit report')

    def test_via_not_a_list(self):
        self.assertEqual(self.reason(report({'x': {'severity': 'high', 'via': None}})),
                         'has a malformed entry for "x" — not a well-formed audit report')


class Severities(unittest.TestCase):
    def test_moderate_only_is_clean(self):
        self.assertEqual(av.audit_verdict(report({'a': {'severity': 'moderate', 'via': []}})).kind, 'clean')

    def test_high_is_an_advisory_and_renders_its_sources(self):
        v = av.audit_verdict(report({
            'a': {'severity': 'low'},
            'b': {'severity': 'high', 'via': [{'title': 'T', 'url': 'https://u'}, 'c']},
        }))
        self.assertEqual(av.render_verdict(v), 'b high — T https://u; via c')


if __name__ == '__main__':
    unittest.main()
