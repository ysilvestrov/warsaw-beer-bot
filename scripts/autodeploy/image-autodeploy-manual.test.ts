import { describe, it, expect, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOT_ID, DAY1,
  advance, checksStub, commitTo, events, fault, git, golden, hostRead, hostSet, imageOf, imageWorld, manual, notes, patchState, publish, push,
  readState, reply, runImage, seedState, settledState, short, stateAtActivate, stateText, stub, tick, writeStateText,
  type Image, type ImageWorld,
} from './image-autodeploy-harness';

// A manual deploy watches a whole simulated 10-minute window in the foreground (61 polls).
vi.setConfig({ testTimeout: 60_000 });

/**
 * The controller's manual entry `--manual deploy` — Task 2 of
 * docs/superpowers/plans/2026-10/2026-10-21-wbb-image-transition-b2-core.md ("Рішення" 1–12; spec §7.4):
 * the same state, the same pipeline and the same window as the tick, with the manual gates of the
 * table in §7.4. Bullets (а)–(л) of the task are the describe blocks below.
 */

const USAGE = 'usage: autodeploy.sh                     (no arguments: the timer\'s tick)\n'
  + '       autodeploy.sh --manual deploy --target <sha> [--force] [--ack-incompatible]\n'
  + '       autodeploy.sh --manual bootstrap --target <sha>\n'
  + '       autodeploy.sh --manual resolve-incident --settled <sha>\n';
const GH = 'https://github.com/ysilvestrov/warsaw-beer-bot/pull';

interface M { w: ImageWorld; x: string; img: Image; s: Image; pre: string }

/**
 * main has X (a change that runs), its image published, merged a moment ago (no quiet main has
 * passed). Production is settled at base and the timer has observed it. The run starts at 100000
 * (1970-01-02T03:46:40Z): the pre snapshot's stamp.
 */
function manualWorld(files: Record<string, string> = { 'src/a.ts': 'export const a = 2;\n' }): M {
  const w = imageWorld();
  patchState(w, { LAST_SEEN_DEPLOYED_SHA: w.base });
  const x = push(w, files, 'feat');
  const img = publish(w, imageOf(x));
  return { w, x, img, s: w.settled, pre: `19700102T034640Z-${short(x)}-pre.db` };
}

const deploy = (m: M, flags: string[] = [], over: Record<string, string> = {}) =>
  manual(m.w, ['deploy', '--target', m.x, ...flags], over);

/** The calls of a deploy up to and including `activate D`. */
const toActivate = ({ x, img, s, pre }: M) => [
  `checks ${x}`, `resolve ${x}`, `attest ${img.digest} ${x}`, `image pull --sha ${x} --digest ${img.digest}`, 'image current',
  `image audit --digest ${img.digest}`, `image local --digest ${s.digest}`, `snapshot ${pre}`,
  `image trial --digest ${img.digest} --previous ${s.digest} --snapshot ${pre}`, `image activate --digest ${img.digest}`,
];
const polls = (n: number) => Array<string>(n).fill('image current');
const settledEnd = (m: M) => [`image prune --keep ${m.img.digest}`, 'prune'];
const marked = (m: M) => join(m.w.snapshots, m.pre.replace(/-pre\.db$/, '-rollback-pre.db'));

/** The state before the run: settled at base, observed by the timer. */
const initial = (m: M) => ({ ...settledState(m.s), LAST_SEEN_DEPLOYED_SHA: m.w.base });
/** X settled by a manual run: the timer's observation stays at base (plan п.11). */
const settledX = (m: M) => ({ ...settledState(m.img), PREVIOUS_SHA: m.w.base, LAST_SEEN_DEPLOYED_SHA: m.w.base });

/** The window as `activate D` finds it. */
const windowAt = (m: M, mode: string) => ({
  ...initial(m),
  WINDOW_SHA: m.x, WINDOW_DIGEST: m.img.digest, WINDOW_ID: m.img.id, WINDOW_CONTENT: m.img.content, WINDOW_OLD: m.w.base,
  WINDOW_PREV_DIGEST: m.s.digest, WINDOW_KIND: 'deploy', WINDOW_MODE: mode, WINDOW_PHASE: 'activating',
  WINDOW_PRE: join(m.w.snapshots, m.pre), WINDOW_BOOT: BOOT_ID, ACTIVATE_ATTEMPTS: '1',
});

const contractRefusal = (m: M, items: string[]) =>
  `a code-only rollback of ${short(m.w.base)}..${short(m.x)} is not proven safe:\n`
  + items.map((i) => `• ${i}\n`).join('')
  + 'Run again with --ack-incompatible: the window is then manual — no automatic rollback; a failure is an incident.\n';

describe('(а) usage: anything outside the grammar is 64 and does nothing', () => {
  const X = 'a'.repeat(40);
  it.each([
    ['--target without --manual', ['--target', X]],
    ['--manual without a subcommand', ['--manual']],
    ['an unknown subcommand', ['--manual', 'redeploy', '--target', X]],
    ['deploy without --target', ['--manual', 'deploy']],
    ['deploy with --target and no value', ['--manual', 'deploy', '--target']],
    ['a short SHA', ['--manual', 'deploy', '--target', X.slice(0, 7)]],
    ['an upper-case SHA', ['--manual', 'deploy', '--target', 'A'.repeat(40)]],
    ['--target twice', ['--manual', 'deploy', '--target', X, '--target', X]],
    ['--force twice', ['--manual', 'deploy', '--target', X, '--force', '--force']],
    ['--ack-incompatible twice', ['--manual', 'deploy', '--target', X, '--ack-incompatible', '--ack-incompatible']],
    ['--settled in deploy', ['--manual', 'deploy', '--target', X, '--settled', X]],
    ['an unknown flag', ['--manual', 'deploy', '--target', X, '--yes']],
    ['--manual given twice', ['--manual', 'deploy', '--manual', '--target', X]],
    ['--target=<sha> (one word)', ['--manual', 'deploy', `--target=${X}`]],
    ['a bare --', ['--manual', 'deploy', '--target', X, '--']],
    ['bootstrap without --target', ['--manual', 'bootstrap']],
    ['--force in bootstrap', ['--manual', 'bootstrap', '--target', X, '--force']],
    ['--target in resolve-incident', ['--manual', 'resolve-incident', '--target', X]],
    ['resolve-incident without --settled', ['--manual', 'resolve-incident']],
  ])('%s', (_name, args) => {
    const w = imageWorld();
    const before = stateText(w);
    const r = tick(w, {}, args);
    expect([r.code, r.out, stateText(w), events(w), notes(w)]).toEqual([64, USAGE, before, [], []]);
  });
});

describe('(б) the prologue: PAUSED, the lock, an open window, an incident, STATE CORRUPT', () => {
  /** Holds the deploy lock in another process (a real flock); resolves once it is held. */
  async function holdLock(lock: string): Promise<ChildProcess> {
    const holder = spawn('flock', ['-o', lock, 'sleep', '20'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i += 1) {
      if (spawnSync('flock', ['-n', lock, 'true']).status === 1) return holder;
      await new Promise((res) => setTimeout(res, 20));
    }
    holder.kill();
    throw new Error('the lock holder never acquired the lock');
  }

  it('PAUSED refuses (1) with an explanation, where the tick exits quietly', () => {
    const m = manualWorld();
    writeFileSync(join(m.w.stateDir, 'PAUSED'), '');
    const before = stateText(m.w);
    const r = deploy(m);
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1, `wbb-autodeploy: paused (${m.w.stateDir}/PAUSED exists) — a manual run is refused; remove the file to deploy\n`, before, [], [],
    ]);
  });

  it('a held lock refuses at once (1), without waiting and without starting the stall count', async () => {
    const m = manualWorld();
    const lock = join(m.w.stateDir, 'lock');
    const before = stateText(m.w);
    const holder = await holdLock(lock);
    try {
      const r = deploy(m);
      expect([r.code, r.out]).toEqual([
        1, `the deploy lock is held (a tick or another deploy.sh) — nothing was done; run again when it is free (fuser -v ${lock})\n`,
      ]);
      expect([existsSync(join(m.w.stateDir, 'lock-busy-since')), stateText(m.w), events(m.w), notes(m.w)]).toEqual([false, before, [], []]);
    } finally {
      holder.kill();
    }
  });

  it('an open window refuses (1) and stays as it is: the timer finishes it', () => {
    const m = manualWorld();
    seedState(m.w, { ...windowAt(m, 'auto') });
    const before = stateText(m.w);
    const r = deploy(m);
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1, `a window of ${short(m.x)} is open (activating) — the timer finishes it; run again after it\n`, before, [], [],
    ]);
  });

  it('an open incident refuses (1), naming --resolve-incident', () => {
    const m = manualWorld();
    patchState(m.w, { INCIDENT: `${m.w.base} ${m.s.digest} the rollback did not bring it up` });
    const before = stateText(m.w);
    const r = deploy(m);
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1,
      `an INCIDENT is open — ${short(m.w.base)} (${m.s.digest}): the rollback did not bring it up\n`
      + 'Nothing deploys until it is resolved: bash deploy/deploy.sh --resolve-incident --settled <sha>\n',
      before, [], [],
    ]);
  });

  it('STATE CORRUPT is 3, nothing runs, and the notice carries the manual mark', () => {
    const m = manualWorld();
    writeStateText(m.w, '# by hand\n');
    const r = deploy(m);
    expect([r.code, stateText(m.w), events(m.w)]).toEqual([3, '# by hand\n', []]);
    expect(notes(m.w)).toEqual([
      `[manual] 🔥 merge-deploy: STATE CORRUPT — ${m.w.statePath}: line 1 is not KEY=value. Nothing runs until a human repairs the file; it is never taken for a first start.`,
    ]);
  });
});

describe('(в) the target must be on main', () => {
  it('a commit of a side branch refuses (1) before any helper call', () => {
    const w = imageWorld();
    git(w.seed, 'checkout', '-q', '-b', 'side');
    const side = commitTo(w, { 'src/side.ts': 's\n' }, 'side', 'side');
    publish(w, imageOf(side));
    const before = stateText(w);
    const r = manual(w, ['deploy', '--target', side]);
    expect([r.code, r.out, stateText(w), events(w), notes(w)]).toEqual([
      1, `${short(side)} is not on origin/main — only a commit of main is deployed (its image's attestation requires refs/heads/main)\n`,
      before, [], [],
    ]);
  });

  it('a SHA the repository does not have refuses the same way', () => {
    const w = imageWorld();
    const r = manual(w, ['deploy', '--target', 'e'.repeat(40)]);
    expect([r.code, r.out, events(w)]).toEqual([
      1, 'eeeeeee is not on origin/main — only a commit of main is deployed (its image\'s attestation requires refs/heads/main)\n', [],
    ]);
  });
});

describe('(г) the happy path: a fresh merge with a held path and a deploy:hold PR deploys', () => {
  const held = () => {
    const m = manualWorld({ 'src/a.ts': 'export const a = 2;\n', 'deploy/sudoers.d/wbb-image': 'ysi ALL=(root) NOPASSWD: x\n' });
    return { m, over: { WBB_PR_LABELS_CMD: stub(m.w.bin, 'labels-held', `printf '7\\tdeploy:hold\\n'`) } };
  };

  it('runs the pipeline and the window in the foreground and settles (0)', () => {
    const { m, over } = held();
    const r = deploy(m, [], over);
    expect(r.code).toBe(0);
    expect(events(m.w)).toEqual([...toActivate(m), ...polls(61), ...settledEnd(m)]);
    expect(readState(m.w)).toEqual(settledX(m));
    expect(notes(m.w)).toEqual([`[manual] ✅ merge-deploy ${short(m.x)} is live and settled — #7.`]);
    // The human in front of the run reads what the chat reads.
    expect(r.out).toBe(`[manual] ✅ merge-deploy ${short(m.x)} is live and settled — #7.\n`);
    expect([hostRead(m.w, 'quadlet'), hostRead(m.w, 'container')]).toEqual([m.img.digest, m.img.digest]);
  });

  it('`activate D` finds a window of kind deploy, mode auto', () => {
    const { m, over } = held();
    deploy(m, [], over);
    expect(stateAtActivate(m.w, 1)).toEqual(windowAt(m, 'auto'));
  });
});

describe('(ґ) a failed auto window rolls back', () => {
  it('rolls back to S (2) and records X as failed', () => {
    const m = manualWorld();
    fault(m.w, 'health', 300, 99999, m.img.digest);
    const r = deploy(m);
    const reason = 'health check failed 3 times in a row (last at +320s)';
    expect(r.code).toBe(2);
    expect(events(m.w)).toEqual([
      ...toActivate(m), ...polls(33), `mark ${m.pre}`, 'image current', `image activate --digest ${m.s.digest}`, 'image current',
    ]);
    expect(readState(m.w)).toEqual({ ...initial(m), LAST_FAILED_SHA: m.x, RETAINED_PRE: marked(m) });
    expect(notes(m.w)).toEqual([
      `[manual] ⚠️ merge-deploy ${short(m.x)} failed inside its window: ${reason} — rolling back to ${short(m.s.sha)} (code only; the database is not touched).`,
      `[manual] 🔥 merge-deploy ROLLED BACK ${short(m.x)} → ${short(m.s.sha)} (code only, DB untouched): ${reason}.\n`
      + `Whatever ${short(m.x)} migrated or wrote is still in the database.\n`
      + `Pre-deploy snapshot: ${marked(m)} (kept until a human removes it: rm ${marked(m)} ${marked(m)}.sha256)`,
    ]);
  });
});

describe('(д) rollback:unsafe / migration:contract in the range', () => {
  const contract = (m: M) => ({
    WBB_PR_LABELS_CMD: stub(m.w.bin, 'labels-contract', `printf '12\\trollback:unsafe\\n13\\tmigration:contract,deploy:hold\\n'`),
  });

  it('without --ack-incompatible: refused (1), the PRs listed, no helper call', () => {
    const m = manualWorld();
    const before = stateText(m.w);
    const r = deploy(m, [], contract(m));
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1,
      contractRefusal(m, [`PR #12 carries rollback:unsafe — ${GH}/12`, `PR #13 carries migration:contract — ${GH}/13`]),
      before, [], [],
    ]);
  });

  it('with --ack-incompatible: deployed in a manual window, which settles', () => {
    const m = manualWorld();
    const r = deploy(m, ['--ack-incompatible'], contract(m));
    expect(r.code).toBe(0);
    expect(stateAtActivate(m.w, 1)).toEqual(windowAt(m, 'manual'));
    expect(readState(m.w)).toEqual(settledX(m));
    expect(notes(m.w)).toEqual([`[manual] ✅ merge-deploy ${short(m.x)} is live and settled — #12 #13.`]);
  });

  it('a failed manual window is an incident (3), never a rollback', () => {
    const m = manualWorld();
    fault(m.w, 'health', 300, 99999, m.img.digest);
    const r = deploy(m, ['--ack-incompatible'], contract(m));
    const reason = 'the manual window failed: health check failed 3 times in a row (last at +320s)';
    expect(r.code).toBe(3);
    expect(events(m.w)).toEqual([...toActivate(m), ...polls(33), `mark ${m.pre}`]);
    expect(readState(m.w)).toEqual({
      ...initial(m), DEPLOYED_SHA: m.x, DEPLOYED_DIGEST: m.img.digest, DEPLOYED_ID: m.img.id, DEPLOYED_CONTENT: m.img.content,
      LAST_FAILED_SHA: m.x, RETAINED_PRE: marked(m), INCIDENT: `${m.x} ${m.img.digest} ${reason}`,
    });
    expect(notes(m.w)).toEqual([
      `[manual] 🔥 merge-deploy INCIDENT: ${short(m.x)} (${m.img.digest}) — ${reason}. Nothing was rolled back automatically (a manual window); the database is untouched.\n`
      + `Pre-deploy snapshot: ${marked(m)} (kept until a human removes it: rm ${marked(m)} ${marked(m)}.sha256)\n`
      + 'Nothing deploys until a human restores production and runs: bash deploy/deploy.sh --resolve-incident --settled <sha>',
    ]);
    expect(hostRead(m.w, 'quadlet')).toBe(m.img.digest);
  });
});

describe('(е) PR labels that could not be read', () => {
  const unread = (m: M) => ({ WBB_PR_LABELS_CMD: stub(m.w.bin, 'labels-fail', 'exit 1') });

  it('without --ack-incompatible: refused (1), naming what was not read', () => {
    const m = manualWorld();
    const before = stateText(m.w);
    const r = deploy(m, [], unread(m));
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1, contractRefusal(m, [`could not read PR labels for ${short(m.x)}`]), before, [], [],
    ]);
  });

  it('with --ack-incompatible: deployed in a manual window', () => {
    const m = manualWorld();
    const r = deploy(m, ['--ack-incompatible'], unread(m));
    expect(r.code).toBe(0);
    expect(stateAtActivate(m.w, 1)).toEqual(windowAt(m, 'manual'));
    expect(readState(m.w)).toEqual(settledX(m));
    expect(notes(m.w)).toEqual([`[manual] ✅ merge-deploy ${short(m.x)} is live and settled.`]);
  });
});

describe('(є) COMPAT FAILED', () => {
  it('without --ack-incompatible: the pair is held (proven), the pre discarded, refused (1)', () => {
    const m = manualWorld();
    reply(m.w, 'trial', m.img.digest, golden('trial-compat-failed'));
    const r = deploy(m);
    const why = 'COMPAT FAILED: START FAILED: bot exited (code 1) before "api listening"';
    expect(r.code).toBe(1);
    expect(events(m.w)).toEqual([...toActivate(m).slice(0, -1), `discard ${m.pre}`]);
    expect(readState(m.w)).toEqual({
      ...initial(m), CANDIDATE_HELD: `${m.x} ${m.img.digest} ${m.s.digest}`, CANDIDATE_HELD_WHY: why, LAST_HOLD_NOTICE: DAY1,
    });
    expect(notes(m.w)).toEqual([
      `[manual] ⏸ merge-deploy: ${short(m.x)} is HELD — the settled ${short(m.s.sha)} does not start on the database ${short(m.x)} migrated, `
      + `so a code-only rollback is not possible: ${why}\n`
      + '[compat exited 1]\nSTART FAILED: bot exited (code 1) before "api listening"\noutput tail:\nSqliteError: no such column: venue\n'
      + 'Deploy it by hand, without an automatic rollback: bash deploy/deploy.sh --ack-incompatible',
    ]);
    expect(readdirSync(m.w.snapshots)).toEqual([]);
  });

  it('with --ack-incompatible: deployed in a manual window, nothing held', () => {
    const m = manualWorld();
    reply(m.w, 'trial', m.img.digest, golden('trial-compat-failed'));
    const r = deploy(m, ['--ack-incompatible']);
    expect(r.code).toBe(0);
    expect(events(m.w)).toEqual([...toActivate(m), ...polls(61), ...settledEnd(m)]);
    expect(stateAtActivate(m.w, 1)).toEqual(windowAt(m, 'manual'));
    expect(readState(m.w)).toEqual(settledX(m));
  });
});

describe('(ж) trial REFUSED', () => {
  it('refuses (1) and records no retry: the human runs again', () => {
    const m = manualWorld();
    reply(m.w, 'trial', m.img.digest, golden('trial-refused'));
    const r = deploy(m);
    const S5 = `sha256:${'5'.repeat(64)}`;
    expect([r.code, r.out]).toEqual([
      1,
      `the trial of ${short(m.x)} was refused: previous image ${S5} predates start-check --leave-running\n`
      + `REFUSED: previous image ${S5} predates start-check --leave-running\n[compat exited 64]\n`
      + 'usage: start-check.cjs [--timeout <seconds>] [--entry <file>]\n'
      + 'Nothing is recorded against the commit; fix the host and run again.\n',
    ]);
    expect(events(m.w)).toEqual([...toActivate(m).slice(0, -1), `discard ${m.pre}`]);
    expect([readState(m.w), notes(m.w)]).toEqual([initial(m), []]);
  });
});

describe('(з) noop: equal wbb.content', () => {
  it('records X as deployed without a restart (0) — the hold on a host step is released', () => {
    const m = manualWorld({ 'docs/x.md': 'a\n', 'deploy/sudoers.d/wbb-image': 'ysi ALL=(root) NOPASSWD: x\n' });
    m.img = publish(m.w, imageOf(m.x, m.s.content));
    const r = deploy(m);
    expect(r.code).toBe(0);
    expect(events(m.w)).toEqual([...toActivate(m).slice(0, 5), `image prune --keep ${m.s.digest}`]);
    expect(readState(m.w)).toEqual({ ...initial(m), DEPLOYED_SHA: m.x });
    expect(notes(m.w)).toEqual([]);
    // The timer: production is main — no hold.
    expect(tick(m.w).code).toBe(0);
    expect([events(m.w).length, notes(m.w)]).toEqual([6, []]);
    expect(readState(m.w)).toEqual({ ...initial(m), DEPLOYED_SHA: m.x, LAST_SEEN_DEPLOYED_SHA: m.x });
  });
});

describe('(и) production is not an ancestor of X', () => {
  /** main is base → a → b; production is settled at b and the timer saw it. */
  function downgrade(): { w: ImageWorld; a: string; imgA: Image; b: string; imgB: Image } {
    const w = imageWorld();
    const a = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'a');
    const imgA = publish(w, imageOf(a));
    const b = push(w, { 'src/a.ts': 'export const a = 3;\n' }, 'b');
    const imgB = publish(w, imageOf(b));
    runImage(w, imgB);
    seedState(w, { ...settledState(imgB), LAST_SEEN_DEPLOYED_SHA: b });
    return { w, a, imgA, b, imgB };
  }

  it('without --force: refused (1), no helper call', () => {
    const { w, a, b } = downgrade();
    const before = stateText(w);
    const r = manual(w, ['deploy', '--target', a]);
    expect([r.code, r.out, stateText(w), events(w), notes(w)]).toEqual([
      1, `production (${short(b)}) is not an ancestor of ${short(a)} — a downgrade or a jump across histories; if it is deliberate, run again with --force\n`,
      before, [], [],
    ]);
  });

  it('with --force: deployed; the next tick sees production went BACKWARDS and holds', () => {
    const { w, a, imgA, b, imgB } = downgrade();
    const r = manual(w, ['deploy', '--target', a, '--force']);
    expect(r.code).toBe(0);
    expect(readState(w)).toEqual({ ...settledState(imgA), PREVIOUS_SHA: b, LAST_SEEN_DEPLOYED_SHA: b });
    const pre = `19700102T034640Z-${short(a)}-pre.db`;
    const all = [
      `checks ${a}`, `resolve ${a}`, `attest ${imgA.digest} ${a}`, `image pull --sha ${a} --digest ${imgA.digest}`, 'image current',
      `image audit --digest ${imgA.digest}`, `image local --digest ${imgB.digest}`, `snapshot ${pre}`,
      `image trial --digest ${imgA.digest} --previous ${imgB.digest} --snapshot ${pre}`, `image activate --digest ${imgA.digest}`,
      ...polls(61), `image prune --keep ${imgA.digest}`, 'prune',
    ];
    expect(events(w)).toEqual(all);
    expect(tick(w).code).toBe(0);
    expect(events(w)).toEqual(all);
    expect(readState(w)).toEqual({
      ...settledState(imgA), PREVIOUS_SHA: b, LAST_SEEN_DEPLOYED_SHA: a, REGRESSION_FROM_SHA: b, REGRESSION_TO_SHA: a, LAST_HOLD_NOTICE: DAY1,
    });
    expect(notes(w)).toEqual([
      `[manual] ✅ merge-deploy ${short(a)} is live and settled.`,
      `⚠️ merge-deploy: production went BACKWARDS: ${short(b)} → ${short(a)} (1 commits, 1 PRs no longer reachable) — was this a deliberate rollback? `
      + 'Unattended deploys are HELD. Deploy main by hand to recover.',
      `⏸ merge-deploy: production is HELD: observed production regression ${short(b)} → ${short(a)}; currently ${short(a)}. `
      + 'A deliberate rollback must not be overwritten automatically.\n'
      + `Deploy main by hand (bash deploy/deploy.sh; --force if histories diverge) if it contains ${short(b)}. `
      + 'If main omits that commit, verify intended production and follow deploy/README.md → Operator acknowledgement of a replacement baseline.',
    ]);
  });
});

describe('(і) X is what is deployed', () => {
  it('is up to date (0), and does nothing', () => {
    const w = imageWorld();
    const before = stateText(w);
    const r = manual(w, ['deploy', '--target', w.base]);
    expect([r.code, r.out, stateText(w), events(w), notes(w)]).toEqual([0, `up to date at ${w.base}\n`, before, [], []]);
  });
});

describe('(ї) X is LAST_FAILED_SHA', () => {
  it('is deployed (the human asks explicitly), and its settled window clears the record', () => {
    const m = manualWorld();
    patchState(m.w, { LAST_FAILED_SHA: m.x });
    const r = deploy(m);
    expect(r.code).toBe(0);
    expect(events(m.w)).toEqual([...toActivate(m), ...polls(61), ...settledEnd(m)]);
    expect(readState(m.w)).toEqual(settledX(m));
  });
});

describe('(й) CI and the installed copies', () => {
  it('`image` absent (WAIT for the tick) refuses (1) with the reason', () => {
    const m = manualWorld();
    const before = stateText(m.w);
    const r = deploy(m, [], { WBB_CHECKS_CMD: checksStub(m.w, 'checks-ci-only', ['ci\tcompleted\tsuccess\t101']) });
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1, `CI has not concluded on ${short(m.x)} — the required 'ci' and 'image' checks of one run are pending or absent; there is no image to deploy yet\n`,
      before, [`checks ${m.x}`], [],
    ]);
  });

  it('a failed check refuses (1), naming it', () => {
    const m = manualWorld();
    const r = deploy(m, [], { WBB_CHECKS_CMD: checksStub(m.w, 'checks-fail', ['ci\tcompleted\tfailure\t101', 'image\tcompleted\tsuccess\t101']) });
    expect([r.code, r.out, events(m.w), notes(m.w)]).toEqual([1, `CI failed on ${short(m.x)} — not deploying: ci=failure\n`, [`checks ${m.x}`], []]);
  });

  it('stale installed copies refuse (1), before CI', () => {
    const m = manualWorld();
    const before = stateText(m.w);
    const stale = stub(m.w.bin, 'installed-stale', 'echo "STALE: 1 installed file(s) differ from origin/main:"; exit 1');
    const r = deploy(m, [], { WBB_INSTALLED_CHECK: stale });
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1,
      'the installed deployer is out of date — a merged fix is not live until it is installed.\n'
      + 'STALE: 1 installed file(s) differ from origin/main:\n'
      + 'Run: sudo bash deploy/install-autodeploy.sh (the deployer) and sudo bash deploy/install-image.sh (the image helper)\n',
      before, [], [],
    ]);
  });
});

describe('(к) an interrupted manual run is finished by the tick', () => {
  it('killed mid-window, the next tick settles it from the state (kind deploy, mode manual)', () => {
    const m = manualWorld();
    fault(m.w, 'kill', 300, 301, m.img.digest);
    const r = deploy(m, ['--ack-incompatible']);
    expect(r.code).toBe(null);
    expect(events(m.w)).toEqual([...toActivate(m), ...polls(30)]);
    const mid = readState(m.w);
    expect([mid.WINDOW_KIND, mid.WINDOW_MODE, mid.WINDOW_PHASE, mid.WINDOW_LAST_READ]).toEqual(['deploy', 'manual', 'watching', '100290']);
    expect(tick(m.w).code).toBe(0);
    expect(events(m.w).slice(toActivate(m).length + 30)).toEqual(['image current', ...polls(31), ...settledEnd(m)]);
    expect(readState(m.w)).toEqual({ ...settledX(m), LAST_SEEN_DEPLOYED_SHA: m.x });
    expect(notes(m.w)).toEqual([`✅ merge-deploy ${short(m.x)} is live and settled.`]);
  });

  it('a manual run of LAST_FAILED_SHA killed mid-window: the tick settles it and clears the record', () => {
    const m = manualWorld();
    patchState(m.w, { LAST_FAILED_SHA: m.x });
    fault(m.w, 'kill', 300, 301, m.img.digest);
    expect(deploy(m).code).toBe(null);
    expect(readState(m.w).LAST_FAILED_SHA).toBe(m.x);
    expect(tick(m.w).code).toBe(0);
    expect(readState(m.w)).toEqual({ ...settledX(m), LAST_SEEN_DEPLOYED_SHA: m.x });
  });
});

describe('(л) the tick is unchanged', () => {
  it('MANUAL in the environment does not make a tick manual: its texts carry no mark', () => {
    const m = manualWorld();
    tick(m.w, { MANUAL: '1' });
    advance(m.w, 600);
    const r = tick(m.w, { MANUAL: '1' });
    expect(r.code).toBe(0);
    expect(notes(m.w)).toEqual([`✅ merge-deploy ${short(m.x)} is live and settled — #7.`]);
  });
});

/** main is base → c1 → … → cn (each a change that runs, its image published); production is settled at cn and the timer saw it. */
function onTip(n: number): { w: ImageWorld; c: string[]; img: Image[] } {
  const w = imageWorld();
  const c: string[] = [];
  const img: Image[] = [];
  for (let i = 1; i <= n; i += 1) {
    c.push(push(w, { 'src/a.ts': `export const a = ${i + 1};\n` }, `c${i}`));
    img.push(publish(w, imageOf(c[i - 1])));
  }
  runImage(w, img[n - 1]);
  seedState(w, { ...settledState(img[n - 1]), LAST_SEEN_DEPLOYED_SHA: c[n - 1] });
  return { w, c, img };
}
const backwards = (from: string, to: string, commits: number) =>
  `⚠️ merge-deploy: production went BACKWARDS: ${short(from)} → ${short(to)} (${commits} commits, 1 PRs no longer reachable) — was this a deliberate rollback? `
  + 'Unattended deploys are HELD. Deploy main by hand to recover.';

describe('(м1) plan b2 п.18: a forced downgrade the tick finished is still fenced', () => {
  it('killed mid-window: the tick settles A without observing it; the next tick sees B → A went BACKWARDS', () => {
    const { w, c: [a, b], img: [imgA] } = onTip(2);
    fault(w, 'kill', 300, 301, imgA.digest);
    expect(manual(w, ['deploy', '--target', a, '--force']).code).toBe(null);
    expect(tick(w).code).toBe(0);
    expect(readState(w)).toEqual({ ...settledState(imgA), PREVIOUS_SHA: b, LAST_SEEN_DEPLOYED_SHA: b });
    expect(tick(w).code).toBe(0);
    expect([readState(w).REGRESSION_FROM_SHA, readState(w).REGRESSION_TO_SHA, readState(w).LAST_SEEN_DEPLOYED_SHA]).toEqual([b, a, a]);
    expect(notes(w).slice(0, 2)).toEqual([`✅ merge-deploy ${short(a)} is live and settled.`, backwards(b, a, 1)]);
  });

  it('killed right after `activate A` (row 3 of §7.2): the same — the activation observes nothing', () => {
    const { w, c: [a, b], img: [imgA] } = onTip(2);
    reply(w, 'activate', imgA.digest, 'kill-after');
    expect(manual(w, ['deploy', '--target', a, '--force']).code).toBe(null);
    expect([readState(w).WINDOW_PHASE, hostRead(w, 'container')]).toEqual(['activating', imgA.digest]);
    expect(tick(w).code).toBe(0);
    expect(readState(w)).toEqual({ ...settledState(imgA), PREVIOUS_SHA: b, LAST_SEEN_DEPLOYED_SHA: b });
    expect(tick(w).code).toBe(0);
    expect(notes(w).slice(0, 2)).toEqual([`✅ merge-deploy ${short(a)} is live and settled.`, backwards(b, a, 1)]);
  });
});

describe('(м2) plan b2 п.18: a manual deploy between a forced downgrade and the observed head', () => {
  it('P observed, a forced A settled, B (A < B < P) killed and settled by the tick: the next tick fences P → B', () => {
    const { w, c: [a, b, p], img: [, imgB] } = onTip(3);
    expect(manual(w, ['deploy', '--target', a, '--force']).code).toBe(0);
    fault(w, 'kill', 300, 301, imgB.digest);
    expect(manual(w, ['deploy', '--target', b]).code).toBe(null);
    expect(tick(w).code).toBe(0);
    expect([readState(w).SETTLED_SHA, readState(w).LAST_SEEN_DEPLOYED_SHA]).toEqual([b, p]);
    expect(tick(w).code).toBe(0);
    expect([readState(w).REGRESSION_FROM_SHA, readState(w).REGRESSION_TO_SHA]).toEqual([p, b]);
    expect(notes(w).slice(1, 3)).toEqual([`✅ merge-deploy ${short(b)} is live and settled.`, backwards(p, b, 1)]);
  });

  it('B fails in the window the tick finishes: rolled back to A, and the next tick fences P → A', () => {
    const { w, c: [a, b, p], img: [imgA, imgB] } = onTip(3);
    expect(manual(w, ['deploy', '--target', a, '--force']).code).toBe(0);
    fault(w, 'kill', 300, 301, imgB.digest);
    fault(w, 'health', 301, 99999, imgB.digest);
    expect(manual(w, ['deploy', '--target', b]).code).toBe(null);
    expect(tick(w).code).toBe(2);
    expect([readState(w).DEPLOYED_SHA, readState(w).DEPLOYED_DIGEST, readState(w).LAST_SEEN_DEPLOYED_SHA]).toEqual([a, imgA.digest, p]);
    expect(tick(w).code).toBe(0);
    expect([readState(w).REGRESSION_FROM_SHA, readState(w).REGRESSION_TO_SHA]).toEqual([p, a]);
    expect(notes(w)[3]).toBe(backwards(p, a, 2));
  });
});

describe('(м3) plan b2 п.19: a manual deploy of an older commit never overwrites the head\'s records', () => {
  /** main is base → x → y; production is base; y, the head, already failed (or is held). */
  function behindHead(): { m: M; y: string; imgY: Image } {
    const m = manualWorld();
    const y = push(m.w, { 'src/a.ts': 'export const a = 3;\n' }, 'y');
    const imgY = publish(m.w, imageOf(y));
    return { m, y, imgY };
  }

  it('a failed trial of X: refused and told, LAST_FAILED_SHA stays Y, and the next tick does not deploy Y', () => {
    const { m, y } = behindHead();
    patchState(m.w, { LAST_FAILED_SHA: y });
    reply(m.w, 'trial', m.img.digest, golden('trial-trial-failed'));
    expect(deploy(m).code).toBe(1);
    expect(readState(m.w)).toEqual({ ...initial(m), LAST_FAILED_SHA: y });
    expect(notes(m.w)).toEqual([
      `[manual] ⛔ merge-deploy refused ${short(m.x)}: the trial on a copy of production failed: TRIAL FAILED: no such column: venue_id\n`
      + '[trial exited 1]\nTRIAL FAILED: no such column: venue_id',
    ]);
    const before = events(m.w);
    expect(tick(m.w).code).toBe(0);
    expect(events(m.w)).toEqual(before);
  });

  it('a failed auto window of X: rolled back (2), LAST_FAILED_SHA stays Y', () => {
    const { m, y } = behindHead();
    patchState(m.w, { LAST_FAILED_SHA: y });
    fault(m.w, 'health', 300, 99999, m.img.digest);
    expect(deploy(m).code).toBe(2);
    expect(readState(m.w)).toEqual({ ...initial(m), LAST_FAILED_SHA: y, RETAINED_PRE: marked(m) });
    const before = events(m.w);
    expect(tick(m.w).code).toBe(0);
    expect(events(m.w)).toEqual(before);
  });

  it('a failed manual window of X: an incident (3) without blaming X — LAST_FAILED_SHA stays Y', () => {
    const { m, y } = behindHead();
    patchState(m.w, { LAST_FAILED_SHA: y });
    fault(m.w, 'health', 300, 99999, m.img.digest);
    expect(deploy(m, ['--ack-incompatible']).code).toBe(3);
    expect([readState(m.w).LAST_FAILED_SHA, readState(m.w).INCIDENT])
      .toEqual([y, `${m.x} ${m.img.digest} the manual window failed: health check failed 3 times in a row (last at +320s)`]);
  });

  it('COMPAT FAILED of X: refused, Y\'s hold untouched', () => {
    const { m, y, imgY } = behindHead();
    patchState(m.w, { CANDIDATE_HELD: `${y} ${imgY.digest} ${m.s.digest}`, CANDIDATE_HELD_WHY: 'COMPAT FAILED: START TIMEOUT: no "api listening" within 90s' });
    const before = readState(m.w);
    reply(m.w, 'trial', m.img.digest, golden('trial-compat-failed'));
    const r = deploy(m);
    expect([r.code, readState(m.w), notes(m.w), r.out]).toEqual([1, before, [], [
      `${short(m.x)} is not deployable without an automatic rollback — the settled ${short(m.s.sha)} does not start on the database ${short(m.x)} migrated: `
        + 'COMPAT FAILED: START FAILED: bot exited (code 1) before "api listening"',
      '[compat exited 1]',
      'START FAILED: bot exited (code 1) before "api listening"',
      'output tail:',
      'SqliteError: no such column: venue',
      "It is not main's head, so nothing is held. Deploy it anyway, without an automatic rollback: run again with --ack-incompatible",
      '',
    ].join('\n')]);
  });
});

describe('(м4) plan b2 п.20: a forced downgrade across a contract PR', () => {
  const removedContract = (w: ImageWorld, b: string) => ({
    WBB_PR_LABELS_CMD: stub(w.bin, 'labels-removed', `if [ "$1" = "${b}" ]; then printf '13\\tmigration:contract\\n'; else printf '7\\t\\n'; fi`),
  });

  it('without --ack-incompatible: refused (1), listing the PR the downgrade removes, no helper call', () => {
    const { w, c: [a, b] } = onTip(2);
    const before = stateText(w);
    const r = manual(w, ['deploy', '--target', a, '--force'], removedContract(w, b));
    expect([r.code, r.out, stateText(w), events(w), notes(w)]).toEqual([
      1,
      `a code-only rollback of ${short(b)}..${short(a)} is not proven safe:\n`
      + `• PR #13 carries migration:contract and the downgrade removes it — ${GH}/13\n`
      + 'Run again with --ack-incompatible: the window is then manual — no automatic rollback; a failure is an incident.\n',
      before, [], [],
    ]);
  });

  it('with --ack-incompatible: deployed in a manual window, which settles', () => {
    const { w, c: [a, b], img: [imgA] } = onTip(2);
    const r = manual(w, ['deploy', '--target', a, '--force', '--ack-incompatible'], removedContract(w, b));
    expect(r.code).toBe(0);
    expect([stateAtActivate(w, 1).WINDOW_MODE, stateAtActivate(w, 1).WINDOW_KIND]).toEqual(['manual', 'deploy']);
    expect(readState(w)).toEqual({ ...settledState(imgA), PREVIOUS_SHA: b, LAST_SEEN_DEPLOYED_SHA: b });
  });
});

describe('(н) plan b2 п.21: a manual run that cannot verify is refused, and says "run again"', () => {
  it('no image published (resolve 404): 1, told on stderr only, the state byte for byte the same', () => {
    const m = manualWorld();
    hostSet(m.w, `tags/${m.x}`, null);
    const before = stateText(m.w);
    const r = deploy(m);
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1,
      `⚠️ merge-deploy: no image is published for ${short(m.x)} (no tag ${m.x} in ghcr.io/ysilvestrov/warsaw-beer-bot) — NOT a finding against the commit — run again\n`,
      before, [`checks ${m.x}`, `resolve ${m.x}`], [],
    ]);
  });

  it('an audit that could not run: 1, "run again" instead of "retrying next tick"', () => {
    const m = manualWorld();
    reply(m.w, 'audit', m.img.digest, { code: 75, stderr: 'TEMPFAIL: podman run timed out after 300s\n' });
    const before = stateText(m.w);
    const r = deploy(m);
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1,
      `⚠️ merge-deploy: the audit of ${short(m.x)} (${m.img.digest}) could not run: TEMPFAIL podman run timed out after 300s — NOT a finding — run again\n`,
      before, toActivate(m).slice(0, 6), [],
    ]);
  });

  it('an activation not confirmed (75) leaves the window to the timer and tells the chat, marked, without the daily marker', () => {
    const m = manualWorld();
    reply(m.w, 'activate', m.img.digest, { code: 75, stderr: 'TEMPFAIL: systemctl restart timed out after 180s\n' });
    const r = deploy(m);
    const note = `[manual] ⚠️ merge-deploy: the activation of ${short(m.x)} (${m.img.digest}) could not be confirmed: `
      + 'TEMPFAIL systemctl restart timed out after 180s. The next tick looks at what runs and finishes or cancels it.';
    expect([r.code, r.out, events(m.w), notes(m.w)]).toEqual([1, `${note}\n`, toActivate(m), [note]]);
    expect(readState(m.w)).toEqual(windowAt(m, 'auto'));
  });
});
