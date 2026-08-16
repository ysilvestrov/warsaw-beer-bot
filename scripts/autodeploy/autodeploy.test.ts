import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #435 fix wave — I2.
 *
 * autodeploy.sh had zero tests: 126 lines that run only when production is
 * already broken. Its four points of contact with the outside world (guard,
 * deploy, health check, notify), plus the npm-audit call (which hits the
 * registry), are each overridable via a WBB_* env var — every test here
 * substitutes a stub for all of them, so nothing touches sudo, systemd,
 * /opt, or the network. Only `git` runs for real, against throwaway repos.
 */

const SCRIPT = resolve(__dirname, '../../deploy/autodeploy.sh');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [path, body] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** Writes an executable stub script; `body` is its shell body. */
function stub(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function readState(stateDir: string): Record<string, string> {
  // Mirrors autodeploy.sh: STATE_DIR="$XDG_STATE_HOME/wbb-autodeploy".
  const p = join(stateDir, 'wbb-autodeploy', 'state.env');
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i === -1) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function countLines(p: string): number {
  if (!existsSync(p)) return 0;
  const s = readFileSync(p, 'utf8').trim();
  return s === '' ? 0 : s.split('\n').length;
}

// One shared bare "remote" that every test clones from — no network involved,
// it's a plain local path acting as `origin`.
let remoteDir: string;
let base: string;
let target: string;
const TAG = 'autodeploy-20260816T120000Z';

beforeAll(() => {
  remoteDir = mkdtempSync(join(tmpdir(), 'wbb-ad-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remoteDir]);

  const seed = mkdtempSync(join(tmpdir(), 'wbb-ad-seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  git(seed, 'remote', 'add', 'origin', remoteDir);

  base = commit(seed, { 'package.json': '{"name":"x","version":"1.0.0"}' }, 'base');
  git(seed, 'push', '-q', 'origin', 'main');

  target = commit(seed, { 'package.json': '{"name":"x","version":"1.0.1"}' }, 'lockfile bump');
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'tag', TAG, target);
  git(seed, 'push', '-q', 'origin', TAG);
});

interface Harness {
  home: string;
  dataDir: string;
  stateDir: string;
  repo: string;
  bin: string;
}

/** Fresh XDG dirs + a real clone of remoteDir, per test. */
function setup(): Harness {
  const home = mkdtempSync(join(tmpdir(), 'wbb-ad-home-'));
  const dataDir = join(home, 'data');
  const stateDir = join(home, 'state');
  const repoParent = join(dataDir, 'wbb-autodeploy');
  const repo = join(repoParent, 'repo');
  mkdirSync(repoParent, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  execFileSync('git', ['clone', '-q', remoteDir, repo]);
  const bin = mkdtempSync(join(tmpdir(), 'wbb-ad-bin-'));
  return { home, dataDir, stateDir, repo, bin };
}

function seedState(h: Harness, deployedSha: string, lastFailedSha?: string) {
  const lines = [`DEPLOYED_SHA=${deployedSha}`, 'PREVIOUS_SHA='];
  if (lastFailedSha) lines.push(`LAST_FAILED_SHA=${lastFailedSha}`);
  const dir = join(h.stateDir, 'wbb-autodeploy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.env'), lines.join('\n') + '\n');
}

function run(h: Harness, extraEnv: Record<string, string>): { code: number; out: string } {
  const env = {
    ...process.env,
    HOME: h.home,
    XDG_DATA_HOME: h.dataDir,
    XDG_STATE_HOME: h.stateDir,
    ...extraEnv,
  };
  try {
    const out = execFileSync('bash', [SCRIPT], { encoding: 'utf8', env });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

describe('autodeploy.sh', () => {
  it('a guard refusal exits 1, deploys nothing, and records LAST_FAILED_SHA', () => {
    const h = setup();
    seedState(h, base);
    const guard = stub(h.bin, 'guard', 'echo "REFUSE: stub refusal"; exit 1');
    const deployLog = join(h.bin, 'deploy.log');
    const deploy = stub(h.bin, 'deploy', `echo called >> "${deployLog}"`);
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);
    const audit = stub(h.bin, 'audit', 'exit 0');

    const r = run(h, {
      WBB_GUARD: guard,
      WBB_DEPLOY_CMD: deploy,
      WBB_NOTIFY_CMD: notify,
      WBB_AUDIT_CMD: audit,
    });

    expect(r.code).toBe(1);
    expect(countLines(deployLog)).toBe(0);
    const state = readState(h.stateDir);
    expect(state.LAST_FAILED_SHA).toBe(target);
    expect(state.DEPLOYED_SHA).toBe(base);
  });

  it('a tag equal to LAST_FAILED_SHA is skipped with exit 0 and no deploy', () => {
    const h = setup();
    seedState(h, base, target);
    const guardMarker = join(h.bin, 'guard-invoked');
    const guard = stub(h.bin, 'guard', `touch "${guardMarker}"; echo ACCEPT; exit 0`);
    const deployLog = join(h.bin, 'deploy.log');
    const deploy = stub(h.bin, 'deploy', `echo called >> "${deployLog}"`);
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    const r = run(h, {
      WBB_GUARD: guard,
      WBB_DEPLOY_CMD: deploy,
      WBB_NOTIFY_CMD: notify,
    });

    expect(r.code).toBe(0);
    expect(existsSync(guardMarker)).toBe(false);
    expect(countLines(deployLog)).toBe(0);
    expect(existsSync(notifyLog)).toBe(false);
  });

  it('the health check failing causes the previous sha to be redeployed and exit code 2', () => {
    const h = setup();
    seedState(h, base);
    const guard = stub(h.bin, 'guard', 'echo "ACCEPT: stub"; exit 0');
    const deployLog = join(h.bin, 'deploy.log');
    const deploy = stub(h.bin, 'deploy', `echo called >> "${deployLog}"`);
    const healthCount = join(h.bin, 'health.count');
    // Fails the first call (deploying `target`), succeeds every call after
    // (the rollback to `base`) — proves BOTH that a bad target gets rolled
    // back AND that the rollback's own health check is honoured.
    const health = stub(
      h.bin,
      'health',
      `n=0; [ -f "${healthCount}" ] && n=$(cat "${healthCount}"); n=$((n+1)); echo "$n" > "${healthCount}"; [ "$n" -eq 1 ] && exit 1; exit 0`,
    );
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);
    const audit = stub(h.bin, 'audit', 'exit 0');
    const apiPort = stub(h.bin, 'api-port', 'echo 3000');

    const r = run(h, {
      WBB_GUARD: guard,
      WBB_DEPLOY_CMD: deploy,
      WBB_HEALTH_CMD: health,
      WBB_NOTIFY_CMD: notify,
      WBB_AUDIT_CMD: audit,
      WBB_API_PORT_CMD: apiPort,
    });

    expect(r.code).toBe(2);
    expect(countLines(deployLog)).toBe(2); // primary attempt + rollback
    expect(git(h.repo, 'rev-parse', 'HEAD')).toBe(base); // rolled back for real
    const state = readState(h.stateDir);
    expect(state.LAST_FAILED_SHA).toBe(target);
    expect(state.DEPLOYED_SHA).toBe(base); // unchanged — rollback ≠ new deploy
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/rolling back|rollback.*succeeded/);
  });

  it('a healthy deploy updates DEPLOYED_SHA/PREVIOUS_SHA, clears LAST_FAILED_SHA, and exits 0', () => {
    const h = setup();
    seedState(h, base);
    const guard = stub(h.bin, 'guard', 'echo "ACCEPT: stub"; exit 0');
    const deployLog = join(h.bin, 'deploy.log');
    const deploy = stub(h.bin, 'deploy', `echo called >> "${deployLog}"`);
    const health = stub(h.bin, 'health', 'exit 0');
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);
    const audit = stub(h.bin, 'audit', 'exit 0');
    const apiPort = stub(h.bin, 'api-port', 'echo 3000');

    const r = run(h, {
      WBB_GUARD: guard,
      WBB_DEPLOY_CMD: deploy,
      WBB_HEALTH_CMD: health,
      WBB_NOTIFY_CMD: notify,
      WBB_AUDIT_CMD: audit,
      WBB_API_PORT_CMD: apiPort,
    });

    expect(r.code).toBe(0);
    expect(countLines(deployLog)).toBe(1);
    const state = readState(h.stateDir);
    expect(state.DEPLOYED_SHA).toBe(target);
    expect(state.PREVIOUS_SHA).toBe(base);
    expect(state.LAST_FAILED_SHA).toBeUndefined();
    expect(readFileSync(notifyLog, 'utf8')).toContain('production patched and healthy');
  });
});
