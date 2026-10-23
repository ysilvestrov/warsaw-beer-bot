import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeTempDirectory } from '../test-temp';
import {
  CORRUPT_STATES, SCRIPT, events, holdLock, imageWorld, notes, settledState, stateText, stub, tick, writeStateText,
} from './image-autodeploy-harness';

vi.setConfig({ testTimeout: 20_000 });

/**
 * Stage «в» core, Task 2 (docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-core.md,
 * "Рішення" п.6–7): the controller's `--check-state`, and deploy/migrate-state-to-image.sh, which carries
 * the flat deployer's gate keys into image-state.env and asks the real controller (this repository's
 * deploy/autodeploy.sh, as WBB_CONTROLLER) to accept them. Expected files and texts are literals.
 */
const MIGRATE = resolve(__dirname, '../../deploy/migrate-state-to-image.sh');
// The local gate runs as another user than the checkout's owner, where git refuses the repo (safe.directory).
const GIT_ENV = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: resolve(__dirname, '../..') };

describe('autodeploy.sh --check-state', () => {
  const check = (w: ReturnType<typeof imageWorld>) => tick(w, {}, ['--check-state']);

  it('a valid state: STATE OK (0), no seam called, nothing written, no lock taken', () => {
    const w = imageWorld();
    const before = stateText(w);
    const r = check(w);
    expect([r.code, r.out, stateText(w), events(w), notes(w), existsSync(join(w.stateDir, 'lock'))])
      .toEqual([0, `STATE OK — ${w.statePath}\n`, before, [], [], false]);
  });

  it('answers while a tick holds the lock: it never waits for it', async () => {
    const w = imageWorld();
    const holder = await holdLock(join(w.stateDir, 'lock'));
    try {
      expect([check(w).code, check(w).out]).toEqual([0, `STATE OK — ${w.statePath}\n`]);
    } finally {
      holder.kill();
    }
  });

  it('no file: its own reason (3), never a first start', () => {
    const w = imageWorld();
    rmSync(w.statePath);
    const r = check(w);
    expect([r.code, r.out, existsSync(w.statePath), events(w)]).toEqual([3, `STATE MISSING — ${w.statePath}: no such file\n`, false, []]);
  });

  it.each(CORRUPT_STATES)('%s: the reason (3), the file untouched, nothing told', (_name, build, problem) => {
    const w = imageWorld();
    const text = build(w);
    writeStateText(w, text);
    const r = check(w);
    expect([r.code, r.out, stateText(w), events(w), notes(w), existsSync(join(w.stateDir, 'image-state-corrupt-notice'))])
      .toEqual([3, `STATE CORRUPT — ${w.statePath}: ${problem}\n`, text, [], [], false]);
  });

  it('a file it cannot read: that reason (3), not a NUL byte', () => {
    const w = imageWorld();
    chmodSync(w.statePath, 0o000);
    try {
      const r = check(w);
      expect([r.code, r.out]).toEqual([3, `STATE CORRUPT — ${w.statePath}: the file cannot be read\n`]);
    } finally {
      chmodSync(w.statePath, 0o644);
    }
    expect(readFileSync(w.statePath, 'utf8')).toBe(Object.entries(settledState(w.settled)).map(([k, v]) => `${k}=${v}\n`).join(''));
  });
});

// --- the migration ---------------------------------------------------------------------------------------

const D = '4f3c2b1a0918273645546372819a0b1c2d3e4f50';
const P = '0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e';
const F = '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b';
const M = '7e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b';
const R = '5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928';

/** state.env as the host's flat deployer left it (the keys of the probe of 21.10), in its write order. */
const PROD = [
  `DEPLOYED_SHA=${D}`, `PREVIOUS_SHA=${P}`, `LAST_SEEN_DEPLOYED_SHA=${D}`, `LAST_FAILED_SHA=${F}`,
  `MAIN_SEEN_SHA=${M}`, 'MAIN_SEEN_S=1792653900', `LAST_CI_NOTICE_SHA=${F}`,
  'LAST_HOLD_NOTICE=2026-10-20', 'LAST_ASSESS_NOTICE=2026-10-21', '',
].join('\n');

/** What the migration writes from PROD: the gate keys, in the controller's order, no daily marker. */
const PROD_IMAGE = [
  `DEPLOYED_SHA=${D}`, `PREVIOUS_SHA=${P}`, `LAST_SEEN_DEPLOYED_SHA=${D}`, `LAST_FAILED_SHA=${F}`,
  `MAIN_SEEN_SHA=${M}`, 'MAIN_SEEN_S=1792653900', `LAST_CI_NOTICE_SHA=${F}`, '',
].join('\n');

const README = `This directory stands where the flat deployer's state.env was.

The flat deployer (rsync of the tree into /opt/warsaw-beer-bot) was replaced by the image controller.
Its gate keys were carried into image-state.env (deploy/migrate-state-to-image.sh); the old file is
state.env.flat, next to this directory, for diagnosis only — nothing reads it.

A directory here makes old copies of the flat deploy.sh refuse before their first sudo.
See deploy/README.md in the repository.
`;

interface Host { home: string; stateHome: string; dir: string; bin: string; flat: string; image: string }

/** The operator's state directory with state.env and the deploy lock file, a stopped timer, the operator's uid. */
function host(flatText: string = PROD): Host {
  const home = makeTempDirectory('wbb-migrate-home-');
  const stateHome = join(home, 'state');
  const dir = join(stateHome, 'wbb-autodeploy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lock'), '');
  writeFileSync(join(dir, 'state.env'), flatText);
  const bin = makeTempDirectory('wbb-migrate-bin-');
  stub(bin, 'systemctl', 'echo inactive; exit 3');
  stub(bin, 'uid', 'echo 1000');
  return { home, stateHome, dir, bin, flat: join(dir, 'state.env'), image: join(dir, 'image-state.env') };
}

function migrate(h: Host, over: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [MIGRATE], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: h.home,
      XDG_STATE_HOME: h.stateHome,
      WBB_SYSTEMCTL_CMD: join(h.bin, 'systemctl'),
      WBB_UID_CMD: join(h.bin, 'uid'),
      WBB_CONTROLLER: SCRIPT,
      ...over,
    },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Every entry under the state directory: a file with its bytes, a directory as such. */
function tree(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel)).sort().flatMap((name) => {
    const p = join(rel, name);
    return lstatSync(join(dir, p)).isDirectory()
      ? [`${p}/`, ...tree(dir, p)]
      : [`${p} = ${readFileSync(join(dir, p), 'utf8')}`];
  });
}

const refused = (reason: string) => `REFUSED: ${reason}\nNothing was changed.\n`;

describe('deploy/migrate-state-to-image.sh', () => {
  it('carries the gate keys of a production state.env, keeps the old file byte for byte, and leaves a README', () => {
    const h = host();
    const r = migrate(h);
    expect([r.code, r.stderr]).toEqual([0, '']);
    expect(tree(h.dir)).toEqual([
      `image-state.env = ${PROD_IMAGE}`,
      'lock = ',
      'state.env/',
      `state.env/README = ${README}`,
      `state.env.flat = ${PROD}`,
    ]);
    expect(r.stdout).toBe([
      `Carried into ${h.image}:`,
      `  DEPLOYED_SHA=${D}`, `  PREVIOUS_SHA=${P}`, `  LAST_SEEN_DEPLOYED_SHA=${D}`, `  LAST_FAILED_SHA=${F}`,
      `  MAIN_SEEN_SHA=${M}`, '  MAIN_SEEN_S=1792653900', `  LAST_CI_NOTICE_SHA=${F}`,
      `STATE OK — ${h.image}`,
      `Old state: ${h.flat}.flat (state.env is now a directory with a README).`,
      'Next: step 7 of deploy/README.md → Switchover session — sudo bash deploy/install-image.sh, sudo bash deploy/install-image.sh --check, sudo bash deploy/install-autodeploy.sh, sudo bash deploy/install-host-patch-collector.sh; then step 8, the bootstrap.',
      '',
    ].join('\n'));
  });

  it('carries the regression fence, and drops an empty PREVIOUS_SHA, the drift keys and every daily marker', () => {
    // record-deployed.sh moves DEPLOYED_SHA to the end; the flat deployer always writes PREVIOUS_SHA.
    const h = host([
      'PREVIOUS_SHA=', `LAST_SEEN_DEPLOYED_SHA=${R}`, `REGRESSION_FROM_SHA=${R}`, `REGRESSION_TO_SHA=${D}`,
      'DRIFT_SINCE=5', 'LAST_DRIFT_NOTICE=2026-08-20', 'LAST_STALE_NOTICE=2026-10-19', `DEPLOYED_SHA=${D}`, '',
    ].join('\n'));
    expect(migrate(h).code).toBe(0);
    expect(readFileSync(h.image, 'utf8')).toBe(
      `DEPLOYED_SHA=${D}\nLAST_SEEN_DEPLOYED_SHA=${R}\nREGRESSION_FROM_SHA=${R}\nREGRESSION_TO_SHA=${D}\n`);
  });

  it('a second run is refused: state.env is a directory now', () => {
    const h = host();
    migrate(h);
    const after = tree(h.dir);
    const r = migrate(h);
    expect([r.code, r.stderr, tree(h.dir)]).toEqual([
      1, refused(`${h.flat} is not a regular file — nothing to carry (a directory there means it was migrated already)`), after,
    ]);
  });

  // Plan п.9: the checkout's own controller judges, by default — not the installed copy.
  it('validates with the controller next to it when WBB_CONTROLLER is not set', () => {
    const h = host();
    const r = migrate(h, { WBB_CONTROLLER: '' });
    expect([r.code, r.stderr, readFileSync(h.image, 'utf8')]).toEqual([0, '', PROD_IMAGE]);
  });

  // Plan п.13: a run killed after image-state.env was written (before or between the renames) left it
  // holding exactly what is carried, and maybe a prepared state.env.new/: a re-run finishes.
  it('finishes a run killed after image-state.env was written: the renames, nothing else', () => {
    const h = host();
    writeFileSync(h.image, PROD_IMAGE);
    mkdirSync(`${h.flat}.new`);
    writeFileSync(`${h.flat}.new/README`, 'half written');
    const r = migrate(h);
    expect([r.code, r.stderr, r.stdout.split('\n')[0]]).toEqual([
      0, '', `Finished an interrupted migration: ${h.image} already held exactly the carried keys.`,
    ]);
    expect(tree(h.dir)).toEqual([
      `image-state.env = ${PROD_IMAGE}`,
      'lock = ',
      'state.env/',
      `state.env/README = ${README}`,
      `state.env.flat = ${PROD}`,
    ]);
  });

  it('never runs a value: $(touch …) stays text and is refused as not of its format', () => {
    const h = host();
    const marker = join(h.bin, 'executed');
    writeFileSync(h.flat, PROD.replace(`LAST_FAILED_SHA=${F}`, `LAST_FAILED_SHA=$(touch ${marker})`));
    const before = tree(h.dir);
    const r = migrate(h);
    expect([r.code, r.stderr, existsSync(marker), tree(h.dir)]).toEqual([
      1, refused(`${h.flat} line 4: LAST_FAILED_SHA has a value that is not of its format`), false, before,
    ]);
  });

  describe('refuses, changing nothing', () => {
    it.each<[string, Record<string, string>, string]>([
      ['the timer is active', { systemctl: 'echo active' }, "the timer is not stopped (systemctl is-active wbb-autodeploy.timer: 'active') — sudo systemctl disable --now wbb-autodeploy.timer first"],
      ['the timer\'s state cannot be read', { systemctl: 'exit 1' }, "the timer is not stopped (systemctl is-active wbb-autodeploy.timer: '') — sudo systemctl disable --now wbb-autodeploy.timer first"],
      ['run as root', { uid: 'echo 0' }, 'run this as the operator, not as root: the state is the operator\'s (~/.local/state/wbb-autodeploy)'],
    ])('%s', (_name, stubs, reason) => {
      const h = host();
      for (const [name, body] of Object.entries(stubs)) stub(h.bin, name, body);
      const before = tree(h.dir);
      const r = migrate(h);
      expect([r.code, r.stderr, tree(h.dir)]).toEqual([1, refused(reason), before]);
    });

    it('the deploy lock is held', async () => {
      const h = host();
      const before = tree(h.dir);
      const holder = await holdLock(join(h.dir, 'lock'));
      try {
        const r = migrate(h);
        expect([r.code, r.stderr, tree(h.dir)]).toEqual([1, refused(`the deploy lock is held (a tick or a deploy.sh) — fuser -v ${join(h.dir, 'lock')}`), before]);
      } finally {
        holder.kill();
      }
    });

    it('image-state.env exists', () => {
      const h = host();
      writeFileSync(h.image, `DEPLOYED_SHA=${D}\n`);
      const before = tree(h.dir);
      const r = migrate(h);
      expect([r.code, r.stderr, tree(h.dir)]).toEqual([
        1, refused(`${h.image} already exists — the state was migrated already, or the image controller wrote it`), before,
      ]);
    });

    it('state.env.new exists and is not a directory', () => {
      const h = host();
      writeFileSync(`${h.flat}.new`, 'x\n');
      const before = tree(h.dir);
      const r = migrate(h);
      expect([r.code, r.stderr, tree(h.dir)]).toEqual([1, refused(`${h.flat}.new exists and is not the directory this script prepares`), before]);
    });

    // Plan п.9: success is exit 0 AND the exact line — a controller that says nothing of the state
    // (the old flat one, finding the lock busy) must not pass.
    it('a controller that exits 0 without `STATE OK — <path>`: refused, the new file removed, no lock-busy-since', () => {
      const h = host();
      const ctl = stub(h.bin, 'ctl-silent', 'echo "another process holds the lock (0s); exiting"; exit 0');
      const before = tree(h.dir);
      const r = migrate(h, { WBB_CONTROLLER: ctl });
      expect([r.code, r.stderr, tree(h.dir)]).toEqual([
        1,
        refused(`the controller (${ctl}) does not accept the carried state (exit 0, want exactly 'STATE OK — ${h.image}'): another process holds the lock (0s); exiting`),
        before,
      ]);
    });

    it('the old flat controller (e8f20e9) as the controller: refused, nothing migrated', () => {
      const h = host();
      const old = join(h.bin, 'old-autodeploy.sh');
      writeFileSync(old, spawnSync('git', ['show', 'e8f20e9:deploy/autodeploy.sh'], { cwd: resolve(__dirname, '../..'), env: { ...process.env, ...GIT_ENV } }).stdout);
      chmodSync(old, 0o755);
      const before = tree(h.dir);
      const r = migrate(h, { WBB_CONTROLLER: old });
      // The old controller, finding the lock busy, records lock-busy-since as it always did; that is its
      // file, not the migration's. Everything the migration owns is as before.
      // Its message names how long it found the lock held, in whole seconds of the wall clock.
      expect([r.code, r.stderr.replace(/lock \(\d+s\)/, 'lock (Ns)'), tree(h.dir).filter((e) => !e.startsWith('lock-busy-since'))]).toEqual([
        1,
        refused(`the controller (${old}) does not accept the carried state (exit 0, want exactly 'STATE OK — ${h.image}'): another process holds the lock (Ns); exiting`),
        before,
      ]);
    });

    it('state.env.flat exists', () => {
      const h = host();
      writeFileSync(`${h.flat}.flat`, 'old\n');
      const before = tree(h.dir);
      const r = migrate(h);
      expect([r.code, r.stderr, tree(h.dir)]).toEqual([1, refused(`${h.flat}.flat already exists — it would be overwritten`), before]);
    });

    it.each([
      ['an unknown key', `${PROD}DEPLOYED_TAG=v1\n`, 'line 10: unknown key DEPLOYED_TAG'],
      ['a duplicated key', `${PROD}DEPLOYED_SHA=${P}\n`, 'line 10: duplicate key DEPLOYED_SHA'],
      ['a duplicated daily marker', `${PROD}LAST_HOLD_NOTICE=2026-10-22\n`, 'line 10: duplicate key LAST_HOLD_NOTICE'],
      ['a short SHA', PROD.replace(`PREVIOUS_SHA=${P}`, `PREVIOUS_SHA=${P.slice(0, 7)}`), 'line 2: PREVIOUS_SHA has a value that is not of its format'],
      ['a leading zero', PROD.replace('MAIN_SEEN_S=1792653900', 'MAIN_SEEN_S=0179265390'), 'line 6: MAIN_SEEN_S has a value that is not of its format'],
      ['a line that is not KEY=value', `# by hand\n${PROD}`, 'line 1 is not KEY=value'],
      ['a flat window still open', `${PROD}WINDOW_SHA=${D}\n`,
        'line 10: WINDOW_SHA — a flat deploy window or rollback is unfinished; let the flat deployer finish it first'],
      ['a flat rollback still running', `${PROD}ROLLBACK_STARTED=1\n`,
        'line 10: ROLLBACK_STARTED — a flat deploy window or rollback is unfinished; let the flat deployer finish it first'],
      ['no DEPLOYED_SHA (a cleared baseline)', PROD.replace(`DEPLOYED_SHA=${D}\n`, 'DEPLOYED_SHA=\n'),
        'records no DEPLOYED_SHA — the first image release starts from the commit the flat tree runs'],
    ])('%s', (_name, text, reason) => {
      const h = host(text);
      const before = tree(h.dir);
      const r = migrate(h);
      expect([r.code, r.stderr, tree(h.dir)]).toEqual([1, refused(`${h.flat} ${reason}`), before]);
    });

    it.each([
      ['a truncated file', PROD.slice(0, -1), ': the last line has no newline (a truncated file)'],
      ['an empty file', '', ' is empty'],
    ])('%s', (_name, text, reason) => {
      const h = host(text);
      const before = tree(h.dir);
      const r = migrate(h);
      expect([r.code, r.stderr, tree(h.dir)]).toEqual([1, refused(`${h.flat}${reason}`), before]);
    });

    it('state.env is already a directory', () => {
      const h = host();
      rmSync(h.flat);
      mkdirSync(h.flat);
      const before = tree(h.dir);
      const r = migrate(h);
      expect([r.code, r.stderr, tree(h.dir)]).toEqual([
        1, refused(`${h.flat} is not a regular file — nothing to carry (a directory there means it was migrated already)`), before,
      ]);
    });

    // The controller is the judge: a fence without its other half passes the line check here and
    // fails the controller's (REGRESSION_FROM_SHA and REGRESSION_TO_SHA go together).
    it('the controller\'s --check-state refuses what was carried: the new file is removed again', () => {
      const h = host(`${PROD}REGRESSION_FROM_SHA=${R}\n`);
      const before = tree(h.dir);
      const r = migrate(h);
      expect([r.code, r.stderr, tree(h.dir)]).toEqual([
        1,
        refused(`the controller (${SCRIPT}) does not accept the carried state (exit 3, want exactly 'STATE OK — ${h.image}'): STATE CORRUPT — ${h.image}: REGRESSION_FROM_SHA is set but REGRESSION_TO_SHA is not`),
        before,
      ]);
    });
  });

  it('takes no arguments (64), changing nothing', () => {
    const h = host();
    const before = tree(h.dir);
    const r = spawnSync('bash', [MIGRATE, '--force'], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: h.stateHome } });
    expect([r.status, r.stderr, tree(h.dir)]).toEqual([64, 'usage: bash deploy/migrate-state-to-image.sh   (no arguments)\n', before]);
  });
});
