import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  auditVerdict,
  parseAuditReport,
  renderVerdict,
  verdictExitCode,
} from './audit-verdict';

/**
 * #795 — npm 12 exits 1 for an advisory, a missing lockfile and an unreachable
 * registry alike. The fixtures are those three cases plus a clean audit, captured
 * verbatim on 2026-10-06; the verdict must come from their JSON alone.
 */
const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, 'fixtures/npm-audit', name), 'utf8');

const ADVISORY_LINE =
  'proxy-addr critical — proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet https://github.com/advisories/GHSA-jqcg-44mw-7w3h';
const REGISTRY_REASON =
  'reports an error, not an audit: request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9';

const report = (vulnerabilities: Record<string, unknown>): string =>
  JSON.stringify({ auditReportVersion: 2, vulnerabilities });

describe('auditVerdict — the four probed cases', () => {
  it('a clean audit is clean', () => {
    expect(auditVerdict(fixture('clean.json'))).toEqual({ kind: 'clean' });
  });

  it('the proxy-addr advisory is an advisory with its GHSA', () => {
    expect(auditVerdict(fixture('advisory.json'))).toEqual({
      kind: 'advisory',
      findings: [{
        name: 'proxy-addr',
        severity: 'critical',
        advisories: [{
          title: 'proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet',
          url: 'https://github.com/advisories/GHSA-jqcg-44mw-7w3h',
        }],
        via: [],
      }],
    });
  });

  it('ENOLOCK is unrunnable, named by code and summary', () => {
    expect(auditVerdict(fixture('enolock.json'))).toEqual({
      kind: 'unrunnable',
      reason: 'reports an error, not an audit: ENOLOCK — This command requires an existing lockfile.',
    });
  });

  // The regression #795 is about: this exact output used to read as an advisory.
  it('an unreachable registry is unrunnable, named by npm\'s message', () => {
    expect(auditVerdict(fixture('registry-down.json'))).toEqual({ kind: 'unrunnable', reason: REGISTRY_REASON });
  });
});

describe('auditVerdict — the severity boundary', () => {
  it('a moderate-only report is clean', () => {
    expect(auditVerdict(report({ a: { severity: 'moderate', via: [] } }))).toEqual({ kind: 'clean' });
  });

  it('a high report is an advisory', () => {
    expect(auditVerdict(report({ a: { severity: 'high', via: [] } }))).toEqual({
      kind: 'advisory',
      findings: [{ name: 'a', severity: 'high', advisories: [], via: [] }],
    });
  });

  it('keeps only the high and critical packages of a mixed report', () => {
    const v = auditVerdict(report({
      lo: { severity: 'low', via: [] },
      hi: { severity: 'high', via: ['lo'] },
      cr: { severity: 'critical', via: [] },
    }));
    expect(v).toEqual({
      kind: 'advisory',
      findings: [
        { name: 'hi', severity: 'high', advisories: [], via: ['lo'] },
        { name: 'cr', severity: 'critical', advisories: [], via: [] },
      ],
    });
  });
});

describe('parseAuditReport — anything that is not an audit is an error', () => {
  it('empty stdout', () => {
    expect(parseAuditReport('  \n')).toEqual({ error: 'is empty — npm audit did not produce a report' });
  });

  it('not JSON', () => {
    expect(parseAuditReport('npm error code E500')).toEqual({ error: 'is not JSON — npm audit did not produce a report' });
  });

  it('JSON that is not an object', () => {
    expect(parseAuditReport('[]')).toEqual({ error: 'is not a JSON object — npm audit did not produce a report' });
  });

  it('an object with no vulnerabilities field', () => {
    expect(parseAuditReport('{"auditReportVersion":2}')).toEqual({
      error: 'has no "vulnerabilities" field — not a well-formed audit report',
    });
  });

  it('an error with no code, summary or message falls back to the raw error', () => {
    expect(parseAuditReport('{"error":{"detail":"x"}}')).toEqual({
      error: 'reports an error, not an audit: {"detail":"x"}',
    });
  });

  it('an error key wins even when vulnerabilities is present', () => {
    expect(parseAuditReport('{"error":{"code":"E1"},"vulnerabilities":{}}')).toEqual({
      error: 'reports an error, not an audit: E1',
    });
  });
});

describe('renderVerdict', () => {
  it('renders the advisory as one line per package', () => {
    expect(renderVerdict(auditVerdict(fixture('advisory.json')))).toBe(ADVISORY_LINE);
  });

  it('renders upstream-only findings by the packages they come through', () => {
    expect(renderVerdict({
      kind: 'advisory',
      findings: [
        { name: 'hi', severity: 'high', advisories: [], via: ['lo', 'mid'] },
        { name: 'cr', severity: 'critical', advisories: [{ title: 'T', url: 'U' }], via: ['x'] },
        { name: 'bare', severity: 'high', advisories: [], via: [] },
      ],
    })).toBe('hi high — via lo, mid\ncr critical — T U; via x\nbare high');
  });

  it('renders clean', () => {
    expect(renderVerdict({ kind: 'clean' })).toBe('npm audit: no high or critical advisory in production dependencies');
  });

  it('renders unrunnable with its reason', () => {
    expect(renderVerdict(auditVerdict(fixture('registry-down.json'))))
      .toBe(`npm audit could not run: the output ${REGISTRY_REASON}`);
  });
});

describe('verdictExitCode', () => {
  it('maps clean / advisory / unrunnable to 0 / 1 / 2', () => {
    expect([
      verdictExitCode({ kind: 'clean' }),
      verdictExitCode({ kind: 'advisory', findings: [] }),
      verdictExitCode({ kind: 'unrunnable', reason: 'r' }),
    ]).toEqual([0, 1, 2]);
  });
});

describe('audit-verdict-cli', () => {
  const CLI = resolve(__dirname, 'audit-verdict-cli.ts');
  const run = (input: string) => {
    const r = spawnSync('npx', ['tsx', CLI], { input, encoding: 'utf8' });
    return { code: r.status, out: r.stdout };
  };

  it('clean → exit 0', () => {
    expect(run(fixture('clean.json'))).toEqual({
      code: 0, out: 'npm audit: no high or critical advisory in production dependencies\n',
    });
  });

  it('advisory → exit 1', () => {
    expect(run(fixture('advisory.json'))).toEqual({ code: 1, out: `${ADVISORY_LINE}\n` });
  });

  it('unreachable registry → exit 2', () => {
    expect(run(fixture('registry-down.json'))).toEqual({
      code: 2, out: `npm audit could not run: the output ${REGISTRY_REASON}\n`,
    });
  });

  it('no input at all → exit 2', () => {
    expect(run('')).toEqual({
      code: 2, out: 'npm audit could not run: the output is empty — npm audit did not produce a report\n',
    });
  });
});
