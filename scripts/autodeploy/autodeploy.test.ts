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
const SHIPS = resolve(__dirname, '../../deploy/ships.sh');

const REAL_FILTER = [
  '+ /package.json',
  '+ /package-lock.json',
  '+ /tsconfig.json',
  '+ /src/***',
  '+ /scripts/***',
  '+ /deploy/***',
  '- *',
  '',
].join('\n');

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

/**
 * A notify stub that records ONE LINE PER CALL, not per line of message.
 * `countLines` counts lines, and the stale-deployer and guard-refusal
 * messages are multi-line — a plain `cat` stub would make "how many
 * notifications" unmeasurable.
 *
 * The recorded line is prefixed with a fixed `NOTIFY ` marker so it is
 * never empty, even for a (currently hypothetical) message whose first
 * line is blank: `countLines` trims the log before splitting, so a
 * trailing blank line would vanish and silently undercount that call.
 */
function countingNotify(dir: string, log: string): string {
  return stub(dir, 'notify', `printf 'NOTIFY %s\\n' "$(head -n1 <<< "$1")" >> "${log}"`);
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

  // #527: a real filter, so the idle-path tests below that incidentally reach
  // report_drift_once (see the "LAST_FAILED_SHA is skipped" test) hit the
  // ordinary classify-and-decide path rather than the fail-closed one.
  base = commit(seed, {
    'package.json': '{"name":"x","version":"1.0.0"}',
    'deploy/rsync-filter': REAL_FILTER,
  }, 'base');
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
    WBB_SHIPS: SHIPS,
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
    // Post-#491 this path now reaches report_drift_once every time (base,
    // the seeded DEPLOYED_SHA, is behind origin/main here). The silence is
    // no longer structural — this path used to exit before any reporter
    // ran — it survives only because DRIFT_GRACE_S (15 min) has not
    // elapsed: DRIFT_SINCE is unset, so report_drift_once starts the
    // episode clock and returns without notifying. A future change to
    // DRIFT_GRACE_S or the episode-start branch could break this silently,
    // in a test whose name mentions neither.
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
 * #490. `report_drift_once` runs only on the idle path, so these tests need
 * their own remote rather than the shared one. The two commits differ in
 * `src/x.ts`, outside the package.json/package-lock.json allowlist, so drift
 * here is the blocking kind.
 *
 * #491. `tagAt` places an `autodeploy-*` tag on one of the two commits. The
 * idle path used to be reachable ONLY when no such tag existed anywhere, which
 * is why every #490 test above leaves this argument off.
 *
 * #490/#491 as before. #527: the fixture commits now carry a real
 * `deploy/rsync-filter`, because report_drift_once reads it from
 * `origin/main` — a fixture without one is no longer "a repo with two
 * commits", it is the fail-closed case.
 *
 * `differsIn` chooses what the second commit changes: 'src' is drift that
 * ships and is blocking, 'lockfile' ships and is not, 'extension' ships
 * nothing at all, and 'narrow-filter' guts `deploy/rsync-filter` to `- *` —
 * which ships nothing under the TARGET's filter and everything under the
 * deployed one (final-review C1).
 */
function driftRemote(
  tagAt?: 'old' | 'new',
  differsIn: 'src' | 'lockfile' | 'extension' | 'narrow-filter' = 'src',
): { dir: string; oldSha: string; newSha: string; tag: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-drift-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
  const seed = mkdtempSync(join(tmpdir(), 'wbb-drift-seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  git(seed, 'remote', 'add', 'origin', dir);
  const oldSha = commit(seed, {
    'src/x.ts': 'export const x = 1;\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'extension/popup.css': 'body{}\n',
    'deploy/rsync-filter': REAL_FILTER,
  }, 'old');
  git(seed, 'push', '-q', 'origin', 'main');
  const changedByKind: Record<
    'src' | 'lockfile' | 'extension' | 'narrow-filter',
    Record<string, string>
  > = {
    src: { 'src/x.ts': 'export const x = 2;\n' },
    lockfile: { 'package-lock.json': '{"lockfileVersion":3,"bumped":true}\n' },
    extension: { 'extension/popup.css': 'body{color:red}\n' },
    'narrow-filter': { 'deploy/rsync-filter': '- *\n' },
  };
  const newSha = commit(seed, changedByKind[differsIn], 'new');
  git(seed, 'push', '-q', 'origin', 'main');
  const tag = 'autodeploy-20260824T120000Z';
  if (tagAt) {
    git(seed, 'tag', tag, tagAt === 'old' ? oldSha : newSha);
    git(seed, 'push', '-q', 'origin', tag);
  }
  return { dir, oldSha, newSha, tag };
}

/** A remote whose commits carry NO rsync-filter: the fail-closed case. */
function driftRemoteWithoutFilter(): { dir: string; oldSha: string; newSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-drift-nofilter-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
  const seed = mkdtempSync(join(tmpdir(), 'wbb-drift-nofilter-seed-'));
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

describe('#527 drift is drift only when something ships', () => {
  it('says nothing and opens no episode when the only difference never ships', () => {
    // The 2026-08-28 incident. An extension-only merge leaves production
    // permanently behind main — there is nothing to deploy, so the baseline
    // never advances — and a daily reminder about a condition nobody can
    // clear is the failure mode #490 already had to remove once.
    const r = driftRemote(undefined, 'extension');
    const h = driftHarness(r.dir, { DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '' });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: '1000000' }).code).toBe(0);

    expect(existsSync(notifyLog)).toBe(false);
    // Measured in the state file, not by the absence of a message: an episode
    // that opens now would announce fifteen minutes from now.
    expect(readState(h.stateDir).DRIFT_SINCE ?? '').toBe('');
  });

  it('still announces when a shipping path differs', () => {
    const r = driftRemote(undefined, 'src');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 900) }).code).toBe(0);

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/BLOCKED/);
  });

  it('reports the non-blocking variant when only the lockfile ships', () => {
    const r = driftRemote(undefined, 'lockfile');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 900) }).code).toBe(0);

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).not.toMatch(/BLOCKED/);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/still works/);
  });

  it('does NOT go silent when it cannot classify the diff', () => {
    // The trap this change creates. The quiet branch above is quieter than
    // #499's reassuring message: a classification failure and "nothing ships"
    // would otherwise be the same outcome — total silence.
    const r = driftRemoteWithoutFilter();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 900) }).code).toBe(0);

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/cannot tell|cannot assess/i);
  });

  it('C1 (final review): a merge that GUTS the filter still counts as drift', () => {
    // The union rule, on the drift side. Classified against origin/main's
    // filter alone (`- *`), `deploy/rsync-filter` classifies SKIP and this
    // goes silent — the same blindness that lets the guard ACCEPT it. The
    // deployed commit's filter still ships `deploy/***`, and rsync --delete
    // acts on THAT set, so the path reaches production and must be announced.
    const r = driftRemote(undefined, 'narrow-filter');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 900) }).code).toBe(0);

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/BLOCKED/);
  });

  it('I2 (final review): an answer shorter than the question is "cannot assess"', () => {
    // A ships predicate that drains stdin and exits 0 says nothing about
    // anything. Folded into the empty branch it would read as "nothing
    // ships" — total silence about a src/** difference nobody can deploy.
    const r = driftRemote(undefined, 'src');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);
    const silent = stub(h.bin, 'silent-ships', 'cat >/dev/null\nexit 0');

    expect(
      run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 900), WBB_SHIPS: silent }).code,
    ).toBe(0);

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/cannot tell|cannot assess/i);
  });
});

/**
 * D1 (#491/#497 design): `write_state` takes exactly three parameters, and
 * the three daily/episode markers (`LAST_DRIFT_NOTICE`, `LAST_STALE_NOTICE`,
 * `DRIFT_SINCE`) are no longer parameters at all — a caller that wants to
 * change one assigns the shell variable, then calls. Nothing about bash
 * *enforces* this: `write_state "$a" "$b" "$c" "$extra"` runs, exits 0, and
 * silently drops "$extra" on the floor — the same shape of invisible defect
 * as #497, by a different mechanism, and no unit test above ever inspects a
 * `write_state` call site directly. This source guard is what actually
 * enforces D1's "three parameters" invariant.
 */
describe('write_state has three parameters (source guard)', () => {
  it('every call site is exactly three quoted arguments and nothing else', () => {
    const src = readFileSync(SCRIPT, 'utf8').split('\n');
    const offenders: string[] = [];
    src.forEach((line, i) => {
      // Skip comment lines — a comment mentioning `write_state` in prose
      // (e.g. explaining the #497 history) is not a call site.
      if (/^\s*#/.test(line)) return;
      // Skip the function definition itself (`write_state() {`) — only CALL
      // sites are in scope.
      if (/write_state\s*\(\)/.test(line)) return;
      if (!/\bwrite_state\s/.test(line)) return;
      // ALLOWLIST, not a counter. Counting arguments means parsing bash, and
      // bash does not reward part-time parsers: `>/dev/null "$extra"` hides a
      // fourth argument *behind* a redirection, `2>/dev/null` is a redirection
      // that does not start with `>`, and every rule added to handle one form
      // opens another. A tripwire that guesses is worse than no tripwire.
      //
      // So the rule is the opposite: a `write_state` call must be written as
      // two or three double-quoted arguments and NOTHING ELSE on the line.
      // That shape cannot hide a fourth argument in any form. Anything more
      // exotic — a redirection, `|| exit 1`, an unquoted word, a line
      // continuation — fails LOUDLY and says so, which is the correct
      // outcome: this guard protects an invariant (#497) that was broken by
      // exactly the kind of cleverness at a call site that nobody re-read.
      // If a call genuinely needs a different shape, that is a decision to
      // make deliberately, not one to sneak past a regex.
      // EXACTLY three, not two-or-three. `last_failed` is `${3:-}` in the
      // function, so omitting it and passing "" are identical to bash — and
      // that is the problem: two spellings for "clear the failed-tag marker",
      // one of which is invisible at the call site. Requiring the explicit ""
      // is the same lesson as #497 one argument over: a field whose value is
      // decided by ABSENCE is a field nobody notices changing.
      if (!/^\s*write_state(?: "[^"]*"){3}\s*$/.test(line)) {
        offenders.push(
          `line ${i + 1}: \`${line.trim()}\` — a write_state call must be exactly ` +
            `three double-quoted arguments and nothing else on the line ` +
            `(deployed, previous, last_failed). LAST_DRIFT_NOTICE / ` +
            `LAST_STALE_NOTICE / DRIFT_SINCE are NOT parameters: assign the shell ` +
            `variable before calling, per #497. This guard refuses any other ` +
            `shape on purpose — a redirection or operator on the same line can ` +
            `hide a fourth argument from any counter short of a real bash parser.`,
        );
      }
    });
    expect(offenders).toEqual([]);
  });
});

describe('#497 the daily markers survive each other', () => {
  it('a tick where both reporters speak leaves BOTH markers in the state file', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = countingNotify(h.bin, notifyLog);
    const installedCheck = stub(
      h.bin,
      'installed-check',
      'echo "STALE: 1 installed file(s) differ from origin/main:"; echo "  deploy/autodeploy.sh"; exit 1',
    );

    const out = run(h, {
      WBB_NOTIFY_CMD: notify,
      WBB_INSTALLED_CHECK: installedCheck,
      WBB_NOW_S: String(1000000 + 100000),
    });

    // A non-zero exit before the notify point would leave the log absent and
    // the state untouched — indistinguishable from the silence being tested.
    expect(out.code).toBe(0);
    // Two distinct messages, one from each reporter.
    expect(countLines(notifyLog)).toBe(2);
    const log = readFileSync(notifyLog, 'utf8');
    expect(log).toMatch(/out of date/);
    expect(log).toMatch(/BLOCKED/);

    // The defect: report_drift_once's write dropped the marker
    // report_stale_once had just persisted.
    const state = readState(h.stateDir);
    expect(state.LAST_STALE_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(state.LAST_DRIFT_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('both markers survive each other with a tag present too — the "already deployed" branch', () => {
    // The test above only exercises the `no autodeploy tag yet` branch —
    // which, by this branch's own argument (#491), becomes permanently
    // unreachable the first time a qualified merge pushes a tag. This
    // reaches the same two reporters via the branch that replaces it: a tag
    // present and already deployed.
    const r = driftRemote('old');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = countingNotify(h.bin, notifyLog);
    const installedCheck = stub(
      h.bin,
      'installed-check',
      'echo "STALE: 1 installed file(s) differ from origin/main:"; echo "  deploy/autodeploy.sh"; exit 1',
    );

    const out = run(h, {
      WBB_NOTIFY_CMD: notify,
      WBB_INSTALLED_CHECK: installedCheck,
      WBB_NOW_S: String(1000000 + 100000),
    });

    expect(out.code).toBe(0);
    expect(out.out).toMatch(/already deployed/); // confirms the tag-present branch, not the no-tag one
    expect(countLines(notifyLog)).toBe(2);
    const log = readFileSync(notifyLog, 'utf8');
    expect(log).toMatch(/out of date/);
    expect(log).toMatch(/BLOCKED/);

    const state = readState(h.stateDir);
    expect(state.LAST_STALE_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(state.LAST_DRIFT_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the same day is silent on the next tick — neither warning repeats', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = countingNotify(h.bin, notifyLog);
    const installedCheck = stub(
      h.bin,
      'installed-check',
      'echo "STALE: 1 installed file(s) differ from origin/main:"; echo "  deploy/autodeploy.sh"; exit 1',
    );
    const env = {
      WBB_NOTIFY_CMD: notify,
      WBB_INSTALLED_CHECK: installedCheck,
      WBB_NOW_S: String(1000000 + 100000),
    };

    expect(run(h, env).code).toBe(0);
    expect(countLines(notifyLog)).toBe(2);

    // Second tick, same day: both markers must still be suppressing.
    expect(run(h, env).code).toBe(0);
    expect(countLines(notifyLog)).toBe(2); // unchanged — the siren #497 describes
  });
});

describe('#491 the idle reports survive the existence of a tag', () => {
  it('drift is announced when the newest tag is already deployed', () => {
    // The tag sits on the deployed commit, so there is nothing to do — but
    // `main` has moved on. Under the old gate ("has a tag ever existed?") this
    // tick exited at "already deployed" and said nothing, forever.
    const r = driftRemote('old');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = countingNotify(h.bin, notifyLog);
    // The guard must never be consulted on this path; a marker proves it.
    const guardMarker = join(h.bin, 'guard-invoked');
    const guard = stub(h.bin, 'guard', `touch "${guardMarker}"; echo ACCEPT; exit 0`);

    const out = run(h, {
      WBB_NOTIFY_CMD: notify,
      WBB_GUARD: guard,
      WBB_NOW_S: String(1000000 + 100000),
    });

    expect(out.code).toBe(0);
    expect(out.out).toMatch(/already deployed/); // the diagnostic line is kept
    expect(existsSync(guardMarker)).toBe(false);
    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/BLOCKED/);
    expect(readState(h.stateDir).LAST_DRIFT_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('drift is announced when the newest tag is recorded as LAST_FAILED_SHA', () => {
    // The tag failed once and is not retried — that is idle, and it is the
    // state in which drift matters most: autodeploy is dead twice over.
    const r = driftRemote('new');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '',
      LAST_FAILED_SHA: r.newSha, DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = countingNotify(h.bin, notifyLog);
    const guardMarker = join(h.bin, 'guard-invoked');
    const guard = stub(h.bin, 'guard', `touch "${guardMarker}"; echo ACCEPT; exit 0`);

    const out = run(h, {
      WBB_NOTIFY_CMD: notify,
      WBB_GUARD: guard,
      WBB_NOW_S: String(1000000 + 100000),
    });

    expect(out.code).toBe(0);
    expect(out.out).toMatch(/LAST_FAILED_SHA/); // the diagnostic line is kept
    expect(existsSync(guardMarker)).toBe(false);
    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/BLOCKED/);
  });

  it('the stale-deployer reminder is reachable with a tag present', () => {
    // Same dark branch, the other reporter. Production is level with main, so
    // report_drift_once has nothing to say and the ONLY message can be this one.
    const r = driftRemote('new');
    const h = driftHarness(r.dir, { DEPLOYED_SHA: r.newSha, PREVIOUS_SHA: r.oldSha });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = countingNotify(h.bin, notifyLog);
    const installedCheck = stub(
      h.bin,
      'installed-check',
      'echo "STALE: 1 installed file(s) differ from origin/main:"; echo "  deploy/autodeploy.sh"; exit 1',
    );

    const out = run(h, {
      WBB_NOTIFY_CMD: notify,
      WBB_INSTALLED_CHECK: installedCheck,
      WBB_NOW_S: '2000000',
    });

    expect(out.code).toBe(0);
    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/out of date/);
    expect(readState(h.stateDir).LAST_STALE_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a PENDING tag still produces the guard verdict and NO idle report', () => {
    // The tiredness this whole gate was protecting. A tag that is real work
    // gets deployed or refused with its paths listed; a second message about
    // the same condition is noise. Without this test, "always report" passes.
    const r = driftRemote('new');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = countingNotify(h.bin, notifyLog);
    const guardMarker = join(h.bin, 'guard-invoked');
    const guard = stub(h.bin, 'guard', `touch "${guardMarker}"; echo "REFUSE: stub refusal"; exit 1`);
    const deployLog = join(h.bin, 'deploy.log');
    const deploy = stub(h.bin, 'deploy', `echo called >> "${deployLog}"`);
    // Reachable only if the refusal is skipped; stubbed so this test can never
    // touch real production even then.
    const health = stub(h.bin, 'health', 'exit 0');
    const apiPort = stub(h.bin, 'api-port', 'echo 3000');
    const audit = stub(h.bin, 'audit', 'exit 0');
    // CURRENT, and it must be: a STALE verdict on the pending path is its own
    // REFUSAL (autodeploy.sh:348), which exits before the guard is consulted —
    // a different branch from the one under test. With CURRENT, any second
    // message in the log can only be an idle report that leaked onto the
    // pending path, which is exactly what this test forbids.
    const installedCheck = stub(h.bin, 'ic', 'echo "CURRENT: ok"; exit 0');

    const out = run(h, {
      WBB_NOTIFY_CMD: notify,
      WBB_GUARD: guard,
      WBB_DEPLOY_CMD: deploy,
      WBB_HEALTH_CMD: health,
      WBB_API_PORT_CMD: apiPort,
      WBB_AUDIT_CMD: audit,
      WBB_INSTALLED_CHECK: installedCheck,
      WBB_NOW_S: String(1000000 + 100000),
    });

    expect(out.code).toBe(1);
    expect(existsSync(guardMarker)).toBe(true);   // it WAS treated as work
    expect(countLines(deployLog)).toBe(0);
    // Exactly one message: the guard's verdict. No drift report, though the
    // episode is well past its grace window and would otherwise announce.
    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/REFUSED/);
    expect(readFileSync(notifyLog, 'utf8')).not.toMatch(/BLOCKED/);
  });
});
