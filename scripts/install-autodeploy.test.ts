import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * deploy/install-autodeploy.sh — the installer of merge-deploy's image controller (plan
 * docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-core.md, "Рішення" п.4, Task 3),
 * run with WBB_AUTODEPLOY_DESTDIR, a stub systemctl and a stub image check: what it installs, in which
 * order, with which modes and bytes; that a failing image check installs nothing; the advice about
 * image-state.env; and that the timer is never enabled.
 */
const ROOT = resolve(__dirname, '..');
const SCRIPT = join(ROOT, 'deploy/install-autodeploy.sh');
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** In install order: the three the controller calls, the controller, the unit, the timer. */
const INSTALLED: Array<[string, string, string]> = [
  ['deploy/db-snapshot.sh', '/usr/local/bin/wbb-db-snapshot', '755'],
  ['deploy/read-env.sh', '/usr/local/bin/wbb-read-env', '755'],
  ['deploy/installed-current.sh', '/usr/local/bin/wbb-installed-current', '755'],
  ['deploy/autodeploy.sh', '/usr/local/bin/wbb-autodeploy', '755'],
  ['deploy/wbb-autodeploy.service', '/etc/systemd/system/wbb-autodeploy.service', '644'],
  ['deploy/wbb-autodeploy.timer', '/etc/systemd/system/wbb-autodeploy.timer', '644'],
];

// The local gate runs as another user than the checkout's owner, where git refuses the repo
// (safe.directory); CI owns its checkout. Command-line config via the environment, for git only.
const GIT_ENV = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: ROOT };

function head(path: string): Buffer {
  return spawnSync('git', ['show', `HEAD:${path}`], { cwd: ROOT, env: { ...process.env, ...GIT_ENV }, maxBuffer: 16 << 20 }).stdout;
}

const OPERATOR = userInfo();

interface Setup { dest: string; log: string; env: Record<string, string>; imageState: string }

/**
 * A DESTDIR; `install` on PATH logging each target before the real one runs; systemctl and the image
 * check as stubs that log their argv. SUDO_USER is the user running the test, so the operator's home is
 * its real home under the DESTDIR.
 */
function setup(o: { checkExit?: number; enabled?: string } = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-install-autodeploy-'));
  dirs.push(dir);
  const dest = join(dir, 'dest');
  const bin = join(dir, 'bin');
  const log = join(dir, 'log');
  mkdirSync(dest);
  mkdirSync(bin);
  writeFileSync(log, '');
  const exe = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  exe('install', `echo "install \${@: -1}" >> "$STUB_LOG"; exec /usr/bin/install "$@"`);
  exe('systemctl', `echo "systemctl $*" >> "$STUB_LOG"; [ "$1" != is-enabled ] || echo "${o.enabled ?? 'disabled'}"`);
  exe('image-check', `echo "image-check $*" >> "$STUB_LOG"; echo "wbb-image: every installed copy matches HEAD 1234567"; exit ${o.checkExit ?? 0}`);
  return {
    dest,
    log,
    imageState: join(dest, OPERATOR.homedir, '.local/state/wbb-autodeploy/image-state.env'),
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ...GIT_ENV,
      WBB_AUTODEPLOY_DESTDIR: dest,
      WBB_SYSTEMCTL_CMD: join(bin, 'systemctl'),
      WBB_IMAGE_CHECK_CMD: join(bin, 'image-check'),
      SUDO_USER: OPERATOR.username,
      STUB_LOG: log,
    },
  };
}

function run(s: Setup, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...s.env, ...env }, timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const lines = (p: string) => readFileSync(p, 'utf8').split('\n').filter((l) => l !== '');
/** Every file under the DESTDIR. */
function files(root: string, rel = ''): string[] {
  return existsSync(join(root, rel))
    ? readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
      (e.isDirectory() ? files(root, join(rel, e.name)) : [`/${join(rel, e.name)}`]))
    : [];
}

describe('install-autodeploy.sh', () => {
  test('installs exactly the four scripts, the unit and the timer: HEAD\'s bytes, with their modes', () => {
    const s = setup();
    const r = run(s);
    expect(r.status, r.stderr).toBe(0);
    expect(files(s.dest).sort()).toEqual(INSTALLED.map(([, t]) => t).sort());
    expect(INSTALLED.map(([src, t]) => [t, mode(join(s.dest, t)), readFileSync(join(s.dest, t)).equals(head(src))]))
      .toEqual(INSTALLED.map(([, t, m]) => [t, m, true]));
  });

  test('asks the image check first, installs the dependencies before the controller, then reloads systemd', () => {
    const s = setup();
    run(s);
    expect(lines(s.log)).toEqual([
      'image-check ',
      ...INSTALLED.map(([, t]) => `install ${join(s.dest, t)}`),
      'systemctl daemon-reload',
      'systemctl is-enabled wbb-autodeploy.timer',
    ]);
  });

  test('never enables or disables the timer, armed or not, and says how to stop it when armed', () => {
    const s = setup({ enabled: 'enabled' });
    const r = run(s);
    expect(lines(s.log).filter((l) => l.startsWith('systemctl '))).toEqual([
      'systemctl daemon-reload', 'systemctl is-enabled wbb-autodeploy.timer',
    ]);
    expect(r.stdout).toContain([
      'wbb-autodeploy.timer: enabled', '',
      'The timer is ARMED and now runs the newly installed copy.',
      'Emergency stop, no password needed:',
      '  touch ~/.local/state/wbb-autodeploy/PAUSED', '',
    ].join('\n'));
  });

  test('a failing image check installs nothing, shows its output and the way to fix it', () => {
    const s = setup({ checkExit: 1 });
    const r = run(s);
    expect([r.status, files(s.dest), lines(s.log)]).toEqual([1, [], ['image-check ']]);
    expect(r.stderr).toBe(
      'ERROR: the image helper is not installed as this checkout has it — the controller would only wait for it. Nothing was installed.\n'
      + 'wbb-image: every installed copy matches HEAD 1234567\n'
      + 'Run: sudo bash deploy/install-image.sh, then this again.\n');
  });

  test('without the operator\'s image-state.env: says to migrate the state and bootstrap', () => {
    const s = setup();
    const state = join(OPERATOR.homedir, '.local/state/wbb-autodeploy/image-state.env');
    expect(run(s).stdout).toContain(
      `No ${state} yet: migrate the state (bash deploy/migrate-state-to-image.sh, as ${OPERATOR.username}, with the\n`
      + 'timer stopped) and run the bootstrap (bash deploy/deploy.sh --bootstrap); until then the timer deploys nothing.\n');
  });

  test('with the operator\'s image-state.env: no advice about it', () => {
    const s = setup();
    mkdirSync(join(s.imageState, '..'), { recursive: true });
    writeFileSync(s.imageState, 'DEPLOYED_SHA=x\n');
    const r = run(s);
    expect([r.status, r.stdout.includes('image-state.env'), r.stdout.includes('migrate-state-to-image')]).toEqual([0, false, false]);
  });

  test.each([['SUDO_USER unset', ''], ['SUDO_USER root', 'root']])('%s: says it cannot tell the operator', (_name, user) => {
    const s = setup();
    expect(run(s, [], { SUDO_USER: user }).stdout).toContain(
      'Cannot tell the operator (SUDO_USER is not set, or has no home): check that the operator\'s\n'
      + '~/.local/state/wbb-autodeploy/image-state.env exists. If it does not, migrate the state\n'
      + '(bash deploy/migrate-state-to-image.sh, as the operator) and run the bootstrap; until then the timer deploys nothing.\n');
  });

  test('takes no arguments (64), installing nothing', () => {
    const s = setup();
    const r = run(s, ['--force']);
    expect([r.status, files(s.dest), lines(s.log)]).toEqual([64, [], []]);
  });
});
