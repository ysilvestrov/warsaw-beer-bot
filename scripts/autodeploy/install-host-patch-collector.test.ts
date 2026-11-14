import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';

/** #469 stage 2 periphery — spec 2026-10-06-469-host-patching-design.md. */
const REPO = resolve(__dirname, '../..');
const SCRIPT = join(REPO, 'deploy/install-host-patch-collector.sh');

interface Host { root: string; bin: string; log: string }

function host(opts: { uid?: string } = {}): Host {
  const dir = makeTempDirectory('wbb-hostpatch-collector-');
  const root = join(dir, 'root');
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(join(root, 'var/tmp'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(log, '');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('id', `echo ${opts.uid ?? '0'}`);
  // `show -p User` answers as wbb-autodeploy.service would: STUB_AUTODEPLOY_USER (empty: no such unit).
  stub('systemctl', `echo "systemctl $*" >> "${log}"; if [ "$1" = show ]; then echo "\${STUB_AUTODEPLOY_USER:-}"; fi`);
  return { root, bin, log };
}

/** SUDO_USER is the user running the test by default, so its real home names the image-state.env. */
const OPERATOR = userInfo();

function run(h: Host, opts: { hostRoot?: boolean; cwd?: string; sudoUser?: string; autodeployUser?: string } = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${h.bin}:${process.env.PATH}`, WBB_HOST_ROOT: h.root, SUDO_USER: opts.sudoUser ?? OPERATOR.username,
    STUB_AUTODEPLOY_USER: opts.autodeployUser ?? '',
  };
  if (opts.hostRoot === false) delete env.WBB_HOST_ROOT;
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env, cwd: opts.cwd ?? REPO });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const calls = (h: Host) => readFileSync(h.log, 'utf8').trim().split('\n').filter((l) => l !== '');
const at = (h: Host, p: string) => join(h.root, p);
const mode = (p: string) => statSync(p).mode & 0o7777;

const COLLECTOR = 'usr/local/libexec/wbb-host-patch-collect';
const SERVICE = 'etc/systemd/system/wbb-host-patch.service';
const TIMER = 'etc/systemd/system/wbb-host-patch.timer';
const OUT = 'var/tmp/wbb-host-patch';
const DROPIN = 'etc/systemd/system/wbb-host-patch.service.d/image-state.conf';

describe('install-host-patch-collector — a clean host', () => {
  it('installs the collector 0755 and both units 0644, byte for byte', () => {
    const h = host();
    expect(run(h).code).toBe(0);
    expect(readFileSync(at(h, COLLECTOR))).toEqual(readFileSync(join(REPO, 'scripts/ops/host_patch_collect.py')));
    expect(readFileSync(at(h, SERVICE))).toEqual(readFileSync(join(REPO, 'deploy/wbb-host-patch.service')));
    expect(readFileSync(at(h, TIMER))).toEqual(readFileSync(join(REPO, 'deploy/wbb-host-patch.timer')));
    expect([mode(at(h, COLLECTOR)), mode(at(h, SERVICE)), mode(at(h, TIMER))]).toEqual([0o755, 0o644, 0o644]);
  });

  it('creates the summary directory 0755', () => {
    const h = host();
    run(h);
    expect([statSync(at(h, OUT)).isDirectory(), mode(at(h, OUT))]).toEqual([true, 0o755]);
  });

  it('reloads, enables and re-arms the timer, then runs the collector once, in that order', () => {
    const h = host();
    run(h);
    expect(calls(h)).toEqual([
      'systemctl show -p User --value wbb-autodeploy.service',
      'systemctl daemon-reload',
      'systemctl enable --now wbb-host-patch.timer',
      'systemctl restart wbb-host-patch.timer',
      'systemctl start wbb-host-patch.service',
    ]);
  });

  it('runs from any directory, not only the repo root', () => {
    const h = host();
    const elsewhere = makeTempDirectory('wbb-hostpatch-cwd-');
    expect(run(h, { cwd: elsewhere }).code).toBe(0);
    expect(readFileSync(at(h, COLLECTOR))).toEqual(readFileSync(join(REPO, 'scripts/ops/host_patch_collect.py')));
  });

  it('leaves an existing summary directory alone: no chmod through a path it did not create', () => {
    const h = host();
    mkdirSync(at(h, OUT), { mode: 0o700 });
    chmodSync(at(h, OUT), 0o700);
    expect(run(h).code).toBe(0);
    expect(mode(at(h, OUT))).toBe(0o700);
  });

  it('names the operator\'s image-state.env in a 0644 drop-in of the service', () => {
    const h = host();
    expect(run(h).code).toBe(0);
    expect([readFileSync(at(h, DROPIN), 'utf8'), mode(at(h, DROPIN)), mode(join(at(h, DROPIN), '..'))]).toEqual([
      '# install-host-patch-collector.sh: the image-state.env of the operator who ran it.\n'
      + `[Service]\nEnvironment=WBB_IMAGE_STATE=${OPERATOR.homedir}/.local/state/wbb-autodeploy/image-state.env\n`,
      0o644, 0o755,
    ]);
  });

  it('writes the drop-in before the reload, so the first run already reads the image-state.env', () => {
    const h = host();
    writeFileSync(join(h.bin, 'systemctl'), `#!/usr/bin/env bash\necho "systemctl $* $(test -e '${at(h, DROPIN)}' && echo dropin)" >> "${h.log}"\n`);
    run(h);
    expect(calls(h).slice(0, 2)).toEqual(['systemctl show -p User --value wbb-autodeploy.service ', 'systemctl daemon-reload dropin']);
  });

  it.each([['SUDO_USER unset', ''], ['SUDO_USER root', 'root']])('%s: installs without a drop-in and says the deployed image is unknown', (_n, user) => {
    const h = host();
    const r = run(h, { sudoUser: user });
    expect([r.code, existsSync(at(h, DROPIN)), existsSync(at(h, COLLECTOR))]).toEqual([0, false, true]);
    expect(r.out).toContain('the operator cannot be told (SUDO_USER is not set, or has no home): no image-state.env, the status shows the deployed image as unknown');
  });

  it('warns, and still installs, when wbb-autodeploy.service runs as another user than SUDO_USER', () => {
    const h = host();
    const r = run(h, { autodeployUser: 'someone-else' });
    expect([r.code, existsSync(at(h, DROPIN))]).toEqual([0, true]);
    expect(r.err).toBe(`WARNING: wbb-autodeploy.service runs as someone-else, but this install names the image-state.env of ${OPERATOR.username} `
      + `(${OPERATOR.homedir}/.local/state/wbb-autodeploy/image-state.env): the status will show the deployed image of a state nobody writes. `
      + 'Re-run as someone-else (sudo from that account) if that is the operator.\n');
  });

  it.each([['runs as the operator', OPERATOR.username], ['does not exist', '']])('says nothing when wbb-autodeploy.service %s', (_n, user) => {
    const h = host();
    const r = run(h, { autodeployUser: user });
    expect([r.code, r.err]).toEqual([0, '']);
  });

  it('without an operator keeps the drop-in an earlier install wrote', () => {
    const h = host();
    run(h);
    const before = readFileSync(at(h, DROPIN), 'utf8');
    const r = run(h, { sudoUser: '' });
    expect([r.code, readFileSync(at(h, DROPIN), 'utf8')]).toEqual([0, before]);
    expect(r.out).toContain('/etc/systemd/system/wbb-host-patch.service.d/image-state.conf kept as it was');
  });

  it('is idempotent', () => {
    const h = host();
    expect([run(h).code, run(h).code]).toEqual([0, 0]);
    expect(mode(at(h, OUT))).toBe(0o755);
  });
});

describe('install-host-patch-collector — refusals change nothing', () => {
  it('refuses without root', () => {
    const h = host({ uid: '1000' });
    const r = run(h, { hostRoot: false });
    expect([r.code, r.err.includes('run as root'), existsSync(at(h, COLLECTOR)), calls(h)]).toEqual([1, true, false, []]);
  });

  it('refuses a squatted summary path that is a symlink', () => {
    const h = host();
    mkdirSync(at(h, 'elsewhere'));
    symlinkSync(at(h, 'elsewhere'), at(h, OUT));
    const r = run(h);
    expect([r.code, r.err.includes('/var/tmp/wbb-host-patch'), existsSync(at(h, COLLECTOR)), calls(h)]).toEqual([1, true, false, []]);
  });

  it.each(['/home/o p', '/home/%n', '/home/$x', '/home/o"p'])('refuses an operator home %j a unit value cannot hold, before installing anything', (home) => {
    const h = host();
    writeFileSync(join(h.bin, 'getent'), `#!/usr/bin/env bash\necho 'op:x:1000:1000::${home}:/bin/bash'\n`);
    chmodSync(join(h.bin, 'getent'), 0o755);
    const r = run(h, { sudoUser: 'op' });
    expect([r.code, r.err.includes('has a character a unit value cannot hold'), existsSync(at(h, COLLECTOR)), existsSync(at(h, DROPIN)), calls(h)])
      .toEqual([1, true, false, false, []]);
  });

  it('refuses a squatted summary path that is a plain file', () => {
    const h = host();
    writeFileSync(at(h, OUT), '');
    const r = run(h);
    expect([r.code, existsSync(at(h, COLLECTOR)), calls(h)]).toEqual([1, false, []]);
  });
});

/** The units' directives, comments and blank lines dropped, per section. */
function directives(path: string, section: string): string[] {
  return readFileSync(join(REPO, path), 'utf8').split(`[${section}]`)[1].split('\n[')[0]
    .split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
}

describe('the units', () => {
  it('the service is a 15-minute oneshot running the installed collector, unsandboxed', () => {
    expect(directives('deploy/wbb-host-patch.service', 'Service')).toEqual([
      'Type=oneshot',
      'Environment=WBB_IMAGE_STATE=',
      'ExecStart=/usr/bin/python3 -B /usr/local/libexec/wbb-host-patch-collect --image-state=${WBB_IMAGE_STATE}',
      'TimeoutStartSec=15min',
      'Nice=10',
    ]);
  });

  it('the timer fires from its own activation, hourly, with no boot clock and no stamp (#798)', () => {
    expect(directives('deploy/wbb-host-patch.timer', 'Timer')).toEqual([
      'OnActiveSec=2min',
      'OnUnitActiveSec=1h',
      'RandomizedDelaySec=5min',
    ]);
  });
});
