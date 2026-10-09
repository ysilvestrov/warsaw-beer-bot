"""What one `npm audit --omit=dev --json` run says about production — host-side port.

Spec: docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md §5 (audit 2 of 2).
Plan: docs/superpowers/plans/2026-10/2026-10-09-wbb-artifact-deployment-core-2b.md, Task 1.

A stdlib port of scripts/autodeploy/audit-verdict.ts (#795), so the host can judge a
report without running tsx from a checkout or from the candidate. Read from the JSON,
never from npm's exit code: npm exits 1 for an advisory, a missing lockfile and an
unreachable registry alike. An absent or malformed report is `unrunnable` — no
evidence — never a pass. scripts/release.test.ts holds the two implementations to the
same rendered output on the same inputs.
"""
import json
from dataclasses import dataclass, field

SEVERITIES = ('info', 'low', 'moderate', 'high', 'critical')
ACTIONABLE = ('high', 'critical')
NO_REPORT = 'npm audit did not produce a report'


@dataclass(frozen=True)
class Finding:
    name: str
    severity: str
    advisories: tuple = ()   # (title, url) pairs from the advisory objects in `via`
    via: tuple = ()          # package names this one is vulnerable through


@dataclass(frozen=True)
class Verdict:
    kind: str                # 'clean' | 'advisory' | 'unrunnable'
    reason: str = ''         # for 'unrunnable': a predicate of "the output"
    findings: tuple = field(default_factory=tuple)


def _reject_constant(name):
    raise ValueError(f'non-JSON constant {name}')


def _describe_npm_error(error, message):
    e = error if isinstance(error, dict) else {}
    parts = [p for p in (e.get('code'), e.get('summary'), message) if isinstance(p, str) and p != '']
    if parts:
        return ' — '.join(parts)
    return json.dumps(error, separators=(',', ':'), ensure_ascii=False)


def parse_audit_report(stdout):
    """The `vulnerabilities` mapping, or ('error', reason) for anything that is not a report."""
    raw = stdout.strip()
    if raw == '':
        return 'error', f'is empty — {NO_REPORT}'
    try:
        parsed = json.loads(raw, parse_constant=_reject_constant)
    except ValueError:
        return 'error', f'is not JSON — {NO_REPORT}'
    if not isinstance(parsed, dict):
        return 'error', f'is not a JSON object — {NO_REPORT}'
    if 'error' in parsed:
        return 'error', f'reports an error, not an audit: {_describe_npm_error(parsed["error"], parsed.get("message"))}'
    v = parsed.get('vulnerabilities')
    if not isinstance(v, dict):
        return 'error', 'has no "vulnerabilities" field — not a well-formed audit report'
    for name, e in v.items():
        well_formed = (isinstance(e, dict) and e.get('severity') in SEVERITIES
                       and isinstance(e.get('severity'), str)
                       and ('via' not in e or isinstance(e['via'], list)))
        if not well_formed:
            return 'error', f'has a malformed entry for "{name}" — not a well-formed audit report'
    return 'ok', v


def _finding(name, severity, via):
    advisories, upstream = [], []
    for entry in via:
        if isinstance(entry, str):
            upstream.append(entry)
        elif isinstance(entry, dict) and isinstance(entry.get('title'), str) and isinstance(entry.get('url'), str):
            advisories.append((entry['title'], entry['url']))
    return Finding(name, severity, tuple(advisories), tuple(upstream))


def audit_verdict(stdout):
    status, value = parse_audit_report(stdout)
    if status == 'error':
        return Verdict('unrunnable', reason=value)
    findings = tuple(_finding(name, e['severity'], e.get('via', []))
                     for name, e in value.items() if e['severity'] in ACTIONABLE)
    return Verdict('advisory', findings=findings) if findings else Verdict('clean')


def _render_finding(f):
    parts = [f'{t} {u}' for t, u in f.advisories] + ([f'via {", ".join(f.via)}'] if f.via else [])
    head = f'{f.name} {f.severity}'
    return f'{head} — {"; ".join(parts)}' if parts else head


def render_verdict(v):
    if v.kind == 'clean':
        return 'npm audit: no high or critical advisory in production dependencies'
    if v.kind == 'unrunnable':
        return f'npm audit could not run: the output {v.reason}'
    return '\n'.join(_render_finding(f) for f in v.findings)
