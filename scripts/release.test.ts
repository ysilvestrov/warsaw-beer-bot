import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { auditVerdict, renderVerdict } from './autodeploy/audit-verdict';

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
    // The host admits only STORED ZIP entries (deploy/release/zip_admission.py, gate G1).
    'compression-level: 0',
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

// Ядро-2б: the host judges audits with deploy/release/audit_verdict.py, a stdlib port of
// audit-verdict.ts. The two must render the same text for the same report.
describe.skipIf(process.platform !== 'linux')('audit verdict: Python port agrees with audit-verdict.ts', () => {
  const fixtures = resolve(root, 'scripts/autodeploy/fixtures/npm-audit');
  const inputs: [string, string][] = [
    ...readdirSync(fixtures).sort().map((f): [string, string] => [f, readFileSync(resolve(fixtures, f), 'utf8')]),
    ['empty', ''],
    ['not json', 'npm ERR! oops'],
    ['array', '[]'],
    ['error as a string', '{"error": "boom"}'],
    ['no vulnerabilities', '{"auditReportVersion": 2}'],
    ['unknown severity', '{"vulnerabilities": {"x": {"severity": "severe"}}}'],
    ['via null', '{"vulnerabilities": {"x": {"severity": "high", "via": null}}}'],
    ['moderate only', '{"vulnerabilities": {"a": {"severity": "moderate", "via": []}}}'],
    ['two findings', '{"vulnerabilities": {"a": {"severity": "critical", "via": ["b"]}, "b": {"severity": "high", "via": [{"title": "T", "url": "https://u"}]}}}'],
  ];

  it.each(inputs)('%s', (_name, stdout) => {
    const py = spawnSync('python3', ['-B', '-c',
      'import sys; sys.path.insert(0, "deploy/release"); import audit_verdict as a; ' +
      'print(a.render_verdict(a.audit_verdict(sys.stdin.read())), end="")'],
    { cwd: root, input: stdout, encoding: 'utf8' });
    expect(py.stderr).toBe('');
    expect(py.stdout).toBe(renderVerdict(auditVerdict(stdout)));
  });
});

// Ядро-2б: `payload-probe.cjs migrate <db>` runs the release's own openDb/migrate on the
// host's private copy of a pre snapshot. A real payload exists only inside CI's package
// job, so this builds the smallest one that runs the REAL code: dist/storage/{db,schema}.js
// load src/storage/*.ts through tsx, node_modules is this checkout's.
describe.skipIf(process.platform !== 'linux')('payload-probe.cjs migrate', () => {
  let payload = '';
  let work = '';
  beforeAll(() => {
    work = mkdtempSync(resolve(tmpdir(), 'wbb-probe-migrate-'));
    payload = resolve(work, 'payload');
    mkdirSync(resolve(payload, 'dist/storage'), { recursive: true });
    writeFileSync(resolve(payload, 'package.json'), '{}');
    symlinkSync(resolve(root, 'node_modules'), resolve(payload, 'node_modules'));
    for (const mod of ['db', 'schema']) {
      writeFileSync(resolve(payload, `dist/storage/${mod}.js`),
        `require(${JSON.stringify(resolve(root, 'node_modules/tsx/dist/cjs/index.cjs'))});\n` +
        `module.exports = require(${JSON.stringify(resolve(root, `src/storage/${mod}.ts`))});\n`);
    }
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const probe = (...args: string[]) => spawnSync(process.execPath, [resolve(root, 'deploy/release/payload-probe.cjs'), 'migrate', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, WBB_PAYLOAD: payload, TMPDIR: work }, timeout: 60_000,
  });

  it('migrates a given database twice and reports the move, then a second run moves nothing', () => {
    const db = resolve(work, 'copy.db');
    const first = probe(db);
    const head = /^PROBE OK migrate: schema none -> (\d+) \(knows (\d+)\)\n$/.exec(first.stdout);
    // From nothing, the release's migrate() reaches exactly the newest schema it knows (2b review N5).
    expect([first.status, head?.[1], head?.[1] === head?.[2]]).toEqual([0, expect.stringMatching(/^\d+$/), true]);
    const again = probe(db);
    expect([again.status, again.stdout]).toEqual([0, `PROBE OK migrate: schema ${head?.[1]} -> ${head?.[1]} (knows ${head?.[1]})\n`]);
  }, 60_000);

  it('reports what the release knows, not what the database holds, for a database newer than the release', () => {
    const db = resolve(work, 'newer.db');
    const head = /^PROBE OK migrate: schema none -> (\d+) \(knows \d+\)\n$/.exec(probe(db).stdout)?.[1];
    const bump = spawnSync('python3', ['-B', '-c',
      'import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO schema_version VALUES (9999)"); c.commit()', db]);
    expect(bump.status).toBe(0);
    const r = probe(db);
    expect([r.status, r.stdout]).toEqual([0, `PROBE OK migrate: schema 9999 -> 9999 (knows ${head})\n`]);
  }, 60_000);

  it('refuses a file that is not a database', () => {
    const bad = resolve(work, 'not-a-db.db');
    writeFileSync(bad, 'x'.repeat(4096));
    const r = probe(bad);
    expect([r.status, r.stdout]).toEqual([1, 'PROBE FAILED migrate: file is not a database\n']);
  }, 60_000);
});
