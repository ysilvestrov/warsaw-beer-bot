import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * deploy/install-image.sh — the installer of the root helper wbb-image (plan
 * docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md, Task 4), run with
 * WBB_IMAGE_DESTDIR and stub `visudo`/`quadlet` on PATH: what it installs, with which modes,
 * what `--check` reports, and that a failing check of the sudoers rules or of the template
 * installs nothing.
 */
const ROOT = resolve(__dirname, '..');
const SCRIPT = join(ROOT, 'deploy/install-image.sh');
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'wbb-install-image-'));
  dirs.push(d);
  return d;
}

const INSTALLED: Array<[string, string, string]> = [
  ['deploy/image/helper/bounded.py', '/usr/local/lib/wbb-image/bounded.py', '644'],
  ['deploy/image/helper/wbb_image.py', '/usr/local/lib/wbb-image/wbb_image.py', '644'],
  ['deploy/image/warsaw-beer-bot.container', '/usr/local/lib/wbb-image/warsaw-beer-bot.container', '644'],
  ['deploy/image/helper/wbb-image.sh', '/usr/local/libexec/wbb-image', '755'],
  ['deploy/sudoers.d/wbb-image', '/etc/sudoers.d/wbb-image', '440'],
];

interface Setup { dest: string; log: string; env: Record<string, string> }

/** A DESTDIR and stub visudo/quadlet that log their argv (and quadlet the unit it was given). */
function setup(stub: { visudoExit?: number; quadletExit?: number; quadletStderr?: string } = {}): Setup {
  const dir = scratch();
  const dest = join(dir, 'dest');
  const bin = join(dir, 'bin');
  const log = join(dir, 'log');
  mkdirSync(dest);
  mkdirSync(bin);
  writeFileSync(log, '');
  writeFileSync(join(bin, 'visudo'), '#!/bin/sh\necho "visudo $*" >> "$STUB_LOG"\nexit "${VISUDO_EXIT:-0}"\n');
  writeFileSync(join(bin, 'quadlet'), [
    '#!/bin/sh',
    'echo "quadlet $*" >> "$STUB_LOG"',
    'cat "$QUADLET_UNIT_DIRS"/warsaw-beer-bot.container >> "$STUB_LOG"',
    'printf "%s" "$QUADLET_STDERR" >&2',
    'echo "---warsaw-beer-bot.service---"',
    'exit "${QUADLET_EXIT:-0}"',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'visudo'), 0o755);
  chmodSync(join(bin, 'quadlet'), 0o755);
  return {
    dest,
    log,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ...GIT_ENV,
      WBB_IMAGE_DESTDIR: dest,
      STUB_LOG: log,
      VISUDO_EXIT: String(stub.visudoExit ?? 0),
      QUADLET_EXIT: String(stub.quadletExit ?? 0),
      QUADLET_STDERR: stub.quadletStderr ?? '',
    },
  };
}

function run(s: Setup, args: string[] = []) {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: s.env, timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// The local gate runs as another user than the checkout's owner, where git refuses the repo
// (safe.directory); CI owns its checkout. Command-line config via the environment, for git only.
const GIT_ENV = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: ROOT };

/** HEAD's bytes of a repo file: what the installer installs, whatever the worktree holds. */
function head(path: string): Buffer {
  return spawnSync('git', ['show', `HEAD:${path}`], { cwd: ROOT, env: { ...process.env, ...GIT_ENV }, maxBuffer: 16 << 20 }).stdout;
}

const HEAD_SHORT = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).stdout.trim();

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

describe('install-image.sh', () => {
  test('installs HEAD\'s bytes of every file with its mode, and the scratch directory 0700', () => {
    const s = setup();
    const r = run(s);
    expect(r.status, r.stderr).toBe(0);
    expect(INSTALLED.map(([src, target]) => [
      target, mode(join(s.dest, target)), readFileSync(join(s.dest, target)).equals(head(src)),
    ])).toEqual(INSTALLED.map(([, target, m]) => [target, m, true]));
    expect(mode(join(s.dest, '/var/lib/wbb-image'))).toBe('700');
  });

  test('checks the sudoers rules and dry-runs the template filled in like activate fills it', () => {
    const s = setup();
    run(s);
    const log = readFileSync(s.log, 'utf8').split('\n');
    const template = head('deploy/image/warsaw-beer-bot.container').toString('utf8').split('\n');
    expect(log[0]).toMatch(/^visudo -cf \/\S+\/deploy\/sudoers\.d\/wbb-image$/);
    expect(log[1]).toBe('quadlet -dryrun');
    const rendered = log.slice(2, 2 + template.length);
    expect([
      rendered.filter((l) => l.startsWith('Image=')),
      rendered.filter((l) => l.includes('@@')),
      rendered.length,
    ]).toEqual([[`Image=ghcr.io/ysilvestrov/warsaw-beer-bot@sha256:${'0'.repeat(64)}`], [], template.length]);
  });

  test('--check right after an install is clean', () => {
    const s = setup();
    run(s);
    const r = run(s, ['--check']);
    expect([r.status, r.stdout]).toEqual([0, `wbb-image: every installed copy matches HEAD ${HEAD_SHORT}\n`]);
  });

  test('--check names a changed copy and a wrong mode, and exits 1', () => {
    const s = setup();
    run(s);
    writeFileSync(join(s.dest, '/usr/local/lib/wbb-image/wbb_image.py'), '# edited on the host\n');
    chmodSync(join(s.dest, '/usr/local/libexec/wbb-image'), 0o700);
    const r = run(s, ['--check']);
    expect([r.status, r.stdout]).toEqual([1, [
      'DIFFERS: /usr/local/lib/wbb-image/wbb_image.py (content)',
      'DIFFERS: /usr/local/libexec/wbb-image (mode 700, want 755)',
      '2 difference(s): sudo bash deploy/install-image.sh',
      '',
    ].join('\n')]);
  });

  test('--check on a host where nothing is installed lists every file and both directories, and writes nothing', () => {
    const s = setup();
    const r = run(s, ['--check']);
    expect([r.status, r.stdout.split('\n').length - 2, existsSync(join(s.dest, 'usr')), readFileSync(s.log, 'utf8')])
      .toEqual([1, INSTALLED.length + 2, false, '']);
  });

  test('sudoers rules that visudo rejects install nothing', () => {
    const s = setup({ visudoExit: 1 });
    const r = run(s);
    expect([r.status, existsSync(join(s.dest, 'usr')), existsSync(join(s.dest, 'etc'))]).toEqual([1, false, false]);
  });

  test.each([
    ['a key this podman does not know', { quadletStderr: 'converting "warsaw-beer-bot.container": unsupported key \'StopTimeout\'' }],
    ['a failing dry run', { quadletExit: 1 }],
  ])('%s installs nothing', (_name, stub) => {
    const s = setup(stub);
    const r = run(s);
    expect([r.status, r.stderr.split('\n')[0], existsSync(join(s.dest, 'usr')), existsSync(join(s.dest, 'etc'))])
      .toEqual([1, 'ERROR: quadlet -dryrun does not accept deploy/image/warsaw-beer-bot.container on this host:', false, false]);
  });

  test.each([[['--force']], [['--check', '--check']]])('usage %j exits 64 and writes nothing', (args) => {
    const s = setup();
    const r = run(s, args);
    expect([r.status, existsSync(join(s.dest, 'usr')), readFileSync(s.log, 'utf8')]).toEqual([64, false, '']);
  });
});
