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
      cwd: root, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error, result.stderr).toBe(undefined);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 190_000);
});

// Image transition core (plan docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md, Task 2): the
// root helper wbb-image, its copy of bounded.py and its wrapper, tested from Python with a fake host.
describe.skipIf(process.platform !== 'linux')('root image helper (deploy/image/helper)', () => {
  it('passes its Python unit tests', () => {
    const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'deploy/image/helper', '-p', 'test_*.py', '-v'], {
      cwd: root, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error, result.stderr).toBe(undefined);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 70_000);
});

// Stage «в» harness (plan docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-harness.md, Task 1): the
// rehearsal shim runs the helper above under the kit's names. Its own directory: scripts/ops is discovered without
// recursing (ops.test.ts), and the shim is tested where the helper it imports is.
describe.skipIf(process.platform !== 'linux')('rehearsal shim of the image helper (scripts/ops/rehearsal)', () => {
  it('passes its Python unit tests', () => {
    const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/ops/rehearsal', '-p', 'test_*.py', '-v'], {
      cwd: root, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error, result.stderr).toBe(undefined);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 70_000);
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
    // attest v4 defaults it on and needs a permission the job does not have; the step only runs on main.
    'create-storage-record: false',
  ])('has %s', (line) => {
    expect(trimmed).toContain(line);
  });

  it('runs on every event: no job-level if', () => {
    expect(image.filter((l) => /^ {4}if:/.test(l))).toEqual([]);
  });

  // The audit is last: on a main push publication (push, attest, record) does not depend on
  // when an advisory appeared, and the red audit still keeps `ci` red, so the SHA is not deployed.
  it('builds, smokes and labels on every event; logs in, pushes, attests and records on a main push only; audits last, on every event', () => {
    expect(steps(image).map((s) => [s.head, s.if])).toEqual([
      ['- uses: actions/checkout@v7', null],
      ['- name: Runtime base digest', null],
      ['- name: Build image', null],
      ['- name: Smoke', null],
      ['- name: Label content', null],
      ['- name: Log in to GHCR', MAIN_PUSH],
      ['- name: Push', MAIN_PUSH],
      ['- uses: actions/attest-build-provenance@v4', MAIN_PUSH],
      ['- name: Record digest', MAIN_PUSH],
      ['- name: Audit production dependencies', null],
    ]);
  });

  // On a PR the audit annotates and does not fail the job: an advisory published upstream is
  // not the PR's doing and must not block every merge (including the one that bumps the
  // dependency). On a main push it fails the job, so `ci` is red and merge-deploy skips the SHA.
  it('audit fails the job on a main push only', () => {
    const audit = steps(image).find((s) => s.head === '- name: Audit production dependencies')!;
    expect(audit.lines.filter((l) => /^ {8}continue-on-error:/.test(l)).map((l) => l.trim()))
      .toEqual(["continue-on-error: ${{ github.event_name == 'pull_request' }}"]);
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

// Dependabot (docker) bumps only a literal digest in FROM; the build arg follows it (image spec §4.1).
describe('runtime base digest', () => {
  const run = (dockerfile: string) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'wbb-base-'));
    try {
      writeFileSync(resolve(dir, 'Dockerfile'), dockerfile);
      const r = spawnSync('bash', [resolve(root, 'scripts/image-base-digest.sh'), resolve(dir, 'Dockerfile')], { encoding: 'utf8' });
      return [r.status, r.stdout, r.stderr.trim()];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const D1 = `sha256:${'a'.repeat(64)}`;
  const D2 = `sha256:${'b'.repeat(64)}`;

  // The test's own fact, not today's digest: a Dependabot base bump must not turn it red.
  // The real Dockerfile has exactly one slim FROM, pinned by a literal sha256 digest, and the
  // helper returns exactly that literal.
  it('is read from the literal in the runtime FROM of the real Dockerfile', () => {
    const dockerfile = readFileSync(resolve(root, 'deploy/image/Dockerfile'), 'utf8');
    const literal = dockerfile.split('\n').filter((l) => /^FROM \S*-slim[@:\s]/.test(l))
      .map((l) => l.split(/\s+/)[1].split('@')[1]);
    expect(literal).toEqual([expect.stringMatching(/^sha256:[0-9a-f]{64}$/)]);
    expect(run(dockerfile)).toEqual([0, `${literal[0]}\n`, '']);
  });

  it('is the one pinned slim FROM, whatever comes after it on the line', () => {
    expect(run(`FROM x/node:24-bookworm@${D2} AS build\nFROM x/node:24-bookworm-slim@${D1}\n`)).toEqual([0, `${D1}\n`, '']);
  });

  it.each([
    ['none', `FROM x/node:24-bookworm@${D2} AS build\n`],
    ['two', `FROM x/node:24-bookworm-slim@${D1}\nFROM x/node:24-bookworm-slim@${D2}\n`],
    ['a build arg instead of a literal', 'FROM x/node:24-bookworm-slim@${RUNTIME_BASE_DIGEST}\n'],
  ])('refuses %s', (_name, dockerfile) => {
    expect(run(dockerfile)[0]).toBe(1);
  });

  // CI reads the digest in a step of its own before the build, so a helper failure is a red
  // step with the helper's message, and an empty RUNTIME_BASE_DIGEST never reaches the build.
  const base = () => steps(job('image')).find((s) => s.head === '- name: Runtime base digest')!;
  const build = () => steps(job('image')).find((s) => s.head === '- name: Build image')!;

  it('is what CI passes as RUNTIME_BASE_DIGEST: the output of its own step, through the env', () => {
    expect([base().lines.map((l) => l.trim()).includes('id: base'), build().lines.map((l) => l.trim())])
      .toEqual([true, expect.arrayContaining([
        'RUNTIME_BASE_DIGEST: ${{ steps.base.outputs.digest }}',
        '--build-arg RUNTIME_BASE_DIGEST="$RUNTIME_BASE_DIGEST"',
      ])]);
    expect(build().lines.filter((l) => l.includes('image-base-digest.sh'))).toEqual([]);
  });

  // The step's own shell, run as Actions runs it (bash -eo pipefail) in a checkout whose helper
  // is the real one or one that fails.
  const runBase = (helper: string | null) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'wbb-base-step-'));
    try {
      mkdirSync(resolve(dir, 'scripts'));
      mkdirSync(resolve(dir, 'deploy/image'), { recursive: true });
      writeFileSync(resolve(dir, 'deploy/image/Dockerfile'), readFileSync(resolve(root, 'deploy/image/Dockerfile')));
      writeFileSync(resolve(dir, 'scripts/image-base-digest.sh'),
        helper ?? readFileSync(resolve(root, 'scripts/image-base-digest.sh'), 'utf8'), { mode: 0o755 });
      writeFileSync(resolve(dir, 'out'), '');
      const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', runBlock(base().lines)], {
        cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: resolve(dir, 'out') },
      });
      return [r.status, readFileSync(resolve(dir, 'out'), 'utf8')];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('CI step: writes the helper\'s digest as its output', () => {
    const digest = spawnSync('bash', [resolve(root, 'scripts/image-base-digest.sh'), resolve(root, 'deploy/image/Dockerfile')], { encoding: 'utf8' }).stdout.trim();
    expect(runBase(null)).toEqual([0, `digest=${digest}\n`]);
  });

  it.each([
    ['fails', '#!/bin/sh\necho "image-base-digest: boom" >&2\nexit 1\n'],
    ['prints nothing', '#!/bin/sh\nexit 0\n'],
    ['prints a non-digest', '#!/bin/sh\necho latest\n'],
  ])('CI step: the helper that %s fails the step and writes no output', (_name, helper) => {
    expect(runBase(helper)).toEqual([1, '']);
  });
});

// image-base-digest.sh reads only node:24-bookworm(-slim): a Dependabot PR to node 25/26 (both
// tags exist on the mirror) would break it. The docker ecosystem takes digest and minor bumps of
// 24 only; a Node major is a deliberate change (engines.node, host, CI legs together).
describe('dependabot docker updates', () => {
  it('ignore Node majors for the image bases', () => {
    const lines = readFileSync(resolve(root, '.github/dependabot.yml'), 'utf8').split('\n');
    const start = lines.indexOf('  - package-ecosystem: docker');
    const rest = lines.slice(start + 1);
    const section = rest.slice(0, rest.findIndex((l) => l.startsWith('  - package-ecosystem:'))).map((l) => l.trim());
    const at = section.indexOf('ignore:');
    expect([start > 0, section.slice(at, at + 3)]).toEqual([true, [
      'ignore:',
      '- dependency-name: node',
      'update-types: ["version-update:semver-major"]',
    ]]);
  });
});

// A main push publishes (push, attest, record): a newer push must queue behind it, not cancel it
// half-way. A PR's superseded run is still cancelled. The group is per ref, so main pushes
// queue among themselves only.
describe('ci.yml concurrency', () => {
  it('cancels in progress on a pull request only', () => {
    const at = workflow.indexOf('concurrency:');
    expect(workflow.slice(at, at + 3)).toEqual([
      'concurrency:',
      '  group: ci-${{ github.workflow }}-${{ github.ref }}',
      "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    ]);
  });
});

// The image's build context (deploy/image/Dockerfile copies the whole checkout): secrets and local
// state must not reach even the build stage, wherever they lie. Docker anchors a pattern at the
// context root (`*.db` misses data/bot.db), so this asks Docker itself: a scratch build copies the
// context, filtered by the real .dockerignore, out to a local directory.
const dockerUp = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 }).status === 0;
describe.skipIf(!dockerUp)('.dockerignore (as Docker applies it)', () => {
  const excluded = [
    'bot.db', 'data/bot.db', 'data/bot.db-wal', 'data/bot.db-shm',
    '.env', 'deploy/.env', '.env.local', '.env.production', '.env.example', 'scripts/.env.test',
    'migrate_env.sh', 'extension/warsaw-beer-bot-1.2.0.zip',
    'tmp/x.html', 'node_modules/x/index.js', 'dist/a.js', 'deploy/release/__pycache__/x.pyc',
  ];
  const kept = [
    '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.release.json', 'src/index.ts',
    'deploy/image/Dockerfile', 'deploy/release/package_runtime.py', 'deploy/litestream.env.example',
    'tests/fixtures/untappd/export.zip',
  ];

  it('keeps what the build needs and drops databases, env files, migrate_env.sh and extension zips at any depth', () => {
    const work = mkdtempSync(resolve(tmpdir(), 'wbb-dockerignore-'));
    try {
      const ctx = resolve(work, 'ctx');
      for (const f of [...excluded, ...kept.slice(1)]) {
        mkdirSync(resolve(ctx, f, '..'), { recursive: true });
        writeFileSync(resolve(ctx, f), 'x');
      }
      writeFileSync(resolve(ctx, '.dockerignore'), readFileSync(resolve(root, '.dockerignore')));
      const r = spawnSync('docker', ['buildx', 'build', '-q', '-f', '-', '--output', `type=local,dest=${resolve(work, 'out')}`, ctx], {
        input: 'FROM scratch\nCOPY . /\n', encoding: 'utf8', timeout: 60_000,
      });
      expect(r.status, r.stderr).toBe(0);
      const listed = readdirSync(resolve(work, 'out'), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile()).map((e) => resolve(e.parentPath, e.name).slice(resolve(work, 'out').length + 1)).sort();
      expect(listed).toEqual([...kept].sort());
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 70_000);
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
