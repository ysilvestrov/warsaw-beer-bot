import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  stub('systemctl', `echo "systemctl $*" >> "${log}"`);
  return { root, bin, log };
}

function run(h: Host, opts: { hostRoot?: boolean; cwd?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${h.bin}:${process.env.PATH}`, WBB_HOST_ROOT: h.root };
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
      'ExecStart=/usr/bin/python3 -B /usr/local/libexec/wbb-host-patch-collect',
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
