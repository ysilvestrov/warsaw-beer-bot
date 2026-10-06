import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKFLOW = readFileSync(resolve(__dirname, '../../.github/workflows/prod-audit.yml'), 'utf8');

// The audit step's script, de-indented exactly as the runner writes it to a file.
function auditStepScript(): string {
  const m = WORKFLOW.match(/id: audit\n\s+run: \|\n((?: {10}.*\n|\n)+)/);
  if (m === null) throw new Error('audit step not found in prod-audit.yml');
  return m[1].split('\n').map((l) => l.slice(10)).join('\n');
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Runs the step under `bash -e`, the shell GitHub uses for `run:` (#789), with an `npm` stub
// that exits with `npmExit`. Returns the step's exit code and what it wrote to GITHUB_OUTPUT.
function runAuditStep(npmExit: number): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prod-audit-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/sh\necho "stub audit report"\nexit ${npmExit}\n`);
  chmodSync(join(dir, 'bin', 'npm'), 0o755);
  writeFileSync(join(dir, 'step.sh'), auditStepScript());
  writeFileSync(join(dir, 'out'), '');
  const r = spawnSync('bash', ['-e', 'step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_OUTPUT: join(dir, 'out') },
  });
  return { status: r.status, output: readFileSync(join(dir, 'out'), 'utf8') };
}

describe('prod-audit workflow, audit step under bash -e', () => {
  it('reports clean when npm audit exits 0', () => {
    expect(runAuditStep(0)).toEqual({ status: 0, output: 'state=clean\nexit_code=0\n' });
  });

  // #789: before the fix the step died on the audit line, wrote nothing, and no issue was opened.
  it('reports vulnerable, and survives, when npm audit exits 1', () => {
    expect(runAuditStep(1)).toEqual({ status: 0, output: 'state=vulnerable\nexit_code=1\n' });
  });

  it('reports unknown, and survives, when npm audit fails otherwise', () => {
    expect(runAuditStep(2)).toEqual({ status: 0, output: 'state=unknown\nexit_code=2\n' });
  });
});

describe('prod-audit workflow, run colour', () => {
  // The step now survives a finding, so the run would go green; the last step keeps it red.
  it('ends with a step that fails the run unless production is clean', () => {
    expect(WORKFLOW.trimEnd().endsWith([
      "      - name: Fail the run when production is not clean",
      "        if: steps.audit.outputs.state != 'clean'",
      '        run: exit 1',
    ].join('\n'))).toBe(true);
  });
});
