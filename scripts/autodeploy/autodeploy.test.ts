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
  // Baseline default for the WBB_INSTALLED_CHECK seam: CURRENT, so a test
  // that never mentions this seam still cannot reach the real
  // /usr/local/bin/wbb-installed-current if installed_is_stale() is ever
  // reordered ahead of the early exits (LAST_FAILED_SHA skip, PAUSED) that
  // currently keep those tests from touching it at all (#470). Placed
  // before the ...extraEnv spread so a test that DOES care about this seam
  // can still override it.
  const defaultInstalledCheck = stub(h.bin, 'installed-check-default', 'echo "CURRENT: default stub"; exit 0');
  const env = {
    ...process.env,
    HOME: h.home,
    XDG_DATA_HOME: h.dataDir,
    XDG_STATE_HOME: h.stateDir,
    WBB_INSTALLED_CHECK: defaultInstalledCheck,
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
    // #490: seed a drift episode as if it had been open BEFORE this deploy —
    // a successful deploy must close it out (clear both fields), not carry it
    // forward for a later idle tick to misread as seconds-old drift.
    const stateDir = join(h.stateDir, 'wbb-autodeploy');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'state.env'),
      `DEPLOYED_SHA=${base}\nPREVIOUS_SHA=\nDRIFT_SINCE=1000000\nLAST_DRIFT_NOTICE=2026-08-20\n`,
    );
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
    // #490: a successful deploy must close any drift episode it was carrying,
    // not hand it forward for a later idle tick to misread as fresh drift.
    expect(state.DRIFT_SINCE).toBeUndefined();
    expect(state.LAST_DRIFT_NOTICE).toBeUndefined();
  });

  // #461 added installed_is_stale(): a pending tag must be REFUSED while the
  // installed deployer copy is out of date, because the safety logic about
  // to run (guard, downgrade check, ...) is known-stale. #470: this claim
  // had zero coverage — the WBB_INSTALLED_CHECK seam wasn't even stubbed, so
  // these two tests are the first to exercise installed_is_stale() at all.
  it('a checker reporting STALE refuses a pending tag: no deploy, exit 1, tag stays retryable', () => {
    const h = setup();
    seedState(h, base);
    const installedCheck = stub(
      h.bin,
      'installed-check',
      'echo "STALE: 1 installed file(s) differ from origin/main:"; echo "  deploy/autodeploy.sh"; exit 1',
    );
    const guardMarker = join(h.bin, 'guard-invoked');
    const guard = stub(h.bin, 'guard', `touch "${guardMarker}"; echo ACCEPT; exit 0`);
    const deployLog = join(h.bin, 'deploy.log');
    const deploy = stub(h.bin, 'deploy', `echo called >> "${deployLog}"`);
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);
    const audit = stub(h.bin, 'audit', 'exit 0');
    // #470 round 1: a checker that never actually refuses (a mutant, or a
    // future reordering of the checks) would let the script fall through
    // past this point into api_port()/healthy() — which, unstubbed, run the
    // real `sudo -u warsaw-beer-bot wbb-read-env` and curl live production
    // /health. Stub both so this test cannot reach either even on that path.
    const health = stub(h.bin, 'health', 'exit 0');
    const apiPort = stub(h.bin, 'api-port', 'echo 3000');

    const r = run(h, {
      WBB_INSTALLED_CHECK: installedCheck,
      WBB_GUARD: guard,
      WBB_DEPLOY_CMD: deploy,
      WBB_NOTIFY_CMD: notify,
      WBB_AUDIT_CMD: audit,
      WBB_HEALTH_CMD: health,
      WBB_API_PORT_CMD: apiPort,
    });

    expect(r.code).toBe(1);
    expect(existsSync(guardMarker)).toBe(false); // refused before the guard even runs
    expect(countLines(deployLog)).toBe(0);
    const state = readState(h.stateDir);
    expect(state.DEPLOYED_SHA).toBe(base); // unchanged
    // Deliberately NOT recorded as LAST_FAILED_SHA (autodeploy.sh comment on
    // this branch): the tag itself is fine, so it must stay retryable once
    // the installed copy is fixed.
    expect(state.LAST_FAILED_SHA).toBeUndefined();
    // Named to the REFUSED-for-a-pending-tag path specifically — the idle
    // report_stale_once() path shares the "installed deployer is out of
    // date" wording but is unreachable here (a tag IS pending).
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/REFUSED for .*out of date/);
  });

  it('a checker reporting CURRENT lets the deploy proceed exactly as today', () => {
    const h = setup();
    seedState(h, base);
    // #470 round 1: a marker, not just the CURRENT verdict, because a stub
    // that is simply never consulted also produces exit 0 and a successful
    // deploy — that's not evidence the seam was exercised. Proved by the
    // reviewer: this test stayed green both when installed_is_stale() was
    // mutated out entirely and when the stub was repointed at a
    // /nonexistent path (installed_is_stale's own early-return at
    // deploy/autodeploy.sh:202 swallows a missing/non-executable checker as
    // "not stale"). The marker fails unless the checker binary actually ran.
    const installedCheckMarker = join(h.bin, 'installed-check-invoked');
    const installedCheck = stub(
      h.bin,
      'installed-check',
      `touch "${installedCheckMarker}"; echo "CURRENT: installed copies match origin/main"; exit 0`,
    );
    const guard = stub(h.bin, 'guard', 'echo "ACCEPT: stub"; exit 0');
    const deployLog = join(h.bin, 'deploy.log');
    const deploy = stub(h.bin, 'deploy', `echo called >> "${deployLog}"`);
    const health = stub(h.bin, 'health', 'exit 0');
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);
    const audit = stub(h.bin, 'audit', 'exit 0');
    const apiPort = stub(h.bin, 'api-port', 'echo 3000');

    const r = run(h, {
      WBB_INSTALLED_CHECK: installedCheck,
      WBB_GUARD: guard,
      WBB_DEPLOY_CMD: deploy,
      WBB_HEALTH_CMD: health,
      WBB_NOTIFY_CMD: notify,
      WBB_AUDIT_CMD: audit,
      WBB_API_PORT_CMD: apiPort,
    });

    expect(existsSync(installedCheckMarker)).toBe(true); // the seam was actually consulted
    expect(r.code).toBe(0);
    expect(countLines(deployLog)).toBe(1);
    const state = readState(h.stateDir);
    expect(state.DEPLOYED_SHA).toBe(target);
    expect(state.PREVIOUS_SHA).toBe(base);
    expect(readFileSync(notifyLog, 'utf8')).toContain('production patched and healthy');
  });

  it('a PAUSED file makes the run exit 0 quietly, deploying and notifying nothing', () => {
    const h = setup();
    seedState(h, base);
    const pausedDir = join(h.stateDir, 'wbb-autodeploy');
    mkdirSync(pausedDir, { recursive: true });
    writeFileSync(join(pausedDir, 'PAUSED'), '');

    const guardMarker = join(h.bin, 'guard-invoked');
    const guard = stub(h.bin, 'guard', `touch "${guardMarker}"; echo ACCEPT; exit 0`);
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

    expect(r.code).toBe(0);
    expect(existsSync(guardMarker)).toBe(false);
    expect(countLines(deployLog)).toBe(0);
    expect(existsSync(notifyLog)).toBe(false);
    // Untouched: a paused run must not even update DEPLOYED_SHA bookkeeping.
    const state = readState(h.stateDir);
    expect(state.DEPLOYED_SHA).toBe(base);
  });
});

/**
 * #490. `report_drift_once` runs only on the idle path — when no autodeploy-*
 * tag exists — so these tests need their own remote, not the shared one, which
 * carries a tag. The two commits differ in `src/x.ts`, outside the
 * package.json/package-lock.json allowlist, so drift here is the blocking kind.
 */
function driftRemote(): { dir: string; oldSha: string; newSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-drift-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
  const seed = mkdtempSync(join(tmpdir(), 'wbb-drift-seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  git(seed, 'remote', 'add', 'origin', dir);
  const oldSha = commit(seed, { 'src/x.ts': 'export const x = 1;\n' }, 'old');
  git(seed, 'push', '-q', 'origin', 'main');
  const newSha = commit(seed, { 'src/x.ts': 'export const x = 2;\n' }, 'new');
  git(seed, 'push', '-q', 'origin', 'main');
  return { dir, oldSha, newSha };
}

/** A harness cloned from a drift remote, plus arbitrary state fields. */
function driftHarness(remote: string, state: Record<string, string>): Harness {
  const home = mkdtempSync(join(tmpdir(), 'wbb-ad-home-'));
  const dataDir = join(home, 'data');
  const stateDir = join(home, 'state');
  const repoParent = join(dataDir, 'wbb-autodeploy');
  mkdirSync(repoParent, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  execFileSync('git', ['clone', '-q', remote, join(repoParent, 'repo')]);
  const dir = join(stateDir, 'wbb-autodeploy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'state.env'),
    Object.entries(state).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
  );
  return { home, dataDir, stateDir, repo: join(repoParent, 'repo'), bin: mkdtempSync(join(tmpdir(), 'wbb-ad-bin-')) };
}

describe('#490 drift episode', () => {
  it('records the episode start and says nothing inside the grace window', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, { DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '' });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    const out = run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: '1000000' });

    expect(out.code).toBe(0);
    // The episode is recorded...
    expect(readState(h.stateDir).DRIFT_SINCE).toBe('1000000');
    // ...and nobody is told yet. A merge is not an incident.
    expect(existsSync(notifyLog)).toBe(false);
  });

  it('still says nothing one second before the grace period expires', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    // A non-zero exit before the notify point would leave the log absent and the

    // state untouched — i.e. indistinguishable from the silence this asserts.

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 899) }).code).toBe(0);

    expect(existsSync(notifyLog)).toBe(false);
    // ...and the start is not moved forward by a tick that stayed silent.
    expect(readState(h.stateDir).DRIFT_SINCE).toBe('1000000');
  });

  it('announces once the drift has outlived the grace period', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    // A non-zero exit before the notify point would leave the log absent and the

    // state untouched — i.e. indistinguishable from the silence this asserts.

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 900) }).code).toBe(0);

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/BLOCKED/);
    // The reminder marker is what stops the repeat, and what Task 3 reads to
    // decide whether a closing message is owed.
    expect(readState(h.stateDir).LAST_DRIFT_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not repeat on the next tick of the same day', () => {
    const r = driftRemote();
    const today = new Date().toISOString().slice(0, 10);
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '',
      DRIFT_SINCE: '1000000', LAST_DRIFT_NOTICE: today,
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    // A non-zero exit before the notify point would leave the log absent and the

    // state untouched — i.e. indistinguishable from the silence this asserts.

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 100000) }).code).toBe(0);

    expect(existsSync(notifyLog)).toBe(false);
  });

  it('a stale marker does not suppress — the warning returns on a later day', () => {
    // This test is not redundant with the other two. The second test proves that
    // TODAY suppresses. This one proves that STALE does not suppress. Together
    // they would catch a mutant suppressor of `[ -z "$LAST_DRIFT_NOTICE" ] ||
    // return 0` (suppress whenever the marker is non-empty) — the second test
    // cannot; only this one can.
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '',
      DRIFT_SINCE: '1000000', LAST_DRIFT_NOTICE: '2000-01-01',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    // A non-zero exit before the notify point would leave the log absent and the

    // state untouched — i.e. indistinguishable from the silence this asserts.

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 100000) }).code).toBe(0);

    expect(countLines(notifyLog)).toBe(1);
  });

  it('closes an announced episode with one recovery message and clears both fields', () => {
    const r = driftRemote();
    // production has caught up: DEPLOYED_SHA === origin/main
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.newSha, PREVIOUS_SHA: r.oldSha,
      DRIFT_SINCE: '1000000', LAST_DRIFT_NOTICE: '2026-08-23',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    // A non-zero exit before the notify point would leave the log absent and the

    // state untouched — i.e. indistinguishable from the silence this asserts.

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 100000) }).code).toBe(0);

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/caught up|in sync/i);
    const state = readState(h.stateDir);
    expect(state.DRIFT_SINCE ?? '').toBe('');
    expect(state.LAST_DRIFT_NOTICE ?? '').toBe('');
  });

  it('says nothing at all when an unannounced episode closes inside the grace window', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.newSha, PREVIOUS_SHA: r.oldSha,
      DRIFT_SINCE: '1000000',           // started, never announced
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    // A non-zero exit before the notify point would leave the log absent and the

    // state untouched — i.e. indistinguishable from the silence this asserts.

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 60) }).code).toBe(0);

    // An all-clear for an alarm that never sounded is pure noise, and it would
    // land on exactly the happy path this change exists to keep quiet.
    expect(existsSync(notifyLog)).toBe(false);
    expect(readState(h.stateDir).DRIFT_SINCE ?? '').toBe('');
  });

  it('#490 regression: a second merge the same day is announced, not swallowed', () => {
    const r = driftRemote();
    // The state the OLD code left behind after merge → BLOCKED → deploy:
    // caught up, but LAST_DRIFT_NOTICE still holds today, so the old code
    // would stay silent for the rest of the day however far production fell
    // behind. Here the episode closes first, clearing the marker.
    const today = new Date().toISOString().slice(0, 10);
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.newSha, PREVIOUS_SHA: r.oldSha,
      DRIFT_SINCE: '1000000', LAST_DRIFT_NOTICE: today,
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    // tick 1: production is level → the episode closes and the marker clears
    // A non-zero exit before the notify point would leave the log absent and the
    // state untouched — i.e. indistinguishable from the silence this asserts.
    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: '2000000' }).code).toBe(0);
    expect(readState(h.stateDir).LAST_DRIFT_NOTICE ?? '').toBe('');

    // a second merge lands: roll production back to the older commit
    writeFileSync(
      join(h.stateDir, 'wbb-autodeploy', 'state.env'),
      `DEPLOYED_SHA=${r.oldSha}\nPREVIOUS_SHA=\n`,
    );

    // tick 2 starts a fresh episode silently; tick 3, past the grace, announces
    // A non-zero exit before the notify point would leave the log absent and the
    // state untouched — i.e. indistinguishable from the silence this asserts.
    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: '3000000' }).code).toBe(0);
    // A non-zero exit before the notify point would leave the log absent and the
    // state untouched — i.e. indistinguishable from the silence this asserts.
    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(3000000 + 900) }).code).toBe(0);

    // one recovery + one fresh announcement — under the old code the second
    // merge produced nothing at all.
    expect(countLines(notifyLog)).toBe(2);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/BLOCKED/);
    expect(readFileSync(notifyLog, 'utf8').split('\n')[0]).toMatch(/caught up/);
  });
});
