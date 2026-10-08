import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** #469 stage 3 periphery — spec 2026-10-06-469-host-patching-design.md (Stage 3). */
const REPO = resolve(__dirname, '../..');
const SCRIPT = join(REPO, 'deploy/install-reboot-request.sh');

interface Host { root: string; bin: string; log: string }

function host(opts: { uid?: string } = {}): Host {
  const dir = makeTempDirectory('wbb-reboot-request-');
  const root = join(dir, 'root');
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(join(root, 'var/lib'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(log, '');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('id', `echo ${opts.uid ?? '0'}`);
  stub('systemctl', `echo "systemctl $*" >> "${log}"`);
  // chown needs root; the stub records the call (as `chown <owner> <path relative to the host root>`).
  stub('chown', `echo "chown $1 \${2#${root}}" >> "${log}"`);
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

const HANDLER = 'usr/local/libexec/wbb-reboot-request';
const PATH_UNIT = 'etc/systemd/system/wbb-reboot-request.path';
const SERVICE = 'etc/systemd/system/wbb-reboot-request.service';
const DIR = 'var/lib/wbb-host-patch';

describe('install-reboot-request — a clean host', () => {
  it('installs the handler 0755 and both units 0644, byte for byte', () => {
    const h = host();
    expect(run(h).code).toBe(0);
    expect(readFileSync(at(h, HANDLER))).toEqual(readFileSync(join(REPO, 'scripts/ops/reboot_request.py')));
    expect(readFileSync(at(h, PATH_UNIT))).toEqual(readFileSync(join(REPO, 'deploy/wbb-reboot-request.path')));
    expect(readFileSync(at(h, SERVICE))).toEqual(readFileSync(join(REPO, 'deploy/wbb-reboot-request.service')));
    expect([mode(at(h, HANDLER)), mode(at(h, PATH_UNIT)), mode(at(h, SERVICE))]).toEqual([0o755, 0o644, 0o644]);
  });

  it('creates the request directory 0700 and hands it to the bot user', () => {
    const h = host();
    run(h);
    expect([statSync(at(h, DIR)).isDirectory(), mode(at(h, DIR))]).toEqual([true, 0o700]);
    expect(calls(h)[0]).toBe('chown warsaw-beer-bot:warsaw-beer-bot /var/lib/wbb-host-patch');
  });

  it('chowns, reloads, enables and re-arms the path unit, in that order', () => {
    const h = host();
    run(h);
    expect(calls(h)).toEqual([
      'chown warsaw-beer-bot:warsaw-beer-bot /var/lib/wbb-host-patch',
      'systemctl daemon-reload',
      'systemctl enable --now wbb-reboot-request.path',
      'systemctl restart wbb-reboot-request.path',
    ]);
  });

  it('runs from any directory, not only the repo root', () => {
    const h = host();
    const elsewhere = makeTempDirectory('wbb-reboot-request-cwd-');
    expect(run(h, { cwd: elsewhere }).code).toBe(0);
    expect(readFileSync(at(h, HANDLER))).toEqual(readFileSync(join(REPO, 'scripts/ops/reboot_request.py')));
  });

  it('re-asserts 0700 on an existing directory (a widened mode is repaired)', () => {
    const h = host();
    mkdirSync(at(h, DIR));
    chmodSync(at(h, DIR), 0o755);
    expect(run(h).code).toBe(0);
    expect(mode(at(h, DIR))).toBe(0o700);
  });

  it('is idempotent', () => {
    const h = host();
    expect([run(h).code, run(h).code]).toEqual([0, 0]);
    expect(mode(at(h, DIR))).toBe(0o700);
  });
});

describe('install-reboot-request — refusals change nothing', () => {
  it('refuses without root', () => {
    const h = host({ uid: '1000' });
    const r = run(h, { hostRoot: false });
    expect([r.code, r.err.includes('run as root'), existsSync(at(h, HANDLER)), calls(h)]).toEqual([1, true, false, []]);
  });

  it('refuses a request directory that is a symlink', () => {
    const h = host();
    mkdirSync(at(h, 'elsewhere'));
    symlinkSync(at(h, 'elsewhere'), at(h, DIR));
    const r = run(h);
    expect([r.code, r.err.includes('/var/lib/wbb-host-patch'), existsSync(at(h, HANDLER)), calls(h)]).toEqual([1, true, false, []]);
  });

  it('refuses a request directory that is a plain file', () => {
    const h = host();
    writeFileSync(at(h, DIR), 'x');
    const r = run(h);
    expect([r.code, r.err.includes('/var/lib/wbb-host-patch'), existsSync(at(h, HANDLER)), calls(h)]).toEqual([1, true, false, []]);
  });
});
