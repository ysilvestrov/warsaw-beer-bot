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
 * A DESTDIR; `install` on PATH logging each target before the real one runs; systemctl, the image
 * check and installed-current as stubs that log their argv. SUDO_USER is the user running the test, so
 * the operator's home is its real home under the DESTDIR. `withState` puts its image-state.env there.
 */
function setup(o: { checkExit?: number; currentExit?: number; enabled?: string; active?: string; withState?: boolean } = {}): Setup {
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
  exe('systemctl', [
    'echo "systemctl $*" >> "$STUB_LOG"',
    `case "$1" in is-enabled) echo "${o.enabled ?? 'disabled'}" ;; is-active) echo "${o.active ?? 'inactive'}" ;; esac`,
  ].join('\n'));
  exe('image-check', `echo "image-check $*" >> "$STUB_LOG"; echo "wbb-image: every installed copy matches HEAD 1234567"; exit ${o.checkExit ?? 0}`);
  exe('installed-current', `echo "installed-current $*" >> "$STUB_LOG"; echo "CURRENT: 8 installed file(s)"; exit ${o.currentExit ?? 0}`);
  const imageState = join(dest, OPERATOR.homedir, '.local/state/wbb-autodeploy/image-state.env');
  if (o.withState === true) {
    mkdirSync(join(imageState, '..'), { recursive: true });
    writeFileSync(imageState, 'DEPLOYED_SHA=x\n');
  }
  return {
    dest,
    log,
    imageState,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ...GIT_ENV,
      WBB_AUTODEPLOY_DESTDIR: dest,
      WBB_SYSTEMCTL_CMD: join(bin, 'systemctl'),
      WBB_IMAGE_CHECK_CMD: join(bin, 'image-check'),
      WBB_INSTALLED_CURRENT_CMD: join(bin, 'installed-current'),
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
/** Every file under the DESTDIR but the operator's home (the test's own image-state.env). */
function files(root: string, rel = ''): string[] {
  return existsSync(join(root, rel))
    ? readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
      (e.isDirectory() ? files(root, join(rel, e.name)) : [`/${join(rel, e.name)}`]))
      .filter((f) => !f.startsWith(OPERATOR.homedir))
    : [];
}

const HEAD_SHA = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).stdout.trim();
const STATE = join(OPERATOR.homedir, '.local/state/wbb-autodeploy/image-state.env');
const ADVICE = `No ${STATE} yet: the migration comes first (bash deploy/migrate-state-to-image.sh, as ${OPERATOR.username}, with the\n`
  + 'timer stopped), then the bootstrap (bash deploy/deploy.sh --bootstrap); until then the timer deploys nothing.\n';

describe('install-autodeploy.sh', () => {
  test('installs exactly the four scripts, the unit and the timer: HEAD\'s bytes, with their modes', () => {
    const s = setup();
    const r = run(s);
    expect(r.status, r.stderr).toBe(0);
    expect(files(s.dest).sort()).toEqual(INSTALLED.map(([, t]) => t).sort());
    expect(INSTALLED.map(([src, t]) => [t, mode(join(s.dest, t)), readFileSync(join(s.dest, t)).equals(head(src))]))
      .toEqual(INSTALLED.map(([, t, m]) => [t, m, true]));
  });

  test('reads the timer, asks the image check, installs the dependencies before the controller, reloads, checks the copies', () => {
    const s = setup();
    run(s);
    const d = s.dest;
    expect(lines(s.log)).toEqual([
      // No image-state.env in this setup: a timer that is not active is also asked whether it is enabled.
      'systemctl is-active wbb-autodeploy.timer',
      'systemctl is-enabled wbb-autodeploy.timer',
      'image-check ',
      ...INSTALLED.map(([, t]) => `install ${join(d, t)}`),
      'systemctl daemon-reload',
      // Plan п.14: the controller's own pairs (its installed_is_stale), against HEAD.
      `installed-current ${ROOT} ${HEAD_SHA} deploy/autodeploy.sh=${d}/usr/local/bin/wbb-autodeploy`
        + ` deploy/read-env.sh=${d}/usr/local/bin/wbb-read-env deploy/db-snapshot.sh=${d}/usr/local/bin/wbb-db-snapshot`
        + ` deploy/installed-current.sh=${d}/usr/local/bin/wbb-installed-current`
        + ` deploy/image/helper/wbb_image.py=${d}/usr/local/lib/wbb-image/wbb_image.py`
        + ` deploy/image/helper/bounded.py=${d}/usr/local/lib/wbb-image/bounded.py`
        + ` deploy/image/helper/wbb-image.sh=${d}/usr/local/libexec/wbb-image`
        + ` deploy/image/warsaw-beer-bot.container=${d}/usr/local/lib/wbb-image/warsaw-beer-bot.container`,
      'systemctl is-enabled wbb-autodeploy.timer',
    ]);
  });

  test('installed copies that do not match HEAD after the install: exit 1 with the check\'s output', () => {
    const s = setup({ currentExit: 1 });
    const r = run(s);
    expect([r.status, r.stderr]).toEqual([1, `ERROR: the installed copies do not match HEAD ${HEAD_SHA.slice(0, 7)} after the install:\nCURRENT: 8 installed file(s)\n`]);
  });

  test('a failing image check installs nothing, shows its output and the way to fix it', () => {
    const s = setup({ checkExit: 1 });
    const r = run(s);
    expect([r.status, files(s.dest), lines(s.log)]).toEqual([1, [], ['systemctl is-active wbb-autodeploy.timer', 'systemctl is-enabled wbb-autodeploy.timer', 'image-check ']]);
    expect(r.stderr).toBe(
      'ERROR: the image helper is not installed as this checkout has it — the controller would only wait for it. Nothing was installed.\n'
      + 'wbb-image: every installed copy matches HEAD 1234567\n'
      + 'Run: sudo bash deploy/install-image.sh, then this again.\n');
  });

  // Plan п.11: the first tick of the new controller would write an image-state.env of its own.
  test('an active timer and no image-state.env: refused, nothing installed', () => {
    const s = setup({ active: 'active', enabled: 'enabled' });
    const r = run(s);
    expect([r.status, files(s.dest), lines(s.log)]).toEqual([1, [], ['systemctl is-active wbb-autodeploy.timer']]);
    expect(r.stderr).toBe(
      `ERROR: the timer is active and there is no ${STATE} — the first tick of the new controller would write its own image-state.env, `
      + 'and the migration would then refuse for good. Nothing was installed.\n'
      + 'Stop it (sudo systemctl disable --now wbb-autodeploy.timer), migrate the state (bash deploy/migrate-state-to-image.sh, as the operator), install the helper (sudo bash deploy/install-image.sh), then run this again (deploy/README.md → Switchover session, steps 2–7).\n');
  });

  // #911 AI review: enabled but not running is armed all the same — a reboot starts it with the new copy.
  test('an enabled timer that is not running and no image-state.env: refused, nothing installed', () => {
    const s = setup({ active: 'inactive', enabled: 'enabled' });
    const r = run(s);
    expect([r.status, files(s.dest), lines(s.log)]).toEqual([1, [],
      ['systemctl is-active wbb-autodeploy.timer', 'systemctl is-enabled wbb-autodeploy.timer']]);
    expect(r.stderr.split('\n')[0]).toBe(
      `ERROR: the timer is enabled and there is no ${STATE} — the first tick of the new controller would write its own image-state.env, `
      + 'and the migration would then refuse for good. Nothing was installed.');
  });

  test('an active timer and an operator it cannot tell: refused, nothing installed', () => {
    const s = setup({ active: 'active', withState: true });
    const r = run(s, [], { SUDO_USER: '' });
    expect([r.status, files(s.dest), r.stderr.split('\n')[0]]).toEqual([1, [],
      'ERROR: the timer is active and the operator cannot be told (SUDO_USER), so its image-state.env cannot be checked — the first tick '
      + 'of the new controller would write its own image-state.env, and the migration would then refuse for good. Nothing was installed.']);
  });

  test('an active timer with the image-state.env present: installs, and says the timer runs the new copy', () => {
    const s = setup({ active: 'active', enabled: 'enabled', withState: true });
    const r = run(s);
    expect([r.status, files(s.dest).length, r.stdout.includes('No ')]).toEqual([0, INSTALLED.length, false]);
    expect(r.stdout).toContain([
      'wbb-autodeploy.timer: enabled, active', '',
      'The timer is ARMED and now runs the newly installed copy.',
      'Emergency stop, no password needed:',
      '  touch ~/.local/state/wbb-autodeploy/PAUSED', '',
    ].join('\n'));
  });

  test('an enabled but stopped timer with the image-state.env present: installs; says a boot starts it; not "ARMED"', () => {
    const s = setup({ enabled: 'enabled', active: 'inactive', withState: true });
    const r = run(s);
    expect([r.status, files(s.dest).length, r.stdout.includes('ARMED')]).toEqual([0, INSTALLED.length, false]);
    expect(r.stdout).toContain('wbb-autodeploy.timer: enabled, inactive\n\nThe timer is enabled but not running: it starts with the next boot, or now with\n'
      + '  sudo systemctl start wbb-autodeploy.timer\n');
  });

  test('never enables, disables, starts or stops the timer', () => {
    const s = setup({ enabled: 'enabled', active: 'active', withState: true });
    run(s);
    expect(lines(s.log).filter((l) => l.startsWith('systemctl '))).toEqual([
      'systemctl is-active wbb-autodeploy.timer', 'systemctl daemon-reload', 'systemctl is-enabled wbb-autodeploy.timer',
    ]);
  });

  test('a disabled timer: says how to arm it', () => {
    const s = setup();
    expect(run(s).stdout).toContain('wbb-autodeploy.timer: disabled, inactive\n\nThe timer is not armed. Nothing will deploy until:\n'
      + '  sudo systemctl enable --now wbb-autodeploy.timer\n');
  });

  test('with the operator\'s image-state.env: no advice about it', () => {
    const s = setup({ withState: true });
    const r = run(s);
    expect([r.status, r.stdout.includes('image-state.env'), r.stdout.includes('migrate-state-to-image')]).toEqual([0, false, false]);
  });

  test.each([['SUDO_USER unset', ''], ['SUDO_USER root', 'root']])('%s, timer stopped: installs, and says it cannot tell the operator', (_name, user) => {
    const s = setup();
    const r = run(s, [], { SUDO_USER: user });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'Cannot tell the operator (SUDO_USER is not set, or has no home): check that the operator\'s\n'
      + '~/.local/state/wbb-autodeploy/image-state.env exists. If it does not, migrate the state first\n'
      + '(bash deploy/migrate-state-to-image.sh, as the operator, with the timer stopped), then the bootstrap; until then the timer deploys nothing.\n');
  });

  test('takes no arguments (64), installing nothing', () => {
    const s = setup();
    const r = run(s, ['--force']);
    expect([r.status, files(s.dest), lines(s.log)]).toEqual([64, [], []]);
  });
});
