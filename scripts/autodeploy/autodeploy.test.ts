import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Merge-deploy (spec docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md).
 *
 * Every external contact of the tick is a WBB_* seam and is stubbed here, so
 * nothing touches sudo, systemd, /opt, GitHub or the network. Only git runs for
 * real, against a throwaway bare "origin" per test. The clock is a file: the
 * clock stub reads it and the sleep stub advances it, so 600 s of quiet or a
 * 10-minute window cost no wall time.
 */
const SCRIPT = resolve(__dirname, '../../deploy/autodeploy.sh');
const SHIPS = resolve(__dirname, '../../deploy/ships.sh');
const RECORD_DEPLOYED = resolve(__dirname, '../../deploy/record-deployed.sh');
const QUIET_S = 600;

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

function commitIn(repo: string, files: Record<string, string>, message: string): string {
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

interface World {
  home: string;
  dataDir: string;
  stateDir: string;
  repo: string;
  bin: string;
  seed: string;
  base: string;
  clock: string;
  eventsLog: string;
  notesLog: string;
}

/** A bare origin with one base commit, a clone of it, and production at base. */
function world(): World {
  const remote = makeTempDirectory('wbb-md-remote-');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = makeTempDirectory('wbb-md-seed-');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  git(seed, 'remote', 'add', 'origin', remote);
  const base = commitIn(seed, {
    'package.json': '{"name":"x","version":"1.0.0"}',
    'deploy/rsync-filter': REAL_FILTER,
    'src/a.ts': 'export const a = 1;\n',
  }, 'base');
  git(seed, 'push', '-q', 'origin', 'main');

  const home = makeTempDirectory('wbb-md-home-');
  const dataDir = join(home, 'data');
  const stateDir = join(home, 'state');
  const repo = join(dataDir, 'wbb-autodeploy', 'repo');
  mkdirSync(join(dataDir, 'wbb-autodeploy'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  execFileSync('git', ['clone', '-q', remote, repo]);
  const bin = makeTempDirectory('wbb-md-bin-');
  const clock = join(bin, 'clock');
  writeFileSync(clock, '100000');
  const w: World = {
    home, dataDir, stateDir, repo, bin, seed, base, clock,
    eventsLog: join(bin, 'events.log'),
    notesLog: join(bin, 'notify.log'),
  };
  seedState(w, { DEPLOYED_SHA: base, PREVIOUS_SHA: '' });
  return w;
}

function push(w: World, files: Record<string, string>, message: string): string {
  const sha = commitIn(w.seed, files, message);
  git(w.seed, 'push', '-q', 'origin', 'main');
  return sha;
}

function seedState(w: World, kv: Record<string, string>): void {
  const dir = join(w.stateDir, 'wbb-autodeploy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.env'), Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}

function readState(w: World): Record<string, string> {
  const p = join(w.stateDir, 'wbb-autodeploy', 'state.env');
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function advance(w: World, s: number): void {
  writeFileSync(w.clock, String(Number(readFileSync(w.clock, 'utf8')) + s));
}

/** Every recorded side effect, in order. */
function events(w: World): string[] {
  return existsSync(w.eventsLog) ? readFileSync(w.eventsLog, 'utf8').split('\n').filter((l) => l !== '') : [];
}

/** One entry per notify call, full text. */
function notes(w: World): string[] {
  return existsSync(w.notesLog)
    ? readFileSync(w.notesLog, 'utf8').split('\n<<END>>\n').filter((m) => m !== '')
    : [];
}

const short = (sha: string) => sha.slice(0, 7);

function stubs(w: World): Record<string, string> {
  const b = w.bin;
  const ev = w.eventsLog;
  const clk = w.clock;
  return {
    WBB_CLOCK_CMD: stub(b, 'clock-cmd', `cat "${clk}"`),
    WBB_SLEEP_CMD: stub(b, 'sleep-cmd', `echo $(( $(cat "${clk}") + $1 )) > "${clk}"`),
    WBB_NOTIFY_CMD: stub(b, 'notify', `printf '%s\\n<<END>>\\n' "$1" >> "${w.notesLog}"`),
    WBB_API_PORT_CMD: stub(b, 'port', 'echo 3000'),
    WBB_BUILD_CMD: stub(b, 'build', `echo "build $(git rev-parse HEAD)" >> "${ev}"`),
    WBB_AUDIT_CMD: stub(b, 'audit', `echo audit >> "${ev}"`),
    // Like the real deploy.sh: records DEPLOYED_SHA itself (so a stale
    // in-memory value in the tick is visible), and complains loudly if the
    // tick did not tell it that the lock is already held (R4).
    WBB_DEPLOY_CMD: stub(b, 'deploy', [
      `[ "\${WBB_TICK_HOLDS_LOCK:-}" = 1 ] || echo "deploy WITHOUT the lock flag" >> "${ev}"`,
      `echo "deploy $(git rev-parse HEAD)" >> "${ev}"`,
      `cat "${clk}" > "${b}/deployed_at"`,
      `"${RECORD_DEPLOYED}" "$(git rev-parse HEAD)" >/dev/null`,
    ].join('\n')),
    WBB_HEALTH_CMD: stub(b, 'health', 'exit 0'),
    WBB_RESTARTS_CMD: stub(b, 'restarts', 'echo 0'),
    WBB_CHECKS_CMD: stub(b, 'checks', `echo "checks $1" >> "${ev}"; printf 'ci\\tcompleted\\tsuccess\\n'`),
    WBB_PR_LABELS_CMD: stub(b, 'labels', `printf '7\\t\\n'`),
    WBB_SNAPSHOT_CMD: stub(b, 'snapshot', `echo "snapshot $(basename "$1")" >> "${ev}"; mkdir -p "$(dirname "$1")"; echo pre > "$1"`),
    WBB_TRIAL_CMD: stub(b, 'trial', `[ -f "$1" ] && echo "trial $(cat "$1")" >> "${ev}"`),
    WBB_PRUNE_CMD: stub(b, 'prune', `echo prune >> "${ev}"`),
    WBB_SERVICE_CMD: stub(b, 'service', `echo "service $1 $2" >> "${ev}"`),
    WBB_MARK_CMD: stub(b, 'mark', `echo "mark $(basename "$1")" >> "${ev}"; echo "\${1%-pre.db}-rollback-pre.db"`),
    WBB_POST_CMD: stub(b, 'post', `echo "post $(basename "$1")" >> "${ev}"`),
    WBB_RESTORE_CMD: stub(b, 'restore', `echo "restore $(basename "$1")" >> "${ev}"`),
    WBB_MARK_UNVERIFIED_CMD: stub(b, 'mark-unverified', `echo "mark-unverified $(basename "$1")" >> "${ev}"; echo "\${1%-pre.db}-unverified-pre.db"`),
    WBB_DISCARD_CMD: stub(b, 'discard', `echo "discard $(basename "$1")" >> "${ev}"`),
    WBB_SNAPSHOT_DIR: join(w.home, 'snapshots'),
    WBB_INSTALLED_CHECK: stub(b, 'installed', 'echo "CURRENT: stub"; exit 0'),
    WBB_SHIPS: SHIPS,
  };
}

function tick(w: World, over: Record<string, string> = {}): { code: number; out: string } {
  const env = {
    ...process.env,
    HOME: w.home,
    XDG_DATA_HOME: w.dataDir,
    XDG_STATE_HOME: w.stateDir,
    ...stubs(w),
    ...over,
  };
  try {
    return { code: 0, out: execFileSync('bash', [SCRIPT], { encoding: 'utf8', env }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/** The tick that first sees the head, then QUIET_S of quiet: the next tick decides. */
function ready(w: World, over: Record<string, string> = {}): void {
  tick(w, over);
  advance(w, QUIET_S);
}

describe('merge-deploy: what gets deployed, and when', () => {
  it('deploys the head of main once it has been quiet for ten minutes and CI passed on it', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');

    const first = tick(w);
    expect(first.code).toBe(0);
    expect(events(w)).toEqual([]);
    expect(readState(w).MAIN_SEEN_SHA).toBe(x);
    expect(readState(w).MAIN_SEEN_S).toBe('100000');

    advance(w, QUIET_S);
    const second = tick(w);

    expect(second.code).toBe(0);
    const stamp = (e: string) => e.replace(/\d{8}T\d{6}Z/, 'STAMP');
    expect(events(w).map(stamp)).toEqual([
      `checks ${x}`,
      `build ${x}`,
      'audit',
      `snapshot STAMP-${short(x)}-pre.db`,
      'trial pre',
      `deploy ${x}`,
      'prune',
    ]);
    expect(readState(w).DEPLOYED_SHA).toBe(x);
    expect(readState(w).PREVIOUS_SHA).toBe(w.base);
    expect(notes(w)).toEqual([`✅ merge-deploy ${short(x)} is live and settled — #7.`]);
  });

  it('does not deploy 599 s after main moved, and does at 600 s', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    tick(w);
    advance(w, 599);
    tick(w);
    expect(events(w)).toEqual([]);

    advance(w, 1);
    tick(w);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });

  it('restarts the quiet period when main moves again, and deploys only the newest head', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'one');
    tick(w);
    advance(w, 300);
    const x2 = push(w, { 'src/a.ts': '3' }, 'two');
    tick(w);
    expect(readState(w).MAIN_SEEN_SHA).toBe(x2);
    expect(readState(w).MAIN_SEEN_S).toBe('100300');
    advance(w, 300);
    tick(w);
    expect(events(w)).toEqual([]);

    advance(w, 300);
    tick(w);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x2}`]);
  });

  it('does nothing, silently, when production is main', () => {
    const w = world();
    const r = tick(w);
    expect(r.code).toBe(0);
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([]);
  });

  it('does not deploy a merge that ships nothing, and says nothing about it', () => {
    const w = world();
    push(w, { 'docs/x.md': 'hello' }, 'docs');
    ready(w);
    const r = tick(w);
    expect(r.code).toBe(0);
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([]);
  });

  it('skips main quietly when it is recorded as LAST_FAILED_SHA', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    seedState(w, { DEPLOYED_SHA: w.base, PREVIOUS_SHA: '', LAST_FAILED_SHA: x });
    ready(w);
    tick(w);
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([]);
  });
});

describe('merge-deploy: shipping classification', () => {
  it.each([
    ['failed classifier', 'exit 1'],
    ['missing answers', 'exit 0'],
    ['answers about other paths', 'echo "SKIP invented.txt"'],
  ])('blocks and reports %s once a day', (_name, body) => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const ships = stub(w.bin, 'ships-broken', body);
    ready(w, { WBB_SHIPS: ships });
    const r = tick(w, { WBB_SHIPS: ships });
    expect(r.code).toBe(0);
    expect(events(w)).toEqual([]);
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(/^⚠️ merge-deploy cannot tell whether production is behind main:/);
  });

  it('holds a change that narrows the shipping filter (R5) instead of deploying it', () => {
    const w = world();
    push(w, { 'deploy/rsync-filter': '- *\n' }, 'narrow filter');
    ready(w);
    tick(w);
    expect(events(w)).toEqual([]);
    expect(notes(w)[0]).toContain('• path deploy/rsync-filter needs a human step');
  });
});

describe('merge-deploy: CI on the exact commit', () => {
  it('waits, silently, while ci is still running', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const checks = stub(w.bin, 'checks-pending', `printf 'ci\\tin_progress\\t\\n'`);
    ready(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([]);
  });

  it('waits while the required ci check has not appeared, even if others passed', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const checks = stub(w.bin, 'checks-no-ci', `printf 'build (root)\\tcompleted\\tsuccess\\n'`);
    ready(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(events(w)).toEqual([]);
  });

  it('reports CI that has not concluded after an hour, once a day', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const checks = stub(w.bin, 'checks-pending', `printf 'ci\\tqueued\\t\\n'`);
    tick(w, { WBB_CHECKS_CMD: checks });
    advance(w, 3599);
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(notes(w)).toEqual([]);

    advance(w, 1);
    tick(w, { WBB_CHECKS_CMD: checks });
    advance(w, 300);
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(/^⚠️ merge-deploy: CI has not concluded on [0-9a-f]{7} after 60 min/);
  });

  it('reports a failed check once, does not record LAST_FAILED_SHA, and a green re-run releases it', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const red = stub(w.bin, 'checks-red', `printf 'ci\\tcompleted\\tfailure\\nbuild (root)\\tcompleted\\tsuccess\\n'`);
    ready(w, { WBB_CHECKS_CMD: red });
    tick(w, { WBB_CHECKS_CMD: red });
    tick(w, { WBB_CHECKS_CMD: red });

    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(new RegExp(`^⛔ merge-deploy: CI failed on ${short(x)} — not deploying\\. ci=failure`));
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
    expect(readState(w).LAST_CI_NOTICE_SHA).toBe(x);
    expect(events(w)).toEqual([]);

    tick(w);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });

  it('does not let skipped or neutral checks block', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const mixed = stub(w.bin, 'checks-mixed',
      `printf 'ci\\tcompleted\\tsuccess\\nclaude\\tcompleted\\tskipped\\nnote\\tcompleted\\tneutral\\n'`);
    ready(w, { WBB_CHECKS_CMD: mixed });
    tick(w, { WBB_CHECKS_CMD: mixed });
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });

  it('treats a cancelled check as a failure', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const cancelled = stub(w.bin, 'checks-cancelled', `printf 'ci\\tcompleted\\tsuccess\\nbuild (root)\\tcompleted\\tcancelled\\n'`);
    ready(w, { WBB_CHECKS_CMD: cancelled });
    tick(w, { WBB_CHECKS_CMD: cancelled });
    expect(events(w)).toEqual([]);
    expect(notes(w)[0]).toMatch(/CI failed on .* build \(root\)=cancelled/);
  });

  it('waits and says so once a day when CI status cannot be read', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const broken = stub(w.bin, 'checks-broken', 'exit 1');
    ready(w, { WBB_CHECKS_CMD: broken });
    tick(w, { WBB_CHECKS_CMD: broken });
    tick(w, { WBB_CHECKS_CMD: broken });
    expect(events(w)).toEqual([]);
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(/^⚠️ merge-deploy cannot read CI status for [0-9a-f]{7}/);
  });
});

describe('merge-deploy: holds', () => {
  it.each([
    ['deploy/sudoers.d/warsaw-beer-bot', true],
    ['deploy/litestream.yml', true],
    ['deploy/litestream.service', true],
    ['deploy/wbb-autodeploy.timer', true],
    ['deploy/wbb-autodeploy.service', true],
    ['deploy/install-autodeploy.sh', true],
    ['deploy/autodeploy.sh', true],
    ['deploy/ships.sh', true],
    ['deploy/read-env.sh', true],
    ['deploy/installed-current.sh', true],
    ['deploy/db-snapshot.sh', true],
    ['deploy/trial-migrate.cjs', true],
    ['deploy/warsaw-beer-bot.service', false],
    ['deploy/deploy.sh', false],
    ['deploy/rsync-filter', true],
    ['src/x.ts', false],
  ])('a change to %s holds the deploy: %s', (path, held) => {
    const w = world();
    push(w, { [path]: 'changed\n' }, 'change');
    ready(w);
    tick(w);
    const deployed = events(w).some((e) => e.startsWith('deploy '));
    expect(deployed).toBe(!held);
  });

  it('names the held path, and says so once a day', () => {
    const w = world();
    push(w, { 'deploy/sudoers.d/warsaw-beer-bot': 'x' }, 'sudoers');
    ready(w);
    tick(w);
    tick(w);
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(/^⏸ merge-deploy: production is behind main and HELD:\n• path deploy\/sudoers\.d\/warsaw-beer-bot needs a human step/);
  });

  it('holds on a PR labelled exactly deploy:hold', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const labels = stub(w.bin, 'labels-hold', `printf '8\\tbug,deploy:hold\\n'`);
    ready(w, { WBB_PR_LABELS_CMD: labels });
    tick(w, { WBB_PR_LABELS_CMD: labels });
    expect(events(w)).toEqual([]);
    expect(notes(w)[0]).toContain('• PR #8 carries deploy:hold — https://github.com/ysilvestrov/warsaw-beer-bot/pull/8');
  });

  it('does not hold on a label that merely contains deploy:hold', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const labels = stub(w.bin, 'labels-near', `printf '8\\tdeploy:hold-later,x-deploy:hold\\n'`);
    ready(w, { WBB_PR_LABELS_CMD: labels });
    tick(w, { WBB_PR_LABELS_CMD: labels });
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });

  it('holds when PR labels cannot be read — fail closed', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const labels = stub(w.bin, 'labels-broken', 'exit 1');
    ready(w, { WBB_PR_LABELS_CMD: labels });
    tick(w, { WBB_PR_LABELS_CMD: labels });
    expect(events(w)).toEqual([]);
    expect(notes(w)[0]).toMatch(/• could not read PR labels for [0-9a-f]{7}/);
  });

  it('a manual deploy past the held commit releases the hold', () => {
    const w = world();
    const held = push(w, { 'deploy/sudoers.d/warsaw-beer-bot': 'x' }, 'sudoers');
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    // What deploy.sh → record-deployed.sh writes after the human's manual deploy.
    seedState(w, { DEPLOYED_SHA: held, PREVIOUS_SHA: w.base });
    ready(w);
    tick(w);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });
});

describe('merge-deploy: refusals', () => {
  it('refuses a commit whose build fails, records LAST_FAILED_SHA, and never deploys it', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const build = stub(w.bin, 'build-red', 'echo "tsc: error TS2322"; exit 2');
    ready(w, { WBB_BUILD_CMD: build });
    const r = tick(w, { WBB_BUILD_CMD: build });
    tick(w, { WBB_BUILD_CMD: build });

    expect(r.code).toBe(1);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(events(w).some((e) => e.startsWith('deploy '))).toBe(false);
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toBe(`⛔ merge-deploy refused ${short(x)}: the build failed.\ntsc: error TS2322`);
  });

  it('refuses a commit whose audit finds a high advisory', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const audit = stub(w.bin, 'audit-red', 'echo "1 high"; exit 1');
    ready(w, { WBB_AUDIT_CMD: audit });
    const r = tick(w, { WBB_AUDIT_CMD: audit });
    expect(r.code).toBe(1);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(notes(w)[0]).toMatch(/^⛔ merge-deploy refused [0-9a-f]{7}: npm audit --omit=dev reports a high or critical advisory\./);
  });

  it('does NOT blame the commit when the audit cannot run', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const audit = stub(w.bin, 'audit-broken', 'echo "ENOTFOUND registry"; exit 2');
    ready(w, { WBB_AUDIT_CMD: audit });
    const r = tick(w, { WBB_AUDIT_CMD: audit });
    expect(r.code).toBe(1);
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
    expect(notes(w)[0]).toMatch(/npm audit could not run \(exit 2\)/);
  });

  it('refuses when production is not an ancestor of main', () => {
    const w = world();
    git(w.seed, 'checkout', '-q', '-b', 'side');
    const side = commitIn(w.seed, { 'src/side.ts': 's' }, 'side');
    git(w.seed, 'push', '-q', 'origin', 'side');
    git(w.seed, 'checkout', '-q', 'main');
    push(w, { 'src/a.ts': '2' }, 'feat');
    seedState(w, { DEPLOYED_SHA: side, PREVIOUS_SHA: '' });
    ready(w);
    const r = tick(w);
    expect(r.code).toBe(0);
    expect(events(w)).toEqual([]);
    expect(notes(w)[0]).toMatch(/is not an ancestor of main/);
  });

  it('asks for a first manual deploy when there is no baseline, once a day', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    seedState(w, { DEPLOYED_SHA: '', PREVIOUS_SHA: '' });
    tick(w);
    tick(w);
    expect(events(w)).toEqual([]);
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(/no recorded baseline/);
  });

  it('waits for a stale installed deployer to be reinstalled, saying so once a day', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const stale = stub(w.bin, 'installed-stale', 'echo "STALE: 1 installed file(s) differ"; exit 1');
    ready(w, { WBB_INSTALLED_CHECK: stale });
    tick(w, { WBB_INSTALLED_CHECK: stale });
    tick(w, { WBB_INSTALLED_CHECK: stale });
    expect(events(w)).toEqual([]);
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(/^⚠️ merge-deploy is waiting: the installed deployer is out of date/);
  });

  it('does nothing at all while PAUSED', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    writeFileSync(join(w.stateDir, 'wbb-autodeploy', 'PAUSED'), '');
    const r = tick(w);
    expect(r.code).toBe(0);
    expect(readState(w).MAIN_SEEN_SHA).toBe(undefined);
    expect(events(w)).toEqual([]);
  });
});

describe('merge-deploy: state and notifications', () => {
  it('drops the obsolete drift keys on the first write', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    seedState(w, { DEPLOYED_SHA: w.base, PREVIOUS_SHA: '', DRIFT_SINCE: '5', LAST_DRIFT_NOTICE: '2026-08-20' });
    tick(w);
    expect(readState(w)).toEqual({ DEPLOYED_SHA: w.base, PREVIOUS_SHA: '', MAIN_SEEN_SHA: x, MAIN_SEEN_S: '100000' });
  });

  it('truncates a message longer than Telegram accepts', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const build = stub(w.bin, 'build-long', `printf 'E%.0s' $(seq 1 5000); echo; exit 2`);
    ready(w, { WBB_BUILD_CMD: build });
    tick(w, { WBB_BUILD_CMD: build });
    expect(notes(w)[0].length).toBe(3500 + '\n… truncated'.length);
    expect(notes(w)[0].endsWith('\n… truncated')).toBe(true);
  });

  it('exits 4 and says so when the state file cannot be written', () => {
    const w = world();
    tick(w); // creates the lock file while the directory is still writable
    push(w, { 'src/a.ts': '2' }, 'feat');
    const dir = join(w.stateDir, 'wbb-autodeploy');
    chmodSync(dir, 0o500);
    try {
      const r = tick(w);
      expect(r.code).toBe(4);
      expect(notes(w)[0]).toMatch(/^🔥 merge-deploy: failed to write /);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe('merge-deploy: snapshot, trial migration, window', () => {
  /** health fails from `from` seconds after the latest deploy onwards. */
  function healthFailingFrom(w: World, from: number): string {
    return stub(w.bin, `health-from-${from}`,
      `now=$(cat "${w.clock}"); d=$(cat "${w.bin}/deployed_at"); [ $(( now - d )) -lt ${from} ]`);
  }

  it('refuses a commit whose trial migration fails, never deploys it, and removes the copy', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const trial = stub(w.bin, 'trial-red', 'echo "TRIAL FAILED: boom"; exit 1');
    ready(w, { WBB_TRIAL_CMD: trial });
    const r = tick(w, { WBB_TRIAL_CMD: trial });
    expect(r.code).toBe(1);
    expect(events(w).some((e) => e.startsWith('deploy '))).toBe(false);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(notes(w)[0]).toBe(`⛔ merge-deploy refused ${short(x)}: the trial migration on a copy of production failed.\nTRIAL FAILED: boom`);
    expect(existsSync(join(w.dataDir, 'wbb-autodeploy', 'trial.db'))).toBe(false);
  });

  it('does not deploy when the snapshot fails, and does not blame the commit', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const snapshot = stub(w.bin, 'snapshot-red', 'echo "disk full" >&2; exit 1');
    ready(w, { WBB_SNAPSHOT_CMD: snapshot });
    const r = tick(w, { WBB_SNAPSHOT_CMD: snapshot });
    expect(r.code).toBe(1);
    expect(events(w).some((e) => e.startsWith('deploy '))).toBe(false);
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
    expect(notes(w)[0]).toMatch(/^⛔ merge-deploy: the pre-deploy DB snapshot failed — not deploying [0-9a-f]{7}\.\ndisk full/);
  });

  it('rolls back when the third failed poll in a row is the last one inside the window (570–590 s)', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 570);
    ready(w, { WBB_HEALTH_CMD: health });
    const r = tick(w, { WBB_HEALTH_CMD: health });
    expect(r.code).toBe(2);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`, `deploy ${w.base}`]);
    expect(notes(w)[0]).toMatch(/failed inside the rollback window: health check failed 3 times in a row \(last at \+590s\)/);
  });

  it('settles when only two failed polls fit inside the window (580–590 s)', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 580);
    ready(w, { WBB_HEALTH_CMD: health });
    const r = tick(w, { WBB_HEALTH_CMD: health });
    expect(r.code).toBe(0);
    expect(readState(w).DEPLOYED_SHA).toBe(x);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });

  it('rolls back when the service restarts inside the window, even if health looks fine', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const restarts = stub(w.bin, 'restarts-bump',
      `now=$(cat "${w.clock}"); d=$(cat "${w.bin}/deployed_at"); [ $(( now - d )) -lt 300 ] && echo 0 || echo 1`);
    ready(w, { WBB_RESTARTS_CMD: restarts });
    const r = tick(w, { WBB_RESTARTS_CMD: restarts });
    expect(r.code).toBe(2);
    expect(notes(w)[0]).toMatch(/service restarted \(NRestarts 0 -> 1\) at \+300s/);
  });

  it('keeps a settled deploy settled when pruning fails', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const prune = stub(w.bin, 'prune-red', 'exit 1');
    ready(w, { WBB_PRUNE_CMD: prune });
    const r = tick(w, { WBB_PRUNE_CMD: prune });
    expect(r.code).toBe(0);
    expect(readState(w).DEPLOYED_SHA).toBe(x);
  });

  it('lets the service unit outlive the window', () => {
    const unit = readFileSync(resolve(__dirname, '../../deploy/wbb-autodeploy.service'), 'utf8');
    expect(unit).toMatch(/^TimeoutStartSec=30min$/m);
  });
});

describe('merge-deploy: rollback restores code AND database', () => {
  function healthFailingFrom(w: World, from: number): string {
    return stub(w.bin, `health-from-${from}`,
      `now=$(cat "${w.clock}"); d=$(cat "${w.bin}/deployed_at"); [ $(( now - d )) -lt ${from} ]`);
  }
  const stamp = (e: string) => e.replace(/\d{8}T\d{6}Z/, 'STAMP');

  it('stops, keeps post, restores pre, and redeploys the old code — in that order', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 300);
    ready(w, { WBB_HEALTH_CMD: health });
    const r = tick(w, { WBB_HEALTH_CMD: health });

    expect(r.code).toBe(2);
    const ev = events(w).map(stamp);
    expect(ev.slice(ev.indexOf(`deploy ${x}`))).toEqual([
      `deploy ${x}`,
      'service stop warsaw-beer-bot',
      'service stop litestream',
      `mark STAMP-${short(x)}-pre.db`,
      `post STAMP-${short(x)}-rollback-post`,
      `restore STAMP-${short(x)}-rollback-pre.db`,
      'service start litestream',
      `deploy ${w.base}`,
    ]);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(readState(w).DEPLOYED_SHA).toBe(w.base);
    const last = notes(w)[notes(w).length - 1];
    expect(last).toMatch(new RegExp(`^🔥 merge-deploy ROLLED BACK ${short(x)} → ${short(w.base)}, code AND database\\.`));
    expect(last).toMatch(/Writes between \d\d:\d\d:\d\d and \d\d:\d\d:\d\d UTC exist only in: \S+-rollback-post\n/);
    expect(last).toMatch(/Pre-deploy snapshot now live: \S+-rollback-pre\.db\n/);
  });

  it('restores the database too when the new code never comes up', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = stub(w.bin, 'health-x-bad', `tail -n1 "${w.eventsLog}" | grep -q "deploy ${x}" && exit 1; exit 0`);
    ready(w, { WBB_HEALTH_CMD: health });
    const r = tick(w, { WBB_HEALTH_CMD: health });
    expect(r.code).toBe(2);
    expect(events(w).map(stamp)).toContain(`restore STAMP-${short(x)}-rollback-pre.db`);
    expect(notes(w)[0]).toMatch(/not healthy within 120s/);
  });

  it('stops at a failed restore, says ROLLBACK FAILED with both paths, and deploys nothing more', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 300);
    const restore = stub(w.bin, 'restore-red', `echo "restore $(basename "$1")" >> "${w.eventsLog}"; exit 1`);
    ready(w, { WBB_HEALTH_CMD: health, WBB_RESTORE_CMD: restore });
    const r = tick(w, { WBB_HEALTH_CMD: health, WBB_RESTORE_CMD: restore });

    expect(r.code).toBe(3);
    expect(events(w).map(stamp).slice(-1)).toEqual([`restore STAMP-${short(x)}-rollback-pre.db`]);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
    const last = notes(w)[notes(w).length - 1];
    expect(last).toMatch(/^🔥 ROLLBACK FAILED at: restore pre\. /);
    expect(last).toMatch(/pre=\S+-rollback-pre\.db post=\S+-rollback-post/);
  });

  it('records LAST_FAILED_SHA before the first rollback step can fail', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 300);
    const service = stub(w.bin, 'service-red', 'exit 1');
    ready(w, { WBB_HEALTH_CMD: health, WBB_SERVICE_CMD: service });
    const r = tick(w, { WBB_HEALTH_CMD: health, WBB_SERVICE_CMD: service });
    expect(r.code).toBe(3);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(notes(w)[notes(w).length - 1]).toMatch(/^🔥 ROLLBACK FAILED at: stop warsaw-beer-bot\./);
  });
});

describe('merge-deploy: review fixes R2–R9', () => {
  function healthFailingFrom(w: World, from: number): string {
    return stub(w.bin, `health-from-${from}`,
      `now=$(cat "${w.clock}"); d=$(cat "${w.bin}/deployed_at"); [ $(( now - d )) -lt ${from} ]`);
  }
  const stamp = (e: string) => e.replace(/\d{8}T\d{6}Z/, 'STAMP');
  /** A stub that answers the Nth call (1-based) from `answers`, `exit 1` for 'X'. */
  function sequence(w: World, name: string, answers: string[], rest: string): string {
    const n = join(w.bin, `${name}.n`);
    const cases = answers.map((a, i) => `${i + 1}) ${a === 'X' ? 'exit 1' : `echo ${a}`} ;;`).join(' ');
    return stub(w.bin, name,
      `c=$(( $(cat "${n}" 2>/dev/null || echo 0) + 1 )); echo "$c" > "${n}"; case "$c" in ${cases} *) echo ${rest} ;; esac`);
  }

  it('R6: a single failed poll inside the window does not roll back', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const blip = stub(w.bin, 'health-blip',
      `now=$(cat "${w.clock}"); d=$(cat "${w.bin}/deployed_at"); [ $(( now - d )) -ne 10 ]`);
    ready(w, { WBB_HEALTH_CMD: blip });
    const r = tick(w, { WBB_HEALTH_CMD: blip });
    expect(r.code).toBe(0);
    expect(readState(w).DEPLOYED_SHA).toBe(x);
  });

  it('R4: the tick tells deploy.sh that it already holds the lock, on deploy and on rollback', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 300);
    ready(w, { WBB_HEALTH_CMD: health });
    tick(w, { WBB_HEALTH_CMD: health });
    expect(events(w).filter((e) => e.startsWith('deploy ')).length).toBe(2);
    expect(events(w)).not.toContain('deploy WITHOUT the lock flag');
  });

  it('R3: a baseline read only after a failed first read still catches a restart', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const restarts = sequence(w, 'restarts-late', ['X', '1', '1'], '2');
    ready(w, { WBB_RESTARTS_CMD: restarts });
    const r = tick(w, { WBB_RESTARTS_CMD: restarts });
    expect(r.code).toBe(2);
    expect(notes(w)[0]).toMatch(/service restarted \(NRestarts 1 -> 2\) at \+30s/);
  });

  it('R3: one unreadable poll in the middle is neither a restart nor a failure', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const restarts = sequence(w, 'restarts-gap', ['0', '0', '0', '0', '0', 'X'], '0');
    ready(w, { WBB_RESTARTS_CMD: restarts });
    const r = tick(w, { WBB_RESTARTS_CMD: restarts });
    expect(r.code).toBe(0);
    expect(readState(w).DEPLOYED_SHA).toBe(x);
  });

  it('R3: a window in which NRestarts was never readable ends unverified, keeping pre', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const restarts = stub(w.bin, 'restarts-dead', 'exit 1');
    ready(w, { WBB_RESTARTS_CMD: restarts });
    const r = tick(w, { WBB_RESTARTS_CMD: restarts });
    expect(r.code).toBe(0);
    expect(events(w).map(stamp).slice(-1)).toEqual([`mark-unverified STAMP-${short(x)}-pre.db`]);
    expect(readState(w).DEPLOYED_SHA).toBe(x);
    expect(readState(w).PREVIOUS_SHA).toBe(w.base);
    expect(notes(w)[0]).toMatch(new RegExp(`^⚠️ merge-deploy ${short(x)} is live but UNVERIFIED: NRestarts could not be read once during the window\\. Nothing was rolled back\\.`));
  });

  it('R2: a tick killed inside the window leaves the window in state, and the next tick finishes it', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    // Kills the tick itself (its parent) once, at +100 s.
    const killer = stub(w.bin, 'health-killer', [
      `now=$(cat "${w.clock}"); d=$(cat "${w.bin}/deployed_at")`,
      `if [ $(( now - d )) -ge 100 ] && [ ! -f "${w.bin}/killed" ]; then touch "${w.bin}/killed"; kill -9 $PPID; fi`,
      'exit 0',
    ].join('\n'));
    ready(w, { WBB_HEALTH_CMD: killer });
    const dead = tick(w, { WBB_HEALTH_CMD: killer });
    expect(dead.code).toBe(null);
    expect(readState(w).WINDOW_SHA).toBe(x);
    expect(readState(w).DEPLOYED_SHA).toBe(x);
    expect(notes(w)).toEqual([]);

    const r = tick(w, { WBB_HEALTH_CMD: killer });
    expect(r.code).toBe(0);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
    expect(readState(w).PREVIOUS_SHA).toBe(w.base);
    expect(readState(w).WINDOW_SHA).toBe(undefined);
    expect(notes(w)).toEqual([`✅ merge-deploy ${short(x)} is live and settled.`]);
  });

  it('R2: a window found after it would have ended is reported unverified, not settled', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    seedState(w, {
      DEPLOYED_SHA: x, PREVIOUS_SHA: '', MAIN_SEEN_SHA: x, MAIN_SEEN_S: '100000',
      WINDOW_SHA: x, WINDOW_OLD: w.base, WINDOW_PRE: '/s/20260930T120000Z-abcdef0-pre.db',
      WINDOW_PRE_T: '12:00:00', WINDOW_START: '99000',
    });
    const r = tick(w);
    expect(r.code).toBe(0);
    expect(events(w)).toEqual(['mark-unverified 20260930T120000Z-abcdef0-pre.db']);
    expect(readState(w)).toEqual({ DEPLOYED_SHA: x, PREVIOUS_SHA: w.base, MAIN_SEEN_SHA: x, MAIN_SEEN_S: '100000' });
    expect(notes(w)[0]).toMatch(/is live but UNVERIFIED: the tick that deployed it died inside its window\./);
  });

  it('R2: a deploy interrupted before deploy.sh finished is reported, cleared, and redeployed', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    seedState(w, {
      DEPLOYED_SHA: w.base, PREVIOUS_SHA: '', MAIN_SEEN_SHA: x, MAIN_SEEN_S: '99000',
      WINDOW_SHA: x, WINDOW_OLD: w.base, WINDOW_PRE: '/s/20260930T120000Z-abcdef0-pre.db', WINDOW_PRE_T: '12:00:00',
    });
    const r = tick(w);
    expect(r.code).toBe(0);
    expect(notes(w)[0]).toMatch(/^⚠️ merge-deploy: the deploy of [0-9a-f]{7} was interrupted before deploy\.sh completed\./);
    expect(notes(w)[0]).toContain('/s/20260930T120000Z-abcdef0-unverified-pre.db');
    expect(events(w)[0]).toBe('mark-unverified 20260930T120000Z-abcdef0-pre.db');
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
    expect(readState(w).WINDOW_SHA).toBe(undefined);
  });

  it('R7: a failed API_PORT read refuses the deploy instead of guessing 3000', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const readEnv = stub(w.bin, 'read-env-broken', 'exit 1');
    const over = { WBB_API_PORT_CMD: '', WBB_READ_ENV_CMD: readEnv };
    ready(w, over);
    const r = tick(w, over);
    expect(r.code).toBe(1);
    expect(events(w).some((e) => e.startsWith('deploy '))).toBe(false);
    expect(notes(w)[0]).toMatch(/could not resolve API_PORT/);
  });

  it('R9: a trial refusal discards its pre snapshot', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const trial = stub(w.bin, 'trial-red', 'echo "TRIAL FAILED: boom"; exit 1');
    ready(w, { WBB_TRIAL_CMD: trial });
    tick(w, { WBB_TRIAL_CMD: trial });
    expect(events(w).map(stamp).slice(-1)).toEqual([`discard STAMP-${short(x)}-pre.db`]);
  });

  it('a failed health check after the rollback is a ROLLBACK FAILED, not a success', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const down = stub(w.bin, 'health-down', 'exit 1');
    ready(w, { WBB_HEALTH_CMD: down });
    const r = tick(w, { WBB_HEALTH_CMD: down });
    expect(r.code).toBe(3);
    expect(notes(w)[notes(w).length - 1]).toMatch(/^🔥 ROLLBACK FAILED at: health after the rollback\./);
  });

  it('after a completed rollback, state says the old commit again', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 300);
    ready(w, { WBB_HEALTH_CMD: health });
    tick(w, { WBB_HEALTH_CMD: health });
    // The stub deploy recorded x first (as deploy.sh does), so this is a real reset.
    expect(readState(w)).toEqual({
      DEPLOYED_SHA: w.base, PREVIOUS_SHA: '', LAST_FAILED_SHA: x, MAIN_SEEN_SHA: x, MAIN_SEEN_S: '100000',
    });
  });

  it('R6: failures that are not consecutive never roll back', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    // Every other poll fails: 0 ok, 10 fail, 20 ok, 30 fail, ...
    const flaky = stub(w.bin, 'health-flaky',
      `now=$(cat "${w.clock}"); d=$(cat "${w.bin}/deployed_at"); [ $(( (now - d) / 10 % 2 )) -eq 0 ]`);
    ready(w, { WBB_HEALTH_CMD: flaky });
    const r = tick(w, { WBB_HEALTH_CMD: flaky });
    expect(r.code).toBe(0);
    expect(readState(w).DEPLOYED_SHA).toBe(x);
  });

  it('a tick that dies in the middle of a rollback is reported by the next one, once', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 300);
    // Dies (kills the tick) when asked to stop litestream — mid-rollback.
    const service = stub(w.bin, 'service-dies', [
      `echo "service $1 $2" >> "${w.eventsLog}"`,
      `if [ "$1 $2" = "stop litestream" ]; then kill -9 $PPID; fi`,
    ].join('\n'));
    ready(w, { WBB_HEALTH_CMD: health, WBB_SERVICE_CMD: service });
    const dead = tick(w, { WBB_HEALTH_CMD: health, WBB_SERVICE_CMD: service });
    expect(dead.code).toBe(null);
    expect(readState(w).ROLLBACK_STARTED).toBe('1');

    const r = tick(w);
    tick(w);
    expect(r.code).toBe(3);
    const fire = notes(w).filter((n) => n.startsWith('🔥'));
    expect(fire.length).toBe(1);
    expect(fire[0]).toMatch(new RegExp(`^🔥 ROLLBACK INTERRUPTED: the tick died while rolling ${short(x)} back to ${short(w.base)}\\.`));
    expect(readState(w).ROLLBACK_STARTED).toBe(undefined);
    expect(readState(w).WINDOW_SHA).toBe(undefined);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
  });
});
