import { describe, it, expect, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOT_ID, DAY1,
  advance, checksStub, commitTo, events, fault, git, golden, holdLock, hostRead, hostSet, imageOf, imageWorld, manual, notes, patchState, publish, push,
  readState, reply, runImage, seedState, settledState, short, stateAtActivate, stateText, stub, tick, writeStateText, writes,
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
  + '       autodeploy.sh --manual resolve-incident --settled <sha>\n'
  + '       autodeploy.sh --manual resolve-incident --flat\n'
  + '       autodeploy.sh --check-state       (validate image-state.env: STATE OK, or why not; changes nothing)\n';
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
    // Plan b2 п.28: --flat is the other way out of an incident, never with --settled.
    ['--flat with --settled', ['--manual', 'resolve-incident', '--settled', X, '--flat']],
    ['--settled after --flat', ['--manual', 'resolve-incident', '--flat', '--settled', X]],
    ['--flat twice', ['--manual', 'resolve-incident', '--flat', '--flat']],
    ['--flat with a value', ['--manual', 'resolve-incident', '--flat', X]],
    ['--flat in deploy', ['--manual', 'deploy', '--target', X, '--flat']],
    ['--flat in bootstrap', ['--manual', 'bootstrap', '--target', X, '--flat']],
    // Plan 2026-10-22 v-core п.7: --check-state stands alone.
    ['--check-state with a value', ['--check-state', X]],
    ['--check-state twice', ['--check-state', '--check-state']],
    ['--check-state after --manual', ['--manual', '--check-state']],
    ['--check-state in a deploy', ['--manual', 'deploy', '--target', X, '--check-state']],
    ['--check-state before --manual', ['--check-state', '--manual', 'deploy', '--target', X]],
  ])('%s', (_name, args) => {
    const w = imageWorld();
    const before = stateText(w);
    const r = tick(w, {}, args);
    expect([r.code, r.out, stateText(w), events(w), notes(w)]).toEqual([64, USAGE, before, [], []]);
  });
});

describe('(б) the prologue: PAUSED, the lock, an open window, an incident, STATE CORRUPT', () => {
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

/**
 * Stage «в» audit: the ancestry facts of the flat deploy.sh (deploy-ancestry.test.ts) that (и) does not
 * repeat. The manual entry is now the controller's own; its ancestry gate is the same question.
 */
describe('(и2) ancestry: the rest of the flat deploy.sh\'s facts', () => {
  const MISSING = 'a'.repeat(40);

  it('a divergent production (a side branch) refuses (1) without --force, changing nothing', () => {
    const m = manualWorld();
    git(m.w.seed, 'checkout', '-q', '-b', 'side', m.w.base);
    const side = commitTo(m.w, { 'src/side.ts': 's\n' }, 'side', 'side');
    patchState(m.w, { DEPLOYED_SHA: side });
    const before = stateText(m.w);
    const r = deploy(m);
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1, `production (${short(side)}) is not an ancestor of ${short(m.x)} — a downgrade or a jump across histories; if it is deliberate, run again with --force\n`,
      before, [], [],
    ]);
  });

  it('a recorded commit the repository does not have refuses (1) without --force, changing nothing', () => {
    const m = manualWorld();
    patchState(m.w, { DEPLOYED_SHA: MISSING });
    const before = stateText(m.w);
    const r = deploy(m);
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1, `production (aaaaaaa) is not an ancestor of ${short(m.x)} — a downgrade or a jump across histories; if it is deliberate, run again with --force\n`,
      before, [], [],
    ]);
  });

  // The flat deploy.sh admitted this recovery with --force alone. --force still releases the ancestry
  // gate; the range from a commit git does not have cannot be read, so it is also unproven for a
  // code-only rollback and asks for --ack-incompatible (spec §6.4), and then deploys.
  it('with --force, a recorded commit the repository does not have passes ancestry; the unreadable range asks for --ack-incompatible', () => {
    const m = manualWorld();
    patchState(m.w, { DEPLOYED_SHA: MISSING });
    const before = stateText(m.w);
    const refused = deploy(m, ['--force']);
    // git's own complaints about the missing object reach stderr too; their wording is git's, not ours.
    const ours = refused.out.split('\n').filter((l) => !l.startsWith('fatal: ')).join('\n');
    expect([refused.code, ours, stateText(m.w), events(m.w)]).toEqual([
      1, contractRefusal({ ...m, w: { ...m.w, base: MISSING } }, ['could not list the changed paths', 'could not list the commits']), before, [],
    ]);
    const r = deploy(m, ['--force', '--ack-incompatible']);
    expect([r.code, readState(m.w).DEPLOYED_SHA, readState(m.w).SETTLED_SHA]).toEqual([0, m.x, m.x]);
  });

  it('an unreadable state is STATE CORRUPT (3) even with --force: nothing runs', () => {
    const m = manualWorld();
    chmodSync(m.w.statePath, 0o000);
    try {
      const r = deploy(m, ['--force']);
      expect([r.code, events(m.w), notes(m.w)]).toEqual([3, [], [
        `[manual] 🔥 merge-deploy: STATE CORRUPT — ${m.w.statePath}: the file cannot be read. Nothing runs until a human repairs the file; it is never taken for a first start.`,
      ]]);
    } finally {
      chmodSync(m.w.statePath, 0o644);
    }
    expect(readState(m.w)).toEqual(initial(m));
  });

  // The flat deploy.sh admitted a first deploy with no baseline; the image's first release is the
  // bootstrap (spec §8 п.2), and a plain deploy names it.
  it('with nothing settled, a deploy refuses (1) and names --bootstrap', () => {
    const m = manualWorld();
    seedState(m.w, { DEPLOYED_SHA: m.w.base });
    const before = stateText(m.w);
    const r = deploy(m);
    expect([r.code, r.out, stateText(m.w), events(m.w), notes(m.w)]).toEqual([
      1, 'there is no settled image yet — the first image release is bash deploy/deploy.sh --bootstrap\n', before, [], [],
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
      + 'Run: sudo bash deploy/install-image.sh (the image helper), then sudo bash deploy/install-autodeploy.sh (the deployer: it refuses while the helper is stale)\n',
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

// --- Task 3 of plan b2: `--manual resolve-incident --settled <sha>` ------------------------------------------

interface Inc { w: ImageWorld; x: string; img: Image; s: Image; pres: string[]; seed: Record<string, string> }
const INC_REASON = 'the manual window failed: health check failed 3 times in a row (last at +320s)';
const unmarkedOf = (p: string) => p.replace(/-rollback-pre\.db$/, '-pre.db');

/**
 * X failed in a manual window: an incident, two retained pre snapshots (real files). A human has put the
 * settled S (base) back: it runs from our Quadlet and answers. `activated_at` is the human's activation,
 * the clock of the faults.
 */
function incidentWorld(settled = true): Inc {
  const w = imageWorld();
  const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
  const img = publish(w, imageOf(x));
  hostSet(w, `local/${img.digest}`, '');
  mkdirSync(w.snapshots, { recursive: true });
  const pres = [`19700101T000000Z-${short(x)}-rollback-pre.db`, '19700101T010000Z-1111111-rollback-pre.db'].map((n) => join(w.snapshots, n));
  for (const p of pres) {
    writeFileSync(p, 'pre\n');
    writeFileSync(`${p}.sha256`, `${'0'.repeat(64)}\n`);
  }
  const s = w.settled;
  const seed: Record<string, string> = {
    ...(settled ? settledState(s) : {}),
    DEPLOYED_SHA: x, DEPLOYED_DIGEST: img.digest, DEPLOYED_ID: img.id, DEPLOYED_CONTENT: img.content,
    LAST_SEEN_DEPLOYED_SHA: s.sha, LAST_FAILED_SHA: x, RETAINED_PRE: pres.join(' '), INCIDENT: `${x} ${img.digest} ${INC_REASON}`,
  };
  seedState(w, seed);
  hostSet(w, 'activated_at', '100000');
  return { w, x, img, s, pres, seed };
}
const resolveRun = (r: Inc, over: Record<string, string> = {}) => manual(r.w, ['resolve-incident', '--settled', r.s.sha], over);
const resolveProbe = (r: Inc) => [`resolve ${r.s.sha}`, `attest ${r.s.digest} ${r.s.sha}`, `image local --digest ${r.s.digest}`, 'image current'];
const resolvedNote = (r: Inc, back: string[], left: string[] = []) =>
  `✅ merge-deploy: the incident is resolved — ${short(r.s.sha)} is live and settled.`
  + (back.length > 0 ? `\nBack in ordinary retention: ${back.join(' ')}` : '')
  + (left.length > 0 ? `\nStill retained — not unmarked; by hand: db-snapshot.sh unmark <path>: ${left.join(' ')}` : '');
/** S settled by the resolve: the human named the base, so it is observed too (plan b2 п.13). */
const resolvedState = (r: Inc, extra: Record<string, string> = {}) => ({
  ...settledState(r.s), PREVIOUS_SHA: r.x, LAST_SEEN_DEPLOYED_SHA: r.s.sha, LAST_FAILED_SHA: r.x, ...extra,
});

describe('(р-б) resolve-incident refuses (1) without changing anything', () => {
  const other = imageOf('9'.repeat(40));
  const found = (r: Inc, q: string, i: string, d: string, u: string) =>
    `production does not run ${short(r.s.sha)} from our Quadlet: expected quadlet=${r.s.digest} container-image=${r.s.id} `
    + `container-digest=${r.s.digest} unit=quadlet, found quadlet=${q} container-image=${i} container-digest=${d} unit=${u}\n`;
  it.each<[string, (r: Inc) => void, (r: Inc) => string, (r: Inc) => string[]]>([
    ['no image published for S', (r) => hostSet(r.w, `tags/${r.s.sha}`, null),
      (r) => `⚠️ merge-deploy: no image is published for ${short(r.s.sha)} (no tag ${r.s.sha} in ghcr.io/ysilvestrov/warsaw-beer-bot) — NOT a finding against the commit — run again\n`,
      (r) => [`resolve ${r.s.sha}`]],
    ['the attestation fails', (r) => reply(r.w, 'attest', r.s.digest, { code: 1, stdout: 'Error: no attestations found\n' }),
      (r) => `⛔ merge-deploy: the image of ${short(r.s.sha)} (${r.s.digest}) did not pass attestation (exit 1) — not deploying it; NOT recorded as a failed commit — run again\nError: no attestations found\n`,
      (r) => resolveProbe(r).slice(0, 2)],
    ['the local image has another revision', (r) => reply(r.w, 'local', r.s.digest,
      { code: 0, stdout: `LOCAL ${r.s.digest} ${r.s.id} content=${r.s.content} revision=${'e'.repeat(40)}\n` }),
      (r) => `the local image ${r.s.digest} is not a build of ${short(r.s.sha)}: local answered LOCAL ${r.s.digest} ${r.s.id} ${r.s.content} ${'e'.repeat(40)}\n`,
      (r) => resolveProbe(r).slice(0, 3)],
    ['the image is not local', (r) => hostSet(r.w, `local/${r.s.digest}`, null),
      (r) => `the local image ${r.s.digest} is not a build of ${short(r.s.sha)}: local answered NOT_LOCAL ${r.s.digest}\n`,
      (r) => resolveProbe(r).slice(0, 3)],
    ['the Quadlet file names another image', (r) => { publish(r.w, other); hostSet(r.w, 'quadlet', other.digest); },
      (r) => found(r, other.digest, r.s.id, r.s.digest, 'quadlet'), resolveProbe],
    ['another container runs', (r) => { publish(r.w, other); hostSet(r.w, 'container', other.digest); },
      (r) => found(r, r.s.digest, other.id, other.digest, 'quadlet'), resolveProbe],
    ['the unit is not our Quadlet', (r) => hostSet(r.w, 'unit', 'foreign'),
      (r) => found(r, r.s.digest, r.s.id, r.s.digest, 'foreign'), resolveProbe],
    ['/health answers another releaseSha', (r) => hostSet(r.w, 'running_sha', 'f'.repeat(40)),
      (r) => `/health answers releaseSha fffffff, not ${short(r.s.sha)} — production does not run what --settled names\n`, resolveProbe],
    ['/health does not answer', (r) => hostSet(r.w, 'unhealthy', ''),
      (r) => `/health answers releaseSha (no answer), not ${short(r.s.sha)} — production does not run what --settled names\n`, resolveProbe],
    // Plan b2 п.22: the window's NRestarts base is a precondition, read before the incident is cleared.
    ['NRestarts unreadable', (r) => fault(r.w, 'restarts', 0, 99999), () => 'could not read NRestarts — run again\n', resolveProbe],
    ['the boot id unreadable', (r) => hostSet(r.w, 'boot_id', null), () => 'could not read the boot id — run again\n', resolveProbe],
  ])('%s', (_name, setup, out, evs) => {
    const r = incidentWorld();
    setup(r);
    const before = stateText(r.w);
    const res = resolveRun(r);
    expect([res.code, res.out, stateText(r.w), events(r.w), notes(r.w)]).toEqual([1, out(r), before, evs(r), []]);
  });

  it('API_PORT cannot be read', () => {
    const r = incidentWorld();
    const before = stateText(r.w);
    const res = resolveRun(r, { WBB_API_PORT_CMD: stub(r.w.bin, 'port-fail', 'exit 1') });
    expect([res.code, res.out, stateText(r.w), events(r.w), notes(r.w)])
      .toEqual([1, 'could not resolve API_PORT — run again\n', before, resolveProbe(r), []]);
  });

  it('no DEPLOYED_SHA: refused before the leftover window of the incident is touched (plan b2 п.25)', () => {
    const r = incidentWorld(false);
    const { DEPLOYED_SHA: _d, DEPLOYED_DIGEST: _g, DEPLOYED_ID: _i, DEPLOYED_CONTENT: _c, ...rest } = r.seed;
    seedState(r.w, {
      ...rest,
      WINDOW_SHA: r.x, WINDOW_DIGEST: r.img.digest, WINDOW_ID: r.img.id, WINDOW_CONTENT: r.img.content, WINDOW_OLD: r.s.sha,
      WINDOW_KIND: 'bootstrap', WINDOW_MODE: 'manual', WINDOW_PHASE: 'activating', WINDOW_PRE: join(r.w.snapshots, `19700102T034640Z-${short(r.x)}-pre.db`),
      WINDOW_BOOT: BOOT_ID,
    });
    const before = stateText(r.w);
    const res = resolveRun(r);
    expect([res.code, res.out, stateText(r.w), events(r.w), notes(r.w)]).toEqual([
      1, 'the state records no deployed commit — there is nothing a resolve window could start from\n', before, [], [],
    ]);
  });

  it('no incident is open', () => {
    const w = imageWorld();
    const before = stateText(w);
    const res = manual(w, ['resolve-incident', '--settled', w.base]);
    expect([res.code, res.out, stateText(w), events(w), notes(w)])
      .toEqual([1, 'no INCIDENT is open — there is nothing to resolve\n', before, [], []]);
  });
});

describe('(р-в) resolve-incident: the happy path', () => {
  it('one write clears the incident and opens a watching resolve window; 600 s settle S and return both pres', () => {
    const r = incidentWorld();
    const res = resolveRun(r);
    expect(res.code).toBe(0);
    const { INCIDENT: _incident, ...rest } = r.seed;
    expect(writes(r.w)[0]).toEqual({
      ...rest,
      WINDOW_SHA: r.s.sha, WINDOW_DIGEST: r.s.digest, WINDOW_ID: r.s.id, WINDOW_CONTENT: r.s.content, WINDOW_OLD: r.x,
      WINDOW_PREV_DIGEST: r.s.digest, WINDOW_KIND: 'resolve', WINDOW_MODE: 'manual', WINDOW_PHASE: 'watching',
      WINDOW_START: '100000', WINDOW_BOOT: BOOT_ID, WINDOW_NRESTARTS: '0', WINDOW_FAILS: '0', WINDOW_LAST_READ: '100000',
    });
    expect(events(r.w)).toEqual([
      ...resolveProbe(r), ...polls(61), `image prune --keep ${r.s.digest}`,
      'unmark 19700101T000000Z-' + short(r.x) + '-rollback-pre.db', 'unmark 19700101T010000Z-1111111-rollback-pre.db', 'prune',
    ]);
    expect(readState(r.w)).toEqual(resolvedState(r));
    expect(readdirSync(r.w.snapshots).sort()).toEqual(r.pres.map(unmarkedOf).flatMap((p) => [p, `${p}.sha256`]).map((p) => p.slice(r.w.snapshots.length + 1)).sort());
    expect(notes(r.w)).toEqual([`[manual] ${resolvedNote(r, r.pres.map(unmarkedOf))}`]);
  });

  it('an incident whose second write never happened (the window still in the state): its pre is kept in the write that opens the resolve window', () => {
    const r = incidentWorld();
    const pre = join(r.w.snapshots, `19700102T034640Z-${short(r.x)}-pre.db`);
    writeFileSync(pre, 'pre\n');
    writeFileSync(`${pre}.sha256`, `${'0'.repeat(64)}\n`);
    seedState(r.w, {
      ...r.seed,
      WINDOW_SHA: r.x, WINDOW_DIGEST: r.img.digest, WINDOW_ID: r.img.id, WINDOW_CONTENT: r.img.content, WINDOW_OLD: r.s.sha,
      WINDOW_PREV_DIGEST: r.s.digest, WINDOW_KIND: 'deploy', WINDOW_MODE: 'manual', WINDOW_PHASE: 'watching', WINDOW_PRE: pre,
      WINDOW_START: '99000', WINDOW_BOOT: BOOT_ID, WINDOW_NRESTARTS: '0', WINDOW_FAILS: '3', WINDOW_LAST_READ: '99320',
    });
    const res = resolveRun(r);
    expect(res.code).toBe(0);
    const marked = pre.replace(/-pre\.db$/, '-rollback-pre.db');
    const first = writes(r.w)[0];
    expect([first.INCIDENT, first.RETAINED_PRE, first.WINDOW_KIND, first.WINDOW_PHASE, first.WINDOW_SHA, first.WINDOW_PRE])
      .toEqual([undefined, [...r.pres, marked].join(' '), 'resolve', 'watching', r.s.sha, undefined]);
    expect(events(r.w).slice(0, 5)).toEqual([...resolveProbe(r), `mark 19700102T034640Z-${short(r.x)}-pre.db`]);
    expect(readState(r.w)).toEqual(resolvedState(r));
    expect(notes(r.w)).toEqual([`[manual] ${resolvedNote(r, [...r.pres, marked].map(unmarkedOf))}`]);
  });
});

describe('#904 AI review: a refused resolve leaves a leftover incident window as it was', () => {
  it('the attestation fails: 1, the state byte for byte the same, the pre not marked', () => {
    const r = incidentWorld();
    const pre = join(r.w.snapshots, `19700102T034640Z-${short(r.x)}-pre.db`);
    writeFileSync(pre, 'pre\n');
    writeFileSync(`${pre}.sha256`, `${'0'.repeat(64)}\n`);
    seedState(r.w, {
      ...r.seed,
      WINDOW_SHA: r.x, WINDOW_DIGEST: r.img.digest, WINDOW_ID: r.img.id, WINDOW_CONTENT: r.img.content, WINDOW_OLD: r.s.sha,
      WINDOW_PREV_DIGEST: r.s.digest, WINDOW_KIND: 'deploy', WINDOW_MODE: 'manual', WINDOW_PHASE: 'watching', WINDOW_PRE: pre,
      WINDOW_START: '99000', WINDOW_BOOT: BOOT_ID, WINDOW_NRESTARTS: '0', WINDOW_FAILS: '3', WINDOW_LAST_READ: '99320',
    });
    const before = stateText(r.w);
    reply(r.w, 'attest', r.s.digest, { code: 1, stderr: 'Error: no attestations found\n' });
    expect([resolveRun(r).code, stateText(r.w), existsSync(pre), events(r.w).some((e) => e.startsWith('mark '))])
      .toEqual([1, before, true, false]);
  });
});

describe('(р-г) one unmark fails', () => {
  it('it stays retained and the notice names it; S settles all the same (0)', () => {
    const r = incidentWorld();
    rmSync(`${r.pres[1]}.sha256`);
    const res = resolveRun(r);
    expect(res.code).toBe(0);
    expect(readState(r.w)).toEqual(resolvedState(r, { RETAINED_PRE: r.pres[1] }));
    expect(notes(r.w)).toEqual([`[manual] ${resolvedNote(r, [unmarkedOf(r.pres[0])], [r.pres[1]])}`]);
  });
});

describe('(р-ґ) the resolve window fails', () => {
  it('the incident again, without blame (3): LAST_FAILED_SHA as it was, no activation, the pres still retained', () => {
    const r = incidentWorld();
    fault(r.w, 'health', 300, 99999, r.s.digest);
    const res = resolveRun(r);
    const reason = 'the resolve window failed: health check failed 3 times in a row (last at +320s)';
    expect(res.code).toBe(3);
    expect(events(r.w)).toEqual([...resolveProbe(r), ...polls(33)]);
    expect(readState(r.w)).toEqual({ ...r.seed, INCIDENT: `${r.s.sha} ${r.s.digest} ${reason}` });
    expect(readdirSync(r.w.snapshots).sort()).toEqual(r.pres.flatMap((p) => [p, `${p}.sha256`]).map((p) => p.slice(r.w.snapshots.length + 1)).sort());
    expect(notes(r.w)).toEqual([
      `[manual] 🔥 merge-deploy INCIDENT: ${short(r.s.sha)} (${r.s.digest}) — ${reason}. Nothing was rolled back automatically (a manual window); the database is untouched.\n`
      + 'Pre-deploy snapshot: none (the window had no pre snapshot)\n'
      + 'Nothing deploys until a human restores production and runs: bash deploy/deploy.sh --resolve-incident --settled <sha>',
    ]);
  });
});

describe('(р-д) an interrupted resolve window is finished by the tick', () => {
  it('killed mid-window: no incident in the state, so the tick resumes it, settles S and unmarks', () => {
    const r = incidentWorld();
    fault(r.w, 'kill', 300, 301, r.s.digest);
    expect(resolveRun(r).code).toBe(null);
    const mid = readState(r.w);
    expect([mid.INCIDENT, mid.WINDOW_KIND, mid.WINDOW_MODE, mid.WINDOW_PHASE]).toEqual([undefined, 'resolve', 'manual', 'watching']);
    expect(tick(r.w).code).toBe(0);
    expect(events(r.w).slice(4 + 30)).toEqual([
      'image current', ...polls(31), `image prune --keep ${r.s.digest}`,
      'unmark 19700101T000000Z-' + short(r.x) + '-rollback-pre.db', 'unmark 19700101T010000Z-1111111-rollback-pre.db', 'prune',
    ]);
    expect(readState(r.w)).toEqual(resolvedState(r));
    expect(notes(r.w)).toEqual([resolvedNote(r, r.pres.map(unmarkedOf))]);
  });
});

describe('(р-е) resolve when nothing was ever settled (an incident of the first image release)', () => {
  it('WINDOW_PREV_DIGEST is empty and valid; the settle gives the first SETTLED_*', () => {
    const r = incidentWorld(false);
    const res = resolveRun(r);
    expect(res.code).toBe(0);
    expect(writes(r.w)[0].WINDOW_PREV_DIGEST).toBe(undefined);
    expect(writes(r.w)[0].WINDOW_KIND).toBe('resolve');
    expect(readState(r.w)).toEqual(resolvedState(r));
  });
});

describe('(р-ж) the resolved base is observed, whoever settles it', () => {
  it('a resolve to a commit behind the last observation, finished by the tick: LAST_SEEN is S, and no fence follows', () => {
    const r = incidentWorld();
    patchState(r.w, { LAST_SEEN_DEPLOYED_SHA: r.x });
    fault(r.w, 'kill', 300, 301, r.s.digest);
    expect(resolveRun(r).code).toBe(null);
    expect(tick(r.w).code).toBe(0);
    expect(readState(r.w)).toEqual(resolvedState(r));
    expect(tick(r.w).code).toBe(0);
    expect([readState(r.w).REGRESSION_FROM_SHA, notes(r.w)]).toEqual([undefined, [resolvedNote(r, r.pres.map(unmarkedOf))]]);
  });
});

describe('(р-з) at most five unmarks per settle', () => {
  it('six retained: five go back, the sixth stays and is named', () => {
    const r = incidentWorld();
    const more = ['2', '3', '4', '5'].map((n) => join(r.w.snapshots, `19700101T0${n}0000Z-${n.repeat(7)}-rollback-pre.db`));
    for (const p of more) {
      writeFileSync(p, 'pre\n');
      writeFileSync(`${p}.sha256`, `${'0'.repeat(64)}\n`);
    }
    const all = [...r.pres, ...more];
    patchState(r.w, { RETAINED_PRE: all.join(' ') });
    expect(resolveRun(r).code).toBe(0);
    expect(readState(r.w)).toEqual(resolvedState(r, { RETAINED_PRE: all[5] }));
    expect(notes(r.w)).toEqual([`[manual] ${resolvedNote(r, all.slice(0, 5).map(unmarkedOf), [all[5]])}`]);
  });
});

// --- Task 4 of plan b2: `--manual bootstrap --target <sha>` -----------------------------------------------

interface Boot { w: ImageWorld; x: string; img: Image; pre: string }
/** Plan b2 п.30, п.32: the first run's dry trial passed; the root steps, `disable` before the `mv`. */
const bootSteps = (x: string) => `A dry trial of ${short(x)} on a snapshot of the live database passed; the snapshot is discarded.\n`
  + 'The bot still runs from the old unit (unit=foreign). The first image release needs these root steps first:\n'
  + '  sudo systemctl stop warsaw-beer-bot\n'
  + '  sudo systemctl disable warsaw-beer-bot\n'
  + '  sudo mv /etc/systemd/system/warsaw-beer-bot.service /etc/systemd/system/warsaw-beer-bot.service.flat\n'
  + '  sudo systemctl daemon-reload\n'
  + 'Then run again: bash deploy/deploy.sh --bootstrap\n'
  + 'Nothing was changed.\n';
/** Plan b2 п.29: what every refusal of the second run (the old bot stopped) ends with. */
const WAY_BACK = 'The old bot is stopped and its unit moved aside. To bring it back:\n'
  + '  sudo mv /etc/systemd/system/warsaw-beer-bot.service.flat /etc/systemd/system/warsaw-beer-bot.service\n'
  + '  sudo systemctl daemon-reload\n'
  + '  sudo systemctl enable warsaw-beer-bot\n'
  + '  sudo systemctl start warsaw-beer-bot';

/**
 * The flat tree runs base (DEPLOYED_SHA carried over, observed); nothing is settled; no Quadlet file, no
 * container of ours. main has X with its image published. The run starts at 100000: the pre's stamp.
 */
function bootWorld(unit: string, files: Record<string, string> = { 'src/a.ts': 'export const a = 2;\n' }): Boot {
  const w = imageWorld();
  for (const f of ['quadlet', 'container', 'running_sha']) hostSet(w, f, null);
  hostSet(w, 'unit', unit);
  seedState(w, { DEPLOYED_SHA: w.base, LAST_SEEN_DEPLOYED_SHA: w.base });
  const x = push(w, files, 'feat');
  const img = publish(w, imageOf(x));
  return { w, x, img, pre: `19700102T034640Z-${short(x)}-pre.db` };
}
const bootstrapRun = (b: Boot, over: Record<string, string> = {}) => manual(b.w, ['bootstrap', '--target', b.x], over);
/** What production runs is read first: it says which run this is (plan b2 п.29). Then the gates. */
const bootProbe = ({ x, img }: Boot) => [
  'image current', `checks ${x}`, `resolve ${x}`, `attest ${img.digest} ${x}`, `image pull --sha ${x} --digest ${img.digest}`,
  `image audit --digest ${img.digest}`,
];
const bootTrial = (b: Boot) => [`snapshot ${b.pre}`, `image trial --digest ${b.img.digest} --previous ${b.img.digest} --snapshot ${b.pre}`];
/** The first run (unit=foreign): the gates, then the dry trial on a snapshot that is discarded (plan b2 п.30). */
const bootDry = (b: Boot) => [...bootProbe(b), ...bootTrial(b), `discard ${b.pre}`];
const bootToActivate = (b: Boot) => [...bootProbe(b), ...bootTrial(b), `image activate --digest ${b.img.digest}`];
const bootWindow = (b: Boot) => ({
  DEPLOYED_SHA: b.w.base, LAST_SEEN_DEPLOYED_SHA: b.w.base,
  WINDOW_SHA: b.x, WINDOW_DIGEST: b.img.digest, WINDOW_ID: b.img.id, WINDOW_CONTENT: b.img.content, WINDOW_OLD: b.w.base,
  WINDOW_KIND: 'bootstrap', WINDOW_MODE: 'manual', WINDOW_PHASE: 'activating', WINDOW_PRE: join(b.w.snapshots, b.pre),
  WINDOW_BOOT: BOOT_ID, ACTIVATE_ATTEMPTS: '1',
});
const bootSettledNote = (x: string) => `✅ merge-deploy: the first image release ${short(x)} is live and settled — from now on the timer deploys main against it.`;

describe('(б-а) bootstrap, first run: the old unit is still there', () => {
  it('first run: a dry trial on a discarded snapshot, the steps printed, nothing recorded', () => {
    const b = bootWorld('foreign');
    const before = stateText(b.w);
    const r = bootstrapRun(b);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w)]).toEqual([1, bootSteps(b.x), before, bootDry(b), []]);
    expect(readdirSync(b.w.snapshots)).toEqual([]);
  });

  it('a repeated first run (the steps not done yet): the same output, the state still unchanged', () => {
    const b = bootWorld('foreign');
    const before = stateText(b.w);
    const first = bootstrapRun(b);
    const second = bootstrapRun(b);
    expect([second.code, second.out, first.out, stateText(b.w), events(b.w), notes(b.w)])
      .toEqual([1, bootSteps(b.x), bootSteps(b.x), before, [...bootDry(b), ...bootDry(b)], []]);
  });
});

describe('(б-а2) plan b2 п.30: the dry trial of the first run fails', () => {
  const failedNote = (b: Boot) => `[manual] ⛔ merge-deploy refused ${short(b.x)}: the trial on a copy of production failed: TRIAL FAILED: no such column: venue_id\n`
    + '[trial exited 1]\nTRIAL FAILED: no such column: venue_id';

  it('FAILED: refused (1), no root steps, the snapshot discarded, X (main\'s head) recorded as failed', () => {
    const b = bootWorld('foreign');
    reply(b.w, 'trial', b.img.digest, golden('trial-trial-failed'));
    const r = bootstrapRun(b);
    expect([r.code, r.out, events(b.w), notes(b.w), readdirSync(b.w.snapshots)])
      .toEqual([1, `${failedNote(b)}\n`, bootDry(b), [failedNote(b)], []]);
    expect(readState(b.w)).toEqual({ DEPLOYED_SHA: b.w.base, LAST_SEEN_DEPLOYED_SHA: b.w.base, LAST_FAILED_SHA: b.x });
  });

  it('FAILED of a commit behind main\'s head: refused the same, nothing recorded (plan b2 п.19)', () => {
    const b = bootWorld('foreign');
    push(b.w, { 'src/a.ts': 'export const a = 3;\n' }, 'next');
    reply(b.w, 'trial', b.img.digest, golden('trial-trial-failed'));
    const before = stateText(b.w);
    const r = bootstrapRun(b);
    expect([r.code, r.out, stateText(b.w), notes(b.w)]).toEqual([1, `${failedNote(b)}\n`, before, [failedNote(b)]]);
  });

  it('COMPAT FAILED against itself: refused (1) naming the defect, nothing recorded, no steps', () => {
    const b = bootWorld('foreign');
    reply(b.w, 'trial', b.img.digest, golden('trial-compat-failed'));
    const before = stateText(b.w);
    const r = bootstrapRun(b);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w)]).toEqual([
      1,
      `the trial of ${short(b.x)} against itself failed: COMPAT FAILED: START FAILED: bot exited (code 1) before "api listening" `
      + `— a defect of ${short(b.x)}: it would not start again on the database it migrated\n`
      + '[compat exited 1]\nSTART FAILED: bot exited (code 1) before "api listening"\noutput tail:\nSqliteError: no such column: venue\n'
      + 'Nothing is recorded against the commit.\n',
      before, bootDry(b), [],
    ]);
  });
});

describe('(б-б) bootstrap, the run after the root steps', () => {
  it('snapshots, trials D against itself, opens a bootstrap/manual window without a rollback target, settles D (0)', () => {
    const b = bootWorld('foreign');
    bootstrapRun(b);
    hostSet(b.w, 'unit', 'absent');
    const r = bootstrapRun(b);
    expect(r.code).toBe(0);
    expect(events(b.w)).toEqual([...bootDry(b), ...bootToActivate(b), ...polls(61), `image prune --keep ${b.img.digest}`, 'prune']);
    expect(stateAtActivate(b.w, 1)).toEqual(bootWindow(b));
    expect(readState(b.w)).toEqual({ ...settledState(b.img), PREVIOUS_SHA: b.w.base, LAST_SEEN_DEPLOYED_SHA: b.w.base });
    expect(notes(b.w)).toEqual([`[manual] ${bootSettledNote(b.x)}`]);
    expect([hostRead(b.w, 'quadlet'), hostRead(b.w, 'container'), hostRead(b.w, 'unit')]).toEqual([b.img.digest, b.img.digest, 'quadlet']);
  });

  it('X == DEPLOYED_SHA is allowed: the first image of the code that already runs', () => {
    const b = bootWorld('absent');
    const s = b.w.settled;
    const pre = `19700102T034640Z-${short(s.sha)}-pre.db`;
    const r = manual(b.w, ['bootstrap', '--target', s.sha]);
    expect(r.code).toBe(0);
    expect(events(b.w)).toEqual([
      'image current', `checks ${s.sha}`, `resolve ${s.sha}`, `attest ${s.digest} ${s.sha}`, `image pull --sha ${s.sha} --digest ${s.digest}`,
      `image audit --digest ${s.digest}`, `snapshot ${pre}`, `image trial --digest ${s.digest} --previous ${s.digest} --snapshot ${pre}`,
      `image activate --digest ${s.digest}`, ...polls(61), `image prune --keep ${s.digest}`, 'prune',
    ]);
    expect(readState(b.w)).toEqual({ ...settledState(s), PREVIOUS_SHA: b.w.base, LAST_SEEN_DEPLOYED_SHA: b.w.base });
  });
});

describe('(б-и) plan b2 п.26: the second run requires the old bot to be stopped', () => {
  it.each([
    ['the unit absent but active (systemd keeps a running unit whose file was moved)', 'ActiveState=active\nSubState=running\nMainPID=4242',
      'the old bot still runs (unit=absent but active) — sudo systemctl stop warsaw-beer-bot, then run again\n'],
    ['the unit state unreadable', 'ActiveState=active',
      'could not read whether the old bot runs (systemctl show warsaw-beer-bot) — run again\n'],
  ])('%s: refused (1), the state byte for byte the same, no snapshot', (_name, unitState, out) => {
    const b = bootWorld('absent');
    hostSet(b.w, 'unit_state', unitState);
    const before = stateText(b.w);
    const r = bootstrapRun(b);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w), existsSync(b.w.snapshots)]).toEqual([1, out, before, ['image current'], [], false]);
  });
});

describe('(б-к) plan b2 п.29: every refusal of the second run says how to bring the old bot back', () => {
  const S5 = `sha256:${'5'.repeat(64)}`;
  it.each<[string, (b: Boot) => Record<string, string>, (b: Boot) => string, (b: Boot) => string[]]>([
    ['stale installed copies', (b) => ({ WBB_INSTALLED_CHECK: stub(b.w.bin, 'installed-stale', 'echo "STALE: 1 installed file(s) differ from origin/main:"; exit 1') }),
      () => 'the installed deployer is out of date — a merged fix is not live until it is installed.\n'
        + 'STALE: 1 installed file(s) differ from origin/main:\n'
        + 'Run: sudo bash deploy/install-image.sh (the image helper), then sudo bash deploy/install-autodeploy.sh (the deployer: it refuses while the helper is stale)',
      () => ['image current']],
    ['CI failed', (b) => ({ WBB_CHECKS_CMD: checksStub(b.w, 'checks-fail', ['ci\tcompleted\tfailure\t101', 'image\tcompleted\tsuccess\t101']) }),
      (b) => `CI failed on ${short(b.x)} — not deploying: ci=failure`, (b) => bootProbe(b).slice(0, 2)],
    ['the attestation fails', (b) => { reply(b.w, 'attest', b.img.digest, { code: 1, stdout: 'Error: no attestations found\n' }); return {}; },
      (b) => `⛔ merge-deploy: the image of ${short(b.x)} (${b.img.digest}) did not pass attestation (exit 1) — not deploying it; NOT recorded as a failed commit — run again\n`
        + 'Error: no attestations found',
      (b) => bootProbe(b).slice(0, 4)],
    ['the pre snapshot fails', (b) => ({ WBB_SNAPSHOT_CMD: stub(b.w.bin, 'snapshot-fail', 'echo "VACUUM INTO: disk I/O error" >&2; exit 1') }),
      (b) => `⛔ merge-deploy: the pre-deploy DB snapshot failed — not deploying ${short(b.x)}.\nVACUUM INTO: disk I/O error — run again`,
      (b) => [...bootProbe(b), `discard ${b.pre}`]],
    ['trial COMPAT FAILED against itself', (b) => { reply(b.w, 'trial', b.img.digest, golden('trial-compat-failed')); return {}; },
      (b) => `the trial of ${short(b.x)} against itself failed: COMPAT FAILED: START FAILED: bot exited (code 1) before "api listening" `
        + `— a defect of ${short(b.x)}: it would not start again on the database it migrated\n`
        + '[compat exited 1]\nSTART FAILED: bot exited (code 1) before "api listening"\noutput tail:\nSqliteError: no such column: venue\n'
        + 'Nothing is recorded against the commit.',
      (b) => [...bootProbe(b), ...bootTrial(b), `discard ${b.pre}`]],
    ['trial REFUSED', (b) => { reply(b.w, 'trial', b.img.digest, golden('trial-refused')); return {}; },
      (b) => `the trial of ${short(b.x)} was refused: previous image ${S5} predates start-check --leave-running\n`
        + `REFUSED: previous image ${S5} predates start-check --leave-running\n[compat exited 64]\n`
        + 'usage: start-check.cjs [--timeout <seconds>] [--entry <file>]\n'
        + 'Nothing is recorded against the commit; fix the host and run again.',
      (b) => [...bootProbe(b), ...bootTrial(b), `discard ${b.pre}`]],
    ['a trial that could not judge (TEMPFAIL)', (b) => { reply(b.w, 'trial', b.img.digest, golden('trial-tempfail')); return {}; },
      (b) => `⚠️ merge-deploy: the trial of ${short(b.x)} could not judge it: TEMPFAIL start-check in sha256:${'d'.repeat(64)} exited 75: `
        + 'START KILLED: bot killed by SIGKILL (out of memory?) — NOT a finding — run again',
      (b) => [...bootProbe(b), ...bootTrial(b), `discard ${b.pre}`]],
  ])('%s: refused (1), the way back, the state as it was, no pre left', (_name, setup, text, evs) => {
    const b = bootWorld('absent');
    mkdirSync(b.w.snapshots, { recursive: true });
    const over = setup(b);
    const before = stateText(b.w);
    const r = bootstrapRun(b, over);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w)]).toEqual([1, `${text(b)}\n${WAY_BACK}\n`, before, evs(b), []]);
    expect(readdirSync(b.w.snapshots)).toEqual([]);
  });

  it('trial FAILED: refused and told with the way back; X (main\'s head) recorded as failed; the pre discarded', () => {
    const b = bootWorld('absent');
    reply(b.w, 'trial', b.img.digest, golden('trial-trial-failed'));
    const r = bootstrapRun(b);
    const note = `[manual] ⛔ merge-deploy refused ${short(b.x)}: the trial on a copy of production failed: TRIAL FAILED: no such column: venue_id\n`
      + `[trial exited 1]\nTRIAL FAILED: no such column: venue_id\n${WAY_BACK}`;
    expect([r.code, r.out, events(b.w), notes(b.w), readdirSync(b.w.snapshots)])
      .toEqual([1, `${note}\n`, [...bootProbe(b), ...bootTrial(b), `discard ${b.pre}`], [note], []]);
    expect(readState(b.w)).toEqual({ DEPLOYED_SHA: b.w.base, LAST_SEEN_DEPLOYED_SHA: b.w.base, LAST_FAILED_SHA: b.x });
  });

  it('an audit ADVISORY: refused and told with the way back; X recorded as failed; no snapshot taken', () => {
    const b = bootWorld('absent');
    reply(b.w, 'audit', b.img.digest, { code: 1, stdout: `AUDIT ADVISORY ${b.img.digest}\nproxy-addr critical — IP spoofing\n` });
    const r = bootstrapRun(b);
    const note = `[manual] ⛔ merge-deploy refused ${short(b.x)}: npm audit --omit=dev in its image reports a high or critical advisory.\n`
      + `proxy-addr critical — IP spoofing\n${WAY_BACK}`;
    expect([r.code, r.out, events(b.w), notes(b.w), existsSync(b.w.snapshots)]).toEqual([1, `${note}\n`, bootProbe(b), [note], false]);
    expect(readState(b.w)).toEqual({ DEPLOYED_SHA: b.w.base, LAST_SEEN_DEPLOYED_SHA: b.w.base, LAST_FAILED_SHA: b.x });
  });

  it('an audit ADVISORY in the first run (the bot runs): refused without the way back', () => {
    const b = bootWorld('foreign');
    reply(b.w, 'audit', b.img.digest, { code: 1, stdout: `AUDIT ADVISORY ${b.img.digest}\nproxy-addr critical — IP spoofing\n` });
    const r = bootstrapRun(b);
    const note = `[manual] ⛔ merge-deploy refused ${short(b.x)}: npm audit --omit=dev in its image reports a high or critical advisory.\n`
      + 'proxy-addr critical — IP spoofing';
    expect([r.code, r.out, events(b.w), notes(b.w)]).toEqual([1, `${note}\n`, bootProbe(b), [note]]);
  });
});

describe('(б-л) plan b2 п.31: the holds and contract PRs of the range are shown, never a gate', () => {
  const labels = (b: Boot) => ({ WBB_PR_LABELS_CMD: stub(b.w.bin, 'labels-boot', `printf '8\\tdeploy:hold\\n9\\tmigration:contract\\n'`) });
  const held = () => bootWorld('absent', { 'src/a.ts': 'export const a = 2;\n', 'deploy/sudoers.d/wbb-image': 'ysi ALL=(root) NOPASSWD: x\n' });
  const shown = (b: Boot) => `The range ${short(b.w.base)}..${short(b.x)} — shown, not a gate (this run is the confirmation):\n`
    + '• path deploy/sudoers.d/wbb-image needs a human step\n'
    + `• PR #8 carries deploy:hold — ${GH}/8\n`
    + `• PR #9 carries migration:contract — ${GH}/9\n`
    + 'A fallback to the flat tree needs the pre snapshot restored.\n';

  it('the second run prints them and deploys all the same (0)', () => {
    const b = held();
    const r = bootstrapRun(b, labels(b));
    expect([r.code, r.out]).toEqual([0, `${shown(b)}[manual] ${bootSettledNote(b.x)}\n`]);
    expect(events(b.w)).toEqual([...bootToActivate(b), ...polls(61), `image prune --keep ${b.img.digest}`, 'prune']);
  });

  it('the first run prints them before the steps', () => {
    const b = held();
    hostSet(b.w, 'unit', 'foreign');
    const r = bootstrapRun(b, labels(b));
    expect([r.code, r.out]).toEqual([1, `${shown(b)}${bootSteps(b.x)}`]);
  });

  it('labels that could not be read are shown too, without the fallback line', () => {
    const b = held();
    hostSet(b.w, 'unit', 'foreign');
    const r = bootstrapRun(b, { WBB_PR_LABELS_CMD: stub(b.w.bin, 'labels-fail', 'exit 1') });
    expect([r.code, r.out]).toEqual([1,
      `The range ${short(b.w.base)}..${short(b.x)} — shown, not a gate (this run is the confirmation):\n`
      + '• path deploy/sudoers.d/wbb-image needs a human step\n'
      + `• could not read PR labels for ${short(b.x)}\n${bootSteps(b.x)}`]);
  });
});

describe('(б-в) bootstrap preconditions refuse (1), changing nothing', () => {
  it('an image is already settled', () => {
    const b = bootWorld('absent');
    seedState(b.w, { ...settledState(b.w.settled), LAST_SEEN_DEPLOYED_SHA: b.w.base });
    const before = stateText(b.w);
    const r = bootstrapRun(b);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w)]).toEqual([
      1, `an image is already settled (${short(b.w.base)}) — the first image release is done; deploy with bash deploy/deploy.sh\n`, before, [], [],
    ]);
  });

  it('no DEPLOYED_SHA to start from: a state without the key', () => {
    const b = bootWorld('absent');
    seedState(b.w, { LAST_SEEN_DEPLOYED_SHA: b.w.base });
    const before = stateText(b.w);
    const r = bootstrapRun(b);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w)]).toEqual([
      1, 'the state records no deployed commit — the first image release starts from the flat tree\'s DEPLOYED_SHA, which stage «в» carries over from state.env\n',
      before, [], [],
    ]);
  });

  it('no DEPLOYED_SHA to start from: no state file at all', () => {
    const b = bootWorld('absent');
    rmSync(b.w.statePath);
    const r = bootstrapRun(b);
    expect([r.code, r.out, existsSync(b.w.statePath), events(b.w), notes(b.w)]).toEqual([
      1, 'the state records no deployed commit — the first image release starts from the flat tree\'s DEPLOYED_SHA, which stage «в» carries over from state.env\n',
      false, [], [],
    ]);
  });

  it('X does not descend from DEPLOYED_SHA', () => {
    const w = imageWorld();
    for (const f of ['quadlet', 'container', 'running_sha']) hostSet(w, f, null);
    hostSet(w, 'unit', 'absent');
    git(w.seed, 'checkout', '-q', '-b', 'side');
    const side = commitTo(w, { 'src/side.ts': 's\n' }, 'side', 'side');
    git(w.seed, 'checkout', '-q', 'main');
    seedState(w, { DEPLOYED_SHA: side });
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
    publish(w, imageOf(x));
    const before = stateText(w);
    const r = manual(w, ['bootstrap', '--target', x]);
    expect([r.code, r.out, stateText(w), events(w), notes(w)]).toEqual([
      1, `production (${short(side)}) is not an ancestor of ${short(x)} — the first image release does not go backwards\n`, before, [], [],
    ]);
  });

  it('a Quadlet unit exists although nothing is settled', () => {
    const b = bootWorld('quadlet');
    const before = stateText(b.w);
    const r = bootstrapRun(b);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w)]).toEqual([
      1, 'a Quadlet unit exists but nothing is settled — check by hand (quadlet=none container-digest=none)\n', before, ['image current'], [],
    ]);
  });

  // Plan b2 п.33: unit=absent and not running — the old bot is stopped, so the refusal says the way back.
  it('no unit, but a Quadlet file names an image: refused with the way back', () => {
    const b = bootWorld('absent');
    hostSet(b.w, 'quadlet', b.img.digest);
    const before = stateText(b.w);
    const r = bootstrapRun(b);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w)]).toEqual([
      1, `no unit, but a Quadlet file or a container is there (quadlet=${b.img.digest} container-digest=none) and nothing is settled — check by hand\n${WAY_BACK}\n`,
      before, ['image current'], [],
    ]);
  });

  it('no unit and no Quadlet file, but a container is left (not the unit\'s: the unit is stopped): refused with the way back', () => {
    const b = bootWorld('absent');
    hostSet(b.w, 'container', b.img.digest);
    hostSet(b.w, 'unit_state', 'ActiveState=inactive\nSubState=dead\nMainPID=0');
    const before = stateText(b.w);
    const r = bootstrapRun(b);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w)]).toEqual([
      1, `no unit, but a Quadlet file or a container is there (quadlet=none container-digest=${b.img.digest}) and nothing is settled — check by hand\n${WAY_BACK}\n`,
      before, ['image current'], [],
    ]);
  });

  it('no unit, a Quadlet file left, and the old bot still runs: told to stop it, without the way back', () => {
    const b = bootWorld('absent');
    hostSet(b.w, 'quadlet', b.img.digest);
    hostSet(b.w, 'unit_state', 'ActiveState=active\nSubState=running\nMainPID=4242');
    const before = stateText(b.w);
    const r = bootstrapRun(b);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w)]).toEqual([
      1, 'the old bot still runs (unit=absent but active) — sudo systemctl stop warsaw-beer-bot, then run again\n', before, ['image current'], [],
    ]);
  });
});

describe('(б-г) a failed bootstrap window', () => {
  const reason = 'the manual window failed: health check failed 3 times in a row (last at +320s)';
  it('is an incident (3) blaming X (main\'s head), with no rollback to anything and the pre retained', () => {
    const b = bootWorld('absent');
    fault(b.w, 'health', 300, 99999, b.img.digest);
    const r = bootstrapRun(b);
    const marked = join(b.w.snapshots, b.pre.replace(/-pre\.db$/, '-rollback-pre.db'));
    expect(r.code).toBe(3);
    expect(events(b.w)).toEqual([...bootToActivate(b), ...polls(33), `mark ${b.pre}`]);
    expect(readState(b.w)).toEqual({
      DEPLOYED_SHA: b.x, DEPLOYED_DIGEST: b.img.digest, DEPLOYED_ID: b.img.id, DEPLOYED_CONTENT: b.img.content,
      LAST_SEEN_DEPLOYED_SHA: b.w.base, LAST_FAILED_SHA: b.x, RETAINED_PRE: marked, INCIDENT: `${b.x} ${b.img.digest} ${reason}`,
    });
    expect(notes(b.w)).toEqual([
      `[manual] 🔥 merge-deploy INCIDENT: ${short(b.x)} (${b.img.digest}) — ${reason}. Nothing was rolled back automatically (a manual window); the database is untouched.\n`
      + `Pre-deploy snapshot: ${marked} (kept until a human removes it: rm ${marked} ${marked}.sha256)\n`
      // Plan b2 п.28: an incident of the first image release names both ways out.
      + 'Nothing deploys until a human restores production and runs: bash deploy/deploy.sh --resolve-incident --settled <sha> '
      + '(an image of ours runs from the Quadlet file), or bash deploy/deploy.sh --resolve-incident --flat (the old unit and the flat tree run again)',
    ]);
  });

  it('of a commit behind main\'s head: the same incident, but X is not recorded as failed (plan b2 п.19)', () => {
    const b = bootWorld('absent');
    push(b.w, { 'src/a.ts': 'export const a = 3;\n' }, 'next');
    fault(b.w, 'health', 300, 99999, b.img.digest);
    expect(bootstrapRun(b).code).toBe(3);
    expect([readState(b.w).LAST_FAILED_SHA, readState(b.w).INCIDENT]).toEqual([undefined, `${b.x} ${b.img.digest} ${reason}`]);
  });
});

describe('(б-е) after the first image release the timer deploys as usual', () => {
  it('a new merge takes the ordinary auto path against S = D', () => {
    const b = bootWorld('absent');
    expect(bootstrapRun(b).code).toBe(0);
    const y = push(b.w, { 'src/a.ts': 'export const a = 3;\n' }, 'next');
    const imgY = publish(b.w, imageOf(y));
    tick(b.w);
    advance(b.w, 600);
    const before = events(b.w).length;
    expect(tick(b.w).code).toBe(0);
    const preY = `19700102T040640Z-${short(y)}-pre.db`;
    expect(events(b.w).slice(before)).toEqual([
      `checks ${y}`, `resolve ${y}`, `attest ${imgY.digest} ${y}`, `image pull --sha ${y} --digest ${imgY.digest}`, 'image current',
      `image audit --digest ${imgY.digest}`, `image local --digest ${b.img.digest}`, `snapshot ${preY}`,
      `image trial --digest ${imgY.digest} --previous ${b.img.digest} --snapshot ${preY}`, `image activate --digest ${imgY.digest}`,
      ...polls(61), `image prune --keep ${imgY.digest}`, 'prune',
    ]);
    expect(stateAtActivate(b.w, 2).WINDOW_MODE).toBe('auto');
    expect(readState(b.w)).toEqual({
      ...settledState(imgY), PREVIOUS_SHA: b.x, LAST_SEEN_DEPLOYED_SHA: y, MAIN_SEEN_SHA: y, MAIN_SEEN_S: '100600',
    });
  });
});

describe('(б-ж) a bootstrap interrupted after its activation', () => {
  it('the tick finds D running from the Quadlet file (row 3), watches the full window and settles it', () => {
    const b = bootWorld('absent');
    reply(b.w, 'activate', b.img.digest, 'kill-after');
    expect(bootstrapRun(b).code).toBe(null);
    expect(readState(b.w)).toEqual(bootWindow(b));
    expect(tick(b.w).code).toBe(0);
    expect(events(b.w).slice(bootToActivate(b).length)).toEqual(['image current', ...polls(61), `image prune --keep ${b.img.digest}`, 'prune']);
    expect(readState(b.w)).toEqual({ ...settledState(b.img), PREVIOUS_SHA: b.w.base, LAST_SEEN_DEPLOYED_SHA: b.x });
    expect(notes(b.w)).toEqual([bootSettledNote(b.x)]);
  });
});

describe('(б-з) a bootstrap activation refused before it changed anything', () => {
  it('nothing runs from a Quadlet file — production unchanged: the window is cancelled, the pre discarded, refused (1)', () => {
    const b = bootWorld('absent');
    reply(b.w, 'activate', b.img.digest, { code: 2, stderr: 'REFUSED: the unit is not generated from our Quadlet file\n' });
    const r = bootstrapRun(b);
    expect([r.code, r.out]).toEqual([
      1, `⚠️ merge-deploy: the activation of ${short(b.x)} was refused and changed nothing: the unit is not generated from our Quadlet file — run again\n${WAY_BACK}\n`,
    ]);
    expect(events(b.w)).toEqual([...bootToActivate(b), 'image current', `discard ${b.pre}`]);
    expect([readState(b.w), notes(b.w), readdirSync(b.w.snapshots)]).toEqual([{ DEPLOYED_SHA: b.w.base, LAST_SEEN_DEPLOYED_SHA: b.w.base }, [], []]);
  });
});

describe('(р-и) plan b2 п.23–24 and the review of Task 3: what a resolve settles besides S', () => {
  it('a retained pre that is gone (no file, no unmarked target) leaves the list as "already removed"', () => {
    const r = incidentWorld();
    rmSync(r.pres[1]);
    rmSync(`${r.pres[1]}.sha256`);
    expect(resolveRun(r).code).toBe(0);
    expect(readState(r.w)).toEqual(resolvedState(r));
    expect(events(r.w).filter((e) => e.startsWith('unmark '))).toEqual([`unmark 19700101T000000Z-${short(r.x)}-rollback-pre.db`]);
    expect(notes(r.w)).toEqual([`[manual] ${resolvedNote(r, [unmarkedOf(r.pres[0])])}\nAlready removed: ${r.pres[1]}`]);
  });

  it('five gone entries do not eat the limit: the sixth, a real one, is unmarked', () => {
    const r = incidentWorld();
    const dead = ['2', '3', '4', '5', '6'].map((n) => join(r.w.snapshots, `19700101T0${n}0000Z-${n.repeat(7)}-rollback-pre.db`));
    patchState(r.w, { RETAINED_PRE: [...dead, r.pres[0]].join(' ') });
    expect(resolveRun(r).code).toBe(0);
    expect(readState(r.w)).toEqual(resolvedState(r));
    expect(notes(r.w)).toEqual([`[manual] ${resolvedNote(r, [unmarkedOf(r.pres[0])])}\nAlready removed: ${dead.join(' ')}`]);
  });

  it('PENDING_MARK whose mark keeps failing: cleared by the settle, the pre stays an ordinary one, and prune runs', () => {
    const r = incidentWorld();
    const p = join(r.w.snapshots, `19700101T020000Z-${short(r.x)}-pre.db`);
    writeFileSync(p, 'pre\n');
    writeFileSync(`${p}.sha256`, `${'0'.repeat(64)}\n`);
    patchState(r.w, { PENDING_MARK: p });
    const failMark = stub(r.w.bin, 'mark-fail', `echo "mark $(basename "$1")" >> "${r.w.eventsLog}"; exit 1`);
    expect(resolveRun(r, { WBB_MARK_CMD: failMark }).code).toBe(0);
    expect(readState(r.w)).toEqual(resolvedState(r));
    expect(events(r.w)[0]).toBe(`mark 19700101T020000Z-${short(r.x)}-pre.db`);
    expect(events(r.w).slice(-1)).toEqual(['prune']);
    expect([existsSync(p), notes(r.w)]).toEqual([true, [`[manual] ${resolvedNote(r, r.pres.map(unmarkedOf))}`]]);
  });

  it('no retained pre at all: the note has no retention lines', () => {
    const r = incidentWorld();
    const { RETAINED_PRE: _p, ...rest } = r.seed;
    seedState(r.w, rest);
    expect(resolveRun(r).code).toBe(0);
    expect(notes(r.w)).toEqual([`[manual] ${resolvedNote(r, [])}`]);
  });

  it('a leftover incident window whose mark fails: the pre goes to PENDING_MARK, the resolve proceeds and settles', () => {
    const r = incidentWorld();
    const pre = join(r.w.snapshots, `19700102T034640Z-${short(r.x)}-pre.db`);
    writeFileSync(pre, 'pre\n');
    writeFileSync(`${pre}.sha256`, `${'0'.repeat(64)}\n`);
    seedState(r.w, {
      ...r.seed,
      WINDOW_SHA: r.x, WINDOW_DIGEST: r.img.digest, WINDOW_ID: r.img.id, WINDOW_CONTENT: r.img.content, WINDOW_OLD: r.s.sha,
      WINDOW_PREV_DIGEST: r.s.digest, WINDOW_KIND: 'deploy', WINDOW_MODE: 'manual', WINDOW_PHASE: 'watching', WINDOW_PRE: pre,
      WINDOW_START: '99000', WINDOW_BOOT: BOOT_ID, WINDOW_NRESTARTS: '0', WINDOW_FAILS: '3', WINDOW_LAST_READ: '99320',
    });
    const failMark = stub(r.w.bin, 'mark-fail', `echo "mark $(basename "$1")" >> "${r.w.eventsLog}"; exit 1`);
    expect(resolveRun(r, { WBB_MARK_CMD: failMark }).code).toBe(0);
    const first = writes(r.w)[0];
    expect([first.INCIDENT, first.PENDING_MARK, first.WINDOW_KIND]).toEqual([undefined, pre, 'resolve']);
    expect(readState(r.w)).toEqual(resolvedState(r));
    expect(existsSync(pre)).toBe(true);
  });

  it('resolving to X itself, main\'s head, whose window fails: no blame — LAST_FAILED_SHA stays absent', () => {
    const r = incidentWorld();
    git(r.w.repo, 'fetch', '-q', 'origin');
    runImage(r.w, r.img);
    const { LAST_FAILED_SHA: _f, ...rest } = r.seed;
    seedState(r.w, rest);
    fault(r.w, 'health', 300, 99999, r.img.digest);
    const res = manual(r.w, ['resolve-incident', '--settled', r.x]);
    expect(res.code).toBe(3);
    expect(readState(r.w)).toEqual({
      ...rest, INCIDENT: `${r.x} ${r.img.digest} the resolve window failed: health check failed 3 times in a row (last at +320s)`,
    });
  });
});

// --- plan b2 п.28: `--manual resolve-incident --flat` ----------------------------------------------------------

/**
 * The first image release X failed (an incident, nothing settled, two retained pres); the human brought the old
 * unit and the flat tree back: unit=foreign, running, /health answers base — a commit of main.
 */
function flatWorld(): Inc {
  const r = incidentWorld(false);
  for (const f of ['quadlet', 'container']) hostSet(r.w, f, null);
  hostSet(r.w, 'flat', '');
  hostSet(r.w, 'unit', 'foreign');
  hostSet(r.w, 'unit_state', 'ActiveState=active\nSubState=running\nMainPID=777');
  return r;
}
const flatRun = (r: Inc, over: Record<string, string> = {}) => manual(r.w, ['resolve-incident', '--flat'], over);
/** The one write of --flat: the incident gone, the flat tree's R recorded as deployed and observed, no digest. */
const flatState = (r: Inc, extra: Record<string, string> = {}) => ({
  DEPLOYED_SHA: r.s.sha, LAST_SEEN_DEPLOYED_SHA: r.s.sha, LAST_FAILED_SHA: r.x, ...extra,
});
const flatNote = (r: Inc, tail: string) => `[manual] ✅ merge-deploy: the incident is closed — the old unit runs the flat tree at ${short(r.s.sha)}, `
  + `recorded as deployed; nothing is settled. Next: bash deploy/deploy.sh --bootstrap${tail}`;

describe('(р-к) resolve-incident --flat: the happy path', () => {
  it('one write closes the incident and records R; the retained pres return; no window, nothing settled (0)', () => {
    const r = flatWorld();
    const res = flatRun(r);
    expect(res.code).toBe(0);
    expect(writes(r.w)[0]).toEqual(flatState(r, { RETAINED_PRE: r.pres.join(' ') }));
    expect(events(r.w)).toEqual([
      'image current', `unmark 19700101T000000Z-${short(r.x)}-rollback-pre.db`, 'unmark 19700101T010000Z-1111111-rollback-pre.db',
    ]);
    expect(readState(r.w)).toEqual(flatState(r));
    expect(notes(r.w)).toEqual([flatNote(r, `\nBack in ordinary retention: ${r.pres.map(unmarkedOf).join(' ')}`)]);
  });

  it('PENDING_MARK whose mark keeps failing is cleared in the same write (plan b2 п.24)', () => {
    const r = flatWorld();
    const p = join(r.w.snapshots, `19700101T020000Z-${short(r.x)}-pre.db`);
    writeFileSync(p, 'pre\n');
    writeFileSync(`${p}.sha256`, `${'0'.repeat(64)}\n`);
    patchState(r.w, { PENDING_MARK: p });
    const failMark = stub(r.w.bin, 'mark-fail', `echo "mark $(basename "$1")" >> "${r.w.eventsLog}"; exit 1`);
    expect(flatRun(r, { WBB_MARK_CMD: failMark }).code).toBe(0);
    expect(writes(r.w)[0]).toEqual(flatState(r, { RETAINED_PRE: r.pres.join(' ') }));
    expect([readState(r.w), existsSync(p)]).toEqual([flatState(r), true]);
  });

  it('killed after the write: the next tick runs as usual and says there is no settled image yet', () => {
    const r = flatWorld();
    const killUnmark = stub(r.w.bin, 'unmark-kill', '. "$WBB_FAKE_LIB"; kill_tick');
    expect(flatRun(r, { WBB_UNMARK_CMD: killUnmark }).code).toBe(null);
    expect(readState(r.w)).toEqual(flatState(r, { RETAINED_PRE: r.pres.join(' ') }));
    const t = tick(r.w);
    expect([t.code, events(r.w), notes(r.w)]).toEqual([0, ['image current'], [
      '⛔ merge-deploy: there is no settled image yet — the first image release is deployed by hand (manual window, spec §8 п.2); until then nothing deploys automatically.',
    ]]);
    expect(readState(r.w)).toEqual(flatState(r, { RETAINED_PRE: r.pres.join(' '), LAST_ASSESS_NOTICE: DAY1 }));
  });
});

describe('(р-л) resolve-incident --flat refuses (1) without changing anything', () => {
  it.each<[string, (r: Inc) => Record<string, string>, (r: Inc) => string, string[]]>([
    ['an image is settled', (r) => { patchState(r.w, settledState(r.s)); return {}; },
      (r) => `an image is settled (${short(r.s.sha)}) — --flat closes only an incident of the first image release; `
        + 'restore an image and run: bash deploy/deploy.sh --resolve-incident --settled <sha>', []],
    ['`current` cannot be read', (r) => { reply(r.w, 'current', '-', { code: 75, stderr: 'TEMPFAIL: podman inspect timed out after 60s\n' }); return {}; },
      () => 'could not read what production runs: TEMPFAIL podman inspect timed out after 60s — run again', ['image current']],
    ['the unit is our Quadlet, not the old one', (r) => { hostSet(r.w, 'unit', 'quadlet'); return {}; },
      () => 'the old unit is not there (unit=quadlet) — --flat closes the incident only when the old unit runs the flat tree again', ['image current']],
    ['the old unit does not run', (r) => { hostSet(r.w, 'unit_state', 'ActiveState=inactive\nSubState=dead\nMainPID=0'); return {}; },
      () => 'the old unit does not run — start it (sudo systemctl start warsaw-beer-bot), then run again', ['image current']],
    ['the unit state unreadable', (r) => { hostSet(r.w, 'unit_state', 'SubState=running'); return {}; },
      () => 'could not read whether the old unit runs (systemctl show warsaw-beer-bot) — run again', ['image current']],
    ['API_PORT cannot be read', (r) => ({ WBB_API_PORT_CMD: stub(r.w.bin, 'port-fail', 'exit 1') }),
      () => 'could not resolve API_PORT — run again', ['image current']],
    ['/health does not answer', (r) => { hostSet(r.w, 'unhealthy', ''); return {}; },
      () => '/health does not answer — the flat tree is not up; run again when it answers', ['image current']],
    ['/health answers a commit that is not on main', (r) => { hostSet(r.w, 'running_sha', 'f'.repeat(40)); return {}; },
      () => '/health answers releaseSha fffffff, which is not on origin/main — it cannot be recorded as deployed', ['image current']],
  ])('%s', (_name, setup, out, evs) => {
    const r = flatWorld();
    const over = setup(r);
    const before = stateText(r.w);
    const res = flatRun(r, over);
    expect([res.code, res.out, stateText(r.w), events(r.w), notes(r.w)]).toEqual([1, `${out(r)}\n`, before, evs, []]);
  });

  it('no incident is open', () => {
    const w = imageWorld();
    const before = stateText(w);
    const res = manual(w, ['resolve-incident', '--flat']);
    expect([res.code, res.out, stateText(w), events(w), notes(w)])
      .toEqual([1, 'no INCIDENT is open — there is nothing to resolve\n', before, [], []]);
  });
});

// --- the end-to-end review of the b2 core (plan b2 п.33–35, 37) ---------------------------------------------------

/** Plan b2 п.33: what a failed first image release may leave, named with the step that removes it. */
const leftoverText = (q: string, d: string) => `a Quadlet file or a container of ours is left although nothing is settled (quadlet=${q} container-digest=${d}) `
  + '— with the old unit moved aside, systemd would run it instead of a new release. '
  + 'Remove it: sudo rm /etc/containers/systemd/warsaw-beer-bot.container (a container left: sudo podman rm -f warsaw-beer-bot), then run again\n';
/** Plan b2 п.28, п.34: the two ways out of an incident when nothing is settled. */
const BOTH_WAYS = 'bash deploy/deploy.sh --resolve-incident --settled <sha> (an image of ours runs from the Quadlet file), '
  + 'or bash deploy/deploy.sh --resolve-incident --flat (the old unit and the flat tree run again)';

describe('(б-м) plan b2 п.33: a Quadlet file left by a failed first image release', () => {
  it('bootstrap, first run (the old unit runs) with a Quadlet file left: refused (1), the file named, no steps, nothing changed', () => {
    const b = bootWorld('foreign');
    hostSet(b.w, 'quadlet', b.img.digest);
    const before = stateText(b.w);
    const r = bootstrapRun(b);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w), existsSync(b.w.snapshots)])
      .toEqual([1, leftoverText(b.img.digest, 'none'), before, ['image current'], [], false]);
  });

  it('--flat with a Quadlet file left: refused (1), the file named, nothing changed', () => {
    const r = flatWorld();
    hostSet(r.w, 'quadlet', r.img.digest);
    const before = stateText(r.w);
    const res = flatRun(r);
    expect([res.code, res.out, stateText(r.w), events(r.w), notes(r.w)]).toEqual([1, leftoverText(r.img.digest, 'none'), before, ['image current'], []]);
  });

  it('--flat with a container left: refused (1), nothing changed', () => {
    const r = flatWorld();
    hostSet(r.w, 'container', r.img.digest);
    const before = stateText(r.w);
    const res = flatRun(r);
    expect([res.code, res.out, stateText(r.w), events(r.w), notes(r.w)]).toEqual([1, leftoverText('none', r.img.digest), before, ['image current'], []]);
  });
});

describe('(р-м) resolve-incident --flat with the incident\'s window still in the state', () => {
  it('the window\'s pre is kept first, in the same one write; then every retained pre returns (0)', () => {
    const r = flatWorld();
    const pre = join(r.w.snapshots, `19700102T034640Z-${short(r.x)}-pre.db`);
    writeFileSync(pre, 'pre\n');
    writeFileSync(`${pre}.sha256`, `${'0'.repeat(64)}\n`);
    seedState(r.w, {
      ...r.seed,
      WINDOW_SHA: r.x, WINDOW_DIGEST: r.img.digest, WINDOW_ID: r.img.id, WINDOW_CONTENT: r.img.content, WINDOW_OLD: r.s.sha,
      WINDOW_KIND: 'bootstrap', WINDOW_MODE: 'manual', WINDOW_PHASE: 'watching', WINDOW_PRE: pre,
      WINDOW_START: '99000', WINDOW_BOOT: BOOT_ID, WINDOW_NRESTARTS: '0', WINDOW_FAILS: '3', WINDOW_LAST_READ: '99320',
    });
    const marked = pre.replace(/-pre\.db$/, '-rollback-pre.db');
    const res = flatRun(r);
    const back = [...r.pres, marked].map(unmarkedOf);
    const note = flatNote(r, `\nBack in ordinary retention: ${back.join(' ')}`);
    expect([res.code, res.out]).toEqual([0,
      `the incident's window was still in the state; its pre: ${marked} (kept until a human removes it: rm ${marked} ${marked}.sha256)\n`
      + back.map((p) => `returned to ordinary retention: ${p}\n`).join('') + `${note}\n`]);
    expect(writes(r.w)).toEqual([flatState(r, { RETAINED_PRE: [...r.pres, marked].join(' ') }), flatState(r)]);
    expect(events(r.w)).toEqual([
      'image current', `mark 19700102T034640Z-${short(r.x)}-pre.db`,
      `unmark 19700101T000000Z-${short(r.x)}-rollback-pre.db`, 'unmark 19700101T010000Z-1111111-rollback-pre.db',
      `unmark 19700102T034640Z-${short(r.x)}-rollback-pre.db`,
    ]);
    expect([readState(r.w), notes(r.w)]).toEqual([flatState(r), [note]]);
  });
});

describe('(р-н) plan b2 п.34: with nothing settled, every text of an incident names --flat too', () => {
  it('a failed resolve window with nothing settled names both ways out', () => {
    const r = incidentWorld(false);
    fault(r.w, 'health', 300, 99999, r.s.digest);
    const res = resolveRun(r);
    const reason = 'the resolve window failed: health check failed 3 times in a row (last at +320s)';
    expect(res.code).toBe(3);
    expect(notes(r.w)).toEqual([
      `[manual] 🔥 merge-deploy INCIDENT: ${short(r.s.sha)} (${r.s.digest}) — ${reason}. Nothing was rolled back automatically (a manual window); the database is untouched.\n`
      + 'Pre-deploy snapshot: none (the window had no pre snapshot)\n'
      + `Nothing deploys until a human restores production and runs: ${BOTH_WAYS}`,
    ]);
  });

  it('the tick\'s daily reminder of an incident of the first image release names both', () => {
    const b = bootWorld('absent');
    seedState(b.w, { DEPLOYED_SHA: b.w.base, LAST_SEEN_DEPLOYED_SHA: b.w.base, INCIDENT: `${b.x} ${b.img.digest} the manual window failed: not healthy within 120s` });
    const t = tick(b.w);
    expect([t.code, events(b.w), notes(b.w)]).toEqual([0, [], [
      `🔥 merge-deploy: an INCIDENT is open — ${short(b.x)} (${b.img.digest}): the manual window failed: not healthy within 120s\n`
      + `Nothing deploys until a human resolves it: ${BOTH_WAYS}.`,
    ]]);
  });

  it('a manual deploy refused by an incident of the first image release names both', () => {
    const b = bootWorld('absent');
    seedState(b.w, { DEPLOYED_SHA: b.w.base, LAST_SEEN_DEPLOYED_SHA: b.w.base, INCIDENT: `${b.x} ${b.img.digest} the manual window failed: not healthy within 120s` });
    const before = stateText(b.w);
    const r = manual(b.w, ['deploy', '--target', b.x]);
    expect([r.code, r.out, stateText(b.w), events(b.w), notes(b.w)]).toEqual([1,
      `an INCIDENT is open — ${short(b.x)} (${b.img.digest}): the manual window failed: not healthy within 120s\n`
      + `Nothing deploys until it is resolved: ${BOTH_WAYS}\n`, before, [], []]);
  });
});

describe('(р-о) plan b2 п.35: the resolve window stands on the NRestarts its precondition read', () => {
  it('readable once, then never: the window opens on that base (no second read), and its lost evidence is an incident (3), not a write failure', () => {
    const r = incidentWorld();
    const count = join(r.w.bin, 'restarts-count');
    const restarts = stub(r.w.bin, 'restarts-once', `n=$(cat "${count}" 2>/dev/null || echo 0); echo $(( n + 1 )) > "${count}"; [ "$n" = 0 ] || exit 1; echo 0`);
    const res = resolveRun(r, { WBB_RESTARTS_CMD: restarts });
    const reason = 'the resolve window failed: could not observe production for 300s (current, NRestarts or the unit state unreadable)';
    expect(res.code).toBe(3);
    const { INCIDENT: _incident, ...rest } = r.seed;
    expect(writes(r.w)[0]).toEqual({
      ...rest,
      WINDOW_SHA: r.s.sha, WINDOW_DIGEST: r.s.digest, WINDOW_ID: r.s.id, WINDOW_CONTENT: r.s.content, WINDOW_OLD: r.x,
      WINDOW_PREV_DIGEST: r.s.digest, WINDOW_KIND: 'resolve', WINDOW_MODE: 'manual', WINDOW_PHASE: 'watching',
      WINDOW_START: '100000', WINDOW_BOOT: BOOT_ID, WINDOW_NRESTARTS: '0', WINDOW_FAILS: '0', WINDOW_LAST_READ: '100000',
    });
    expect(events(r.w)).toEqual([...resolveProbe(r), ...polls(31)]);
    expect(readState(r.w)).toEqual({ ...r.seed, INCIDENT: `${r.s.sha} ${r.s.digest} ${reason}` });
    expect(notes(r.w)).toEqual([
      `[manual] 🔥 merge-deploy INCIDENT: ${short(r.s.sha)} (${r.s.digest}) — ${reason}. Nothing was rolled back automatically (a manual window); the database is untouched.\n`
      + 'Pre-deploy snapshot: none (the window had no pre snapshot)\n'
      + 'Nothing deploys until a human restores production and runs: bash deploy/deploy.sh --resolve-incident --settled <sha>',
    ]);
  });
});
