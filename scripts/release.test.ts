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

// The steps of a job: each from its `      - ` line to the next, with its `if:` (null when none).
function steps(lines: string[]): { head: string; lines: string[]; if: string | null }[] {
  const starts = lines.flatMap((l, i) => (/^ {6}- /.test(l) ? [i] : []));
  return starts.map((at, k) => {
    const body = lines.slice(at, starts[k + 1] ?? lines.length);
    const cond = body.find((l) => /^ {8}if: /.test(l));
    return { head: body[0].trim(), lines: body, if: cond ? cond.trim().slice('if: '.length) : null };
  });
}

const MAIN_PUSH = "github.event_name == 'push' && github.ref == 'refs/heads/main'";

// Image spec 2026-10-11 §3.1, §3.3; plan 2026-10-11 core, Рішення п.1–2.
describe('ci.yml image job', () => {
  const image = job('image');
  const trimmed = image.map((l) => l.trim());

  it.each([
    'runs-on: ubuntu-24.04',
    'needs: [build]',
    'contents: read',
    'packages: write',
    'id-token: write',
    'attestations: write',
    'REPOSITORY: ghcr.io/ysilvestrov/warsaw-beer-bot',
    'docker buildx build -f deploy/image/Dockerfile --platform linux/amd64',
    // One manifest, not an index: the digest the attestation names is the image's own.
    '--provenance=false --sbom=false --load',
    'run: scripts/image-smoke.sh wbb-image:smoke "$GITHUB_SHA"',
    'subject-name: ${{ env.REPOSITORY }}',
    'subject-digest: ${{ steps.push.outputs.digest }}',
    'push-to-registry: true',
  ])('has %s', (line) => {
    expect(trimmed).toContain(line);
  });

  it('runs on every event: no job-level if', () => {
    expect(image.filter((l) => /^ {4}if:/.test(l))).toEqual([]);
  });

  it('builds, smokes, audits and labels on every event; logs in, pushes, attests and records on a main push only', () => {
    expect(steps(image).map((s) => [s.head, s.if])).toEqual([
      ['- uses: actions/checkout@v7', null],
      ['- name: Build image', null],
      ['- name: Smoke', null],
      ['- name: Audit production dependencies', null],
      ['- name: Label content', null],
      ['- name: Log in to GHCR', MAIN_PUSH],
      ['- name: Push', MAIN_PUSH],
      ['- uses: actions/attest-build-provenance@v2', MAIN_PUSH],
      ['- name: Record digest', MAIN_PUSH],
    ]);
  });

  it('uses no secrets beyond the job token', () => {
    expect(image.filter((l) => l.includes('secrets.'))).toEqual([]);
  });

  // The audit step's own shell, run as Actions runs it, with a docker that exits like the
  // verdict CLI in the image: 0 clean, 10 advisory, anything else could not audit.
  it.each([
    ['0', 0, ''],
    ['10', 1, '::error::high or critical advisory in production dependencies'],
    ['2', 1, '::error::could not audit production dependencies (exit 2)'],
    ['125', 1, '::error::could not audit production dependencies (exit 125)'],
  ])('audit: the CLI exiting %s fails the step with %i', (cliCode, code, message) => {
    const audit = steps(image).find((s) => s.head === '- name: Audit production dependencies')!;
    const bin = mkdtempSync(resolve(tmpdir(), 'wbb-audit-'));
    try {
      writeFileSync(resolve(bin, 'docker'), `#!/bin/sh\nexit ${cliCode}\n`, { mode: 0o755 });
      const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', runBlock(audit.lines)], {
        encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}` },
      });
      expect([r.status, r.stdout.trim()]).toEqual([code, message]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('ci.yml: the runtime artifact is gone', () => {
  it('has no package job and uploads no artifact', () => {
    expect([workflow.indexOf('  package:'), workflow.filter((l) => l.includes('upload-artifact'))]).toEqual([-1, []]);
  });
});

describe('ci.yml aggregator (image spec §3.1)', () => {
  const ci = job('ci');
  const script = runBlock(ci);

  it('waits for build and image, always', () => {
    expect(ci.map((l) => l.trim())).toEqual(expect.arrayContaining(['needs: [build, image]', 'if: always()']));
  });

  // The aggregator's own shell, run as Actions runs it (bash -e) for every outcome pair.
  // `image` runs on every event, so skipped is a failure everywhere.
  it.each([
    ['success', 'success', 0],
    ['success', 'skipped', 1],
    ['success', 'failure', 1],
    ['success', 'cancelled', 1],
    ['failure', 'success', 1],
    ['failure', 'skipped', 1],
    ['cancelled', 'skipped', 1],
  ])('build=%s image=%s exits %i', (build, imageResult, code) => {
    const r = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8', env: { PATH: process.env.PATH, BUILD: build, IMAGE: imageResult },
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
