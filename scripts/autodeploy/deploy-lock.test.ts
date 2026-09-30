import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Merge-deploy R4: a manual deploy.sh and a tick exclude each other, through
 * the tick's own lock file. Everything privileged is a stub on PATH; `flock`
 * is real.
 */
const REPO_ROOT = resolve(__dirname, '../..');

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

interface Rig { source: string; state: string; lock: string; sudoLog: string; bin: string }

function rig(): Rig {
  const source = makeTempDirectory('wbb-lock-src-');
  cpSync(join(REPO_ROOT, 'deploy'), join(source, 'deploy'), { recursive: true });
  executable(join(source, 'deploy/record-deployed.sh'), 'exit 0');
  const bin = makeTempDirectory('wbb-lock-bin-');
  const sudoLog = join(bin, 'sudo.log');
  executable(join(bin, 'sudo'), `echo "$*" >> "${sudoLog}"`);
  executable(join(bin, 'git'), 'exit 0');
  executable(join(bin, 'journalctl'), 'exit 0');
  const state = makeTempDirectory('wbb-lock-state-');
  mkdirSync(join(state, 'wbb-autodeploy'), { recursive: true });
  return { source, state, lock: join(state, 'wbb-autodeploy', 'lock'), sudoLog, bin };
}

function deploy(r: Rig, env: Record<string, string> = {}): { code: number | null; err: string } {
  const res = spawnSync('bash', ['deploy/deploy.sh'], {
    cwd: r.source,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${r.bin}:${process.env.PATH ?? ''}`, XDG_STATE_HOME: r.state, WBB_LOCK_WAIT_S: '0', ...env },
  });
  return { code: res.status, err: res.stderr };
}

/** Holds the lock in another process until released; resolves once it is held. */
async function holdLock(lock: string): Promise<ChildProcess> {
  const holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i += 1) {
    if (spawnSync('flock', ['-n', lock, 'true']).status === 1) return holder;
    await new Promise((res) => setTimeout(res, 20));
  }
  holder.kill();
  throw new Error('the lock holder never acquired the lock');
}

describe('deploy.sh and the merge-deploy lock', () => {
  it('refuses while a tick holds the lock, and touches nothing', async () => {
    const r = rig();
    const holder = await holdLock(r.lock);
    try {
      const res = deploy(r);
      expect(res.code).toBe(1);
      expect(res.err).toMatch(/^ERROR: a merge-deploy tick holds /);
      expect(existsSync(r.sudoLog)).toBe(false);
    } finally {
      holder.kill();
    }
  });

  it('proceeds under a held lock when the tick itself is the caller', async () => {
    const r = rig();
    const holder = await holdLock(r.lock);
    try {
      const res = deploy(r, { WBB_TICK_HOLDS_LOCK: '1' });
      expect(res.code).toBe(0);
      expect(readFileSync(r.sudoLog, 'utf8')).toMatch(/^install -d -o warsaw-beer-bot/);
    } finally {
      holder.kill();
    }
  });

  it('proceeds when nobody holds the lock', () => {
    const r = rig();
    const res = deploy(r);
    expect(res.code).toBe(0);
    expect(readFileSync(r.sudoLog, 'utf8')).toMatch(/restart warsaw-beer-bot/);
  });
});
