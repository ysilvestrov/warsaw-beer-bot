import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/prod-audit.yml'), 'utf8');
const fx = (name: string) => readFileSync(resolve(__dirname, 'fixtures/npm-audit', name), 'utf8');

// The audit step's script, de-indented exactly as the runner writes it to a file.
function auditStepScript(): string {
  const m = WORKFLOW.match(/id: audit\n\s+run: \|\n((?: {10}.*\n|\n)+)/);
  if (m === null) throw new Error('audit step not found in prod-audit.yml');
  return m[1].split('\n').map((l) => l.slice(10)).join('\n');
}

// Runs the step under `bash -e`, the shell GitHub uses for `run:` (#789), in a cwd that has
// the repository's node_modules and scripts (the install step's result), with an `npm` stub
// that prints `json` and exits `npmExit` (#795: the real npm exits 1 for all three non-clean cases).
function runAuditStep(json: string, npmExit: number, tsxStub?: string): { status: number | null; output: string; report: string } {
  const dir = makeTempDirectory('prod-audit-');
  if (tsxStub === undefined) {
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  } else {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'tsx'), `#!/usr/bin/env bash\n${tsxStub}\n`);
    chmodSync(join(dir, 'node_modules', '.bin', 'tsx'), 0o755);
  }
  symlinkSync(join(ROOT, 'scripts'), join(dir, 'scripts'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'report.json'), json);
  writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/sh\ncat "${join(dir, 'report.json')}"\nexit ${npmExit}\n`);
  chmodSync(join(dir, 'bin', 'npm'), 0o755);
  writeFileSync(join(dir, 'step.sh'), auditStepScript());
  writeFileSync(join(dir, 'out'), '');
  const r = spawnSync('bash', ['-e', 'step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_OUTPUT: join(dir, 'out') },
  });
  return {
    status: r.status,
    output: readFileSync(join(dir, 'out'), 'utf8'),
    report: readFileSync(join(dir, 'audit.txt'), 'utf8'),
  };
}

describe('prod-audit workflow, audit step under bash -e', () => {
  it('a clean audit is clean', () => {
    expect(runAuditStep(fx('clean.json'), 0)).toEqual({
      status: 0,
      output: 'state=clean\nexit_code=0\n',
      report: 'npm audit: no high or critical advisory in production dependencies\n',
    });
  });

  it('the proxy-addr advisory is vulnerable, and the report names it', () => {
    expect(runAuditStep(fx('advisory.json'), 1)).toEqual({
      status: 0,
      output: 'state=vulnerable\nexit_code=10\n',
      report: 'proxy-addr critical — proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet https://github.com/advisories/GHSA-jqcg-44mw-7w3h\n',
    });
  });

  // #795: npm exits 1 here as well; this used to open the issue as "vulnerable".
  it('an unreachable registry is unknown', () => {
    expect(runAuditStep(fx('registry-down.json'), 1)).toEqual({
      status: 0,
      output: 'state=unknown\nexit_code=2\n',
      report: 'npm audit could not run: the output reports an error, not an audit: request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9\n',
    });
  });

  // Node itself exits 1 when the CLI cannot load: that must not read as an advisory.
  it('a CLI crash that exits 1 is unknown, not vulnerable', () => {
    const r = runAuditStep(fx('advisory.json'), 1, 'echo "Error: Cannot find module" >&2; exit 1');
    expect(r).toEqual({
      status: 0,
      output: 'state=unknown\nexit_code=1\n',
      report: 'Error: Cannot find module\n',
    });
  });

  it('ENOLOCK is unknown', () => {
    expect(runAuditStep(fx('enolock.json'), 1).output).toBe('state=unknown\nexit_code=2\n');
  });

  it('a low-only report is clean although npm exits 1', () => {
    const low = JSON.stringify({ auditReportVersion: 2, vulnerabilities: { a: { severity: 'low', via: [] } } });
    expect(runAuditStep(low, 1).output).toBe('state=clean\nexit_code=0\n');
  });
});

describe('prod-audit workflow, structure', () => {
  // tsx for the verdict CLI, without running any package's install script.
  it('installs dependencies with install scripts disabled', () => {
    expect(WORKFLOW).toContain('        run: npm ci --ignore-scripts --no-audit --no-fund\n');
  });

  // An install outage must reach the verdict step (missing tsx → unknown → issue), not end the job.
  it('lets the install step fail so the verdict step still opens the issue', () => {
    expect(WORKFLOW).toContain([
      '      - name: Install dependencies (no install scripts)',
      '        continue-on-error: true',
      '        run: npm ci --ignore-scripts --no-audit --no-fund',
      '',
    ].join('\n'));
  });

  // The step survives a finding, so the run would go green; the last step keeps it red.
  it('ends with a step that fails the run unless production is clean', () => {
    expect(WORKFLOW.trimEnd().endsWith([
      '      - name: Fail the run when production is not clean',
      "        if: steps.audit.outputs.state != 'clean'",
      '        run: exit 1',
    ].join('\n'))).toBe(true);
  });
});
