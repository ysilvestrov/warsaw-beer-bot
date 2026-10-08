import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Artifact deployment, Ядро-1 (docs/superpowers/specs/2026-10/2026-10-08-wbb-artifact-deployment-design.md).
const root = resolve(__dirname, '..');

describe.skipIf(process.platform !== 'linux')('runtime artifact tools (deploy/release)', () => {
  it('pass their Python unit tests', () => {
    const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'deploy/release', '-p', 'test_*.py', '-v'], {
      cwd: root, encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error, result.stderr).toBe(undefined);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 100_000);
});

const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8').split('\n');

// The lines of one top-level job: from `  <name>:` to the next two-space key.
function job(name: string): string[] {
  const start = workflow.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`job ${name} not found in ci.yml`);
  const rest = workflow.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return [workflow[start], ...(end < 0 ? rest : rest.slice(0, end))];
}

// The literal block of the job's `run: |` step, de-indented.
function runBlock(lines: string[]): string {
  const at = lines.findIndex((l) => l.trim() === 'run: |');
  if (at < 0) throw new Error('no run: | block');
  const indent = lines[at + 1].length - lines[at + 1].trimStart().length;
  const body = lines.slice(at + 1);
  const end = body.findIndex((l) => l.trim() !== '' && l.length - l.trimStart().length < indent);
  return (end < 0 ? body : body.slice(0, end)).map((l) => l.slice(indent)).join('\n');
}

describe('ci.yml package job (spec §3, §9)', () => {
  const pkg = job('package').map((l) => l.trim());

  it.each([
    'runs-on: ubuntu-24.04',
    'needs: [build]',
    "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    'node-version: 24',
    'name: wbb-release-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    '${{ runner.temp }}/release/runtime.tar.gz',
    '${{ runner.temp }}/release/runtime.tar.gz.sha256',
    'if-no-files-found: error',
    'retention-days: 30',
    'run: npx tsc -p tsconfig.release.json --outDir "$RUNNER_TEMP/dist"',
  ])('has %s', (line) => {
    expect(pkg).toContain(line);
  });

  it('runs its steps in this order: build, audit and verify before the upload', () => {
    expect(pkg.filter((l) => l.startsWith('- '))).toEqual([
      '- uses: actions/checkout@v7',
      '- uses: actions/setup-node@v7',
      '- name: Install',
      '- name: Build dist',
      '- name: Install production dependencies',
      '- name: Audit production dependencies',
      '- name: Package runtime',
      '- name: Verify unpacked payload',
      '- uses: actions/upload-artifact@v6',
    ]);
  });

  it('uses no secrets', () => {
    expect(job('package').filter((l) => l.includes('secrets.'))).toEqual([]);
  });
});

describe('ci.yml aggregator (spec §5)', () => {
  const ci = job('ci');
  const script = runBlock(ci);

  it('waits for build and package, always', () => {
    expect(ci.map((l) => l.trim())).toEqual(expect.arrayContaining(['needs: [build, package]', 'if: always()']));
  });

  // The aggregator's own shell, run as Actions runs it (bash -e) for every outcome pair.
  it.each([
    ['success', 'success', 'true', 0],
    ['success', 'skipped', 'false', 0],
    ['success', 'skipped', 'true', 1],
    ['success', 'failure', 'true', 1],
    ['success', 'cancelled', 'true', 1],
    ['success', 'failure', 'false', 1],
    ['failure', 'skipped', 'false', 1],
    ['failure', 'success', 'true', 1],
    ['cancelled', 'skipped', 'false', 1],
  ])('build=%s package=%s main-push=%s exits %i', (build, pkgResult, mainPush, code) => {
    const r = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8', env: { PATH: process.env.PATH, BUILD: build, PACKAGE: pkgResult, MAIN_PUSH: mainPush },
    });
    expect(r.status).toBe(code);
  });
});
