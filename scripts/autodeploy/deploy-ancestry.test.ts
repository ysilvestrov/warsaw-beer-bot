import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function rig() {
  const repo = makeTempDirectory('wbb-ancestry-src-');
  cpSync(join(ROOT, 'deploy'), join(repo, 'deploy'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'runtime'), 'new');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'forward');
  const next = git(repo, 'rev-parse', 'HEAD');
  const bin = makeTempDirectory('wbb-ancestry-bin-');
  const sudoLog = join(bin, 'sudo.log');
  executable(join(bin, 'sudo'), `echo "$*" >> "${sudoLog}"`);
  executable(join(bin, 'journalctl'), 'exit 0');
  const stateHome = makeTempDirectory('wbb-ancestry-state-');
  mkdirSync(join(stateHome, 'wbb-autodeploy'));
  const state = join(stateHome, 'wbb-autodeploy/state.env');
  writeFileSync(state, `DEPLOYED_SHA=${next}\nLAST_SEEN_DEPLOYED_SHA=${next}\n`);
  return { repo, base, next, bin, sudoLog, stateHome, state };
}

type Rig = ReturnType<typeof rig>;

function deploy(r: Rig, args: string[] = []) {
  return spawnSync('bash', ['deploy/deploy.sh', ...args], {
    cwd: r.repo, encoding: 'utf8',
    env: { ...process.env, PATH: `${r.bin}:${process.env.PATH ?? ''}`, XDG_STATE_HOME: r.stateHome },
  });
}

describe('manual deploy ancestry admission', () => {
  it('refuses a strict ancestor before sudo and preserves the recorded state', () => {
    const r = rig();
    git(r.repo, 'checkout', '-q', '--detach', r.base);
    const before = readFileSync(r.state, 'utf8');
    const result = deploy(r);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not contain recorded production');
    expect(result.stderr).toContain('--force');
    expect(existsSync(r.sudoLog)).toBe(false);
    expect(readFileSync(r.state, 'utf8')).toBe(before);
  });

  it('admits an equal commit', () => {
    const r = rig();
    expect(deploy(r).status).toBe(0);
    expect(readFileSync(r.sudoLog, 'utf8')).toContain('restart warsaw-beer-bot');
    expect(readFileSync(r.state, 'utf8')).toContain(`DEPLOYED_SHA=${r.next}\n`);
  });

  it('admits a descendant', () => {
    const r = rig();
    writeFileSync(r.state, `DEPLOYED_SHA=${r.base}\n`);
    expect(deploy(r).status).toBe(0);
    expect(readFileSync(r.state, 'utf8')).toContain(`DEPLOYED_SHA=${r.next}\n`);
  });

  it('refuses a divergent checkout', () => {
    const r = rig();
    git(r.repo, 'checkout', '-q', '--detach', r.base);
    writeFileSync(join(r.repo, 'runtime'), 'sibling');
    git(r.repo, 'add', '.');
    git(r.repo, 'commit', '-qm', 'sibling');
    const before = readFileSync(r.state, 'utf8');
    expect(deploy(r).status).toBe(1);
    expect(existsSync(r.sudoLog)).toBe(false);
    expect(readFileSync(r.state, 'utf8')).toBe(before);
  });

  it('refuses an unresolved recorded commit', () => {
    const r = rig();
    writeFileSync(r.state, `DEPLOYED_SHA=${'a'.repeat(40)}\n`);
    const before = readFileSync(r.state, 'utf8');
    expect(deploy(r).status).toBe(1);
    expect(existsSync(r.sudoLog)).toBe(false);
    expect(readFileSync(r.state, 'utf8')).toBe(before);
  });

  it.each(['', 'PREVIOUS_SHA=\n', 'DEPLOYED_SHA=\n'])('admits a first deploy or empty baseline (%j)', (state) => {
    const r = rig();
    writeFileSync(r.state, state);
    expect(deploy(r).status).toBe(0);
    expect(readFileSync(r.state, 'utf8')).toContain(`DEPLOYED_SHA=${r.next}\n`);
  });

  it('admits a first deployment when state.env does not exist', () => {
    const r = rig();
    // Change the test's state root, leaving its original record untouched.
    r.stateHome = makeTempDirectory('wbb-first-deploy-');
    expect(deploy(r).status).toBe(0);
    expect(readFileSync(join(r.stateHome, 'wbb-autodeploy/state.env'), 'utf8')).toBe(`DEPLOYED_SHA=${r.next}\n`);
  });

  it('logs and performs an explicit rollback with --force', () => {
    const r = rig();
    git(r.repo, 'checkout', '-q', '--detach', r.base);
    const result = deploy(r, ['--force']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`FORCED deployment: ${r.next} -> ${r.base}`);
    expect(readFileSync(r.sudoLog, 'utf8')).toContain('restart warsaw-beer-bot');
    expect(readFileSync(r.state, 'utf8')).toContain(`DEPLOYED_SHA=${r.base}\n`);
    expect(readFileSync(r.state, 'utf8')).toContain(`LAST_SEEN_DEPLOYED_SHA=${r.next}\n`);
  });

  it('allows explicit recovery when the baseline commit is unavailable', () => {
    const r = rig();
    writeFileSync(r.state, `DEPLOYED_SHA=${'a'.repeat(40)}\n`);
    expect(deploy(r, ['--force']).status).toBe(0);
    expect(readFileSync(r.state, 'utf8')).toContain(`DEPLOYED_SHA=${r.next}\n`);
  });

  it('refuses unreadable state even with --force', () => {
    const r = rig();
    chmodSync(r.state, 0o000);
    expect(deploy(r, ['--force']).status).toBe(1);
    expect(existsSync(r.sudoLog)).toBe(false);
  });

  it('refuses duplicate baseline records', () => {
    const r = rig();
    writeFileSync(r.state, `DEPLOYED_SHA=${r.base}\nDEPLOYED_SHA=${r.next}\n`);
    const before = readFileSync(r.state, 'utf8');
    expect(deploy(r).status).toBe(1);
    expect(existsSync(r.sudoLog)).toBe(false);
    expect(readFileSync(r.state, 'utf8')).toBe(before);
  });

  it.each([
    { args: ['--unknown'] }, { args: ['--force', '--unknown'] }, { args: ['--force', '--force'] },
  ])('refuses invalid arguments $args', ({ args }) => {
    const r = rig();
    expect(deploy(r, args).status).toBe(1);
    expect(existsSync(r.sudoLog)).toBe(false);
  });
});
