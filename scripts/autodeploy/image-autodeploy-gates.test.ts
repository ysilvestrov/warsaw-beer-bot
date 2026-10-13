import { describe, it, expect, vi } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOT_ID, CHECKS_OK, DAY1, GOLDEN_DIR, SCRIPT,
  advance, checksStub, clonedMain, commitTo, events, git, golden, hostSet, imageOf, imageWorld, notes, patchState,
  publish, push, readState, ready, reply, runImage, seedState, settledState, short, stateText, stub, syncs, tick,
  tickEnv, writeStateText, type Image, type ImageWorld,
} from './image-autodeploy-harness';

// Each test drives real bash ticks through real git (~1–3 s on a 4-core box); see autodeploy.test.ts.
vi.setConfig({ testTimeout: 20_000 });

/**
 * The image controller deploy/image/autodeploy.sh, Task 1 of
 * docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md: its state, the gates carried
 * over from deploy/autodeploy.sh, CI with `image`, the incident gate, and resolve → attest → pull → noop.
 * Bullets (а)–(ї) of the task are the describe blocks below.
 */

const PULL = (x: string, img: Image) => `image pull --sha ${x} --digest ${img.digest}`;
/** The calls of a tick that passes every gate and finds X a no-op. */
const noopEvents = (x: string, img: Image, keeps: string[]) => [
  `checks ${x}`, `resolve ${x}`, `attest ${img.digest} ${x}`, PULL(x, img), 'image current',
  `image prune ${keeps.map((k) => `--keep ${k}`).join(' ')}`,
];

/** A commit whose image has the deployed image's wbb.content: it changes nothing that runs. */
function noopCandidate(w: ImageWorld, files: Record<string, string> = { 'docs/x.md': 'hello\n' }): { x: string; img: Image } {
  const x = push(w, files, 'change');
  return { x, img: publish(w, imageOf(x, w.settled.content)) };
}

const HOLD_TAIL = 'Do the steps, then run bash deploy/deploy.sh on the host — that releases the hold.';

describe('image merge-deploy: the entry', () => {
  it('takes no arguments (usage 64) and does nothing at all', () => {
    const w = imageWorld();
    const before = stateText(w);
    const r = tick(w, {}, ['--target', w.base]);
    expect([r.code, stateText(w), events(w), notes(w)]).toEqual([64, before, [], []]);
  });
});

describe('(ж) noop: equal wbb.content and production is the recorded deployment', () => {
  it('records X as deployed, prunes images but the deployed one, and says nothing', () => {
    const w = imageWorld();
    const { x, img } = noopCandidate(w);
    ready(w);
    const r = tick(w);
    expect(r.code).toBe(0);
    expect(events(w)).toEqual(noopEvents(x, img, [w.settled.digest]));
    expect(readState(w)).toEqual({
      ...settledState(w.settled), DEPLOYED_SHA: x, LAST_SEEN_DEPLOYED_SHA: x, MAIN_SEEN_SHA: x, MAIN_SEEN_S: '100000',
    });
    expect(notes(w)).toEqual([]);
  });

  it('is up to date, silently, on the next tick', () => {
    const w = imageWorld();
    const { x, img } = noopCandidate(w);
    ready(w);
    tick(w);
    const r = tick(w);
    expect([r.code, events(w), notes(w)]).toEqual([0, noopEvents(x, img, [w.settled.digest]), []]);
  });

  it('keeps both the deployed and the settled image when they differ', () => {
    const w = imageWorld();
    const mid = push(w, { 'src/a.ts': '2\n' }, 'mid');
    const p = publish(w, imageOf(mid));
    runImage(w, p);
    seedState(w, {
      ...settledState(w.settled), DEPLOYED_SHA: mid, DEPLOYED_DIGEST: p.digest, DEPLOYED_ID: p.id, DEPLOYED_CONTENT: p.content,
    });
    const x = push(w, { 'docs/x.md': 'hello\n' }, 'docs');
    const img = publish(w, imageOf(x, p.content));
    ready(w);
    tick(w);
    expect(events(w)).toEqual(noopEvents(x, img, [p.digest, w.settled.digest]));
    expect(readState(w).DEPLOYED_SHA).toBe(x);
  });

  it('records the noop although the image prune fails', () => {
    const w = imageWorld();
    const { x } = noopCandidate(w);
    reply(w, 'prune', '-', { code: 75, stderr: 'TEMPFAIL: podman images timed out\n' });
    ready(w);
    const r = tick(w);
    expect([r.code, readState(w).DEPLOYED_SHA, notes(w)]).toEqual([0, x, []]);
  });
});

describe('(з) not a noop when production is not the recorded deployment', () => {
  const other = imageOf('9'.repeat(40));
  it.each([
    ['the Quadlet file names another image', (w: ImageWorld) => hostSet(w, 'quadlet', other.digest),
      (s: Image) => `quadlet=${other.digest} container-image=${s.id} container-digest=${s.digest} unit=quadlet`],
    ['the container runs another image', (w: ImageWorld) => hostSet(w, 'container', other.digest),
      (s: Image) => `quadlet=${s.digest} container-image=${other.id} container-digest=${other.digest} unit=quadlet`],
    ['no container runs', (w: ImageWorld) => hostSet(w, 'container', null),
      (s: Image) => `quadlet=${s.digest} container-image=none container-digest=none unit=quadlet`],
    ['the unit is not our Quadlet', (w: ImageWorld) => hostSet(w, 'unit', 'foreign'),
      (s: Image) => `quadlet=${s.digest} container-image=${s.id} container-digest=${s.digest} unit=foreign`],
  ])('%s: assesses once a day and records nothing', (_name, drift, found) => {
    const w = imageWorld();
    publish(w, other);
    const { x, img } = noopCandidate(w);
    drift(w);
    ready(w);
    const r = tick(w);
    tick(w);
    const s = w.settled;
    expect(r.code).toBe(0);
    expect(events(w)).toEqual([...noopEvents(x, img, []).slice(0, 5), ...noopEvents(x, img, []).slice(0, 5)]);
    expect(readState(w).DEPLOYED_SHA).toBe(w.base);
    expect(notes(w)).toEqual([
      `⚠️ merge-deploy: ${short(x)} changes nothing that runs (wbb.content ${s.content}), but production does not match the record: `
      + `expected quadlet=${s.digest} container-image=${s.id} container-digest=${s.digest} unit=quadlet, found ${found(s)}. `
      + 'Not recording it as deployed; check the host.',
    ]);
  });

  it('assesses when what production runs cannot be read', () => {
    const w = imageWorld();
    const { x, img } = noopCandidate(w);
    reply(w, 'current', '-', { code: 75, stderr: 'TEMPFAIL: podman inspect warsaw-beer-bot timed out after 60s\n' });
    ready(w);
    expect(tick(w).code).toBe(0);
    expect(events(w)).toEqual(noopEvents(x, img, []).slice(0, 5));
    expect(readState(w).DEPLOYED_SHA).toBe(w.base);
    expect(notes(w)).toEqual([
      `⚠️ merge-deploy: could not read what production runs: TEMPFAIL podman inspect warsaw-beer-bot timed out after 60s — not deploying ${short(x)}; retrying next tick.`,
    ]);
  });
});

describe('(и) holds come before the noop', () => {
  it('holds a commit that runs nothing new but changes a held path, calling no helper', () => {
    const w = imageWorld();
    noopCandidate(w, { 'docs/x.md': 'a\n', 'deploy/sudoers.d/wbb-image': 'ysi ALL=(root) NOPASSWD: x\n' });
    ready(w);
    expect(tick(w).code).toBe(0);
    expect(events(w)).toEqual([]);
    expect(readState(w).DEPLOYED_SHA).toBe(w.base);
    expect(notes(w)).toEqual([
      `⏸ merge-deploy: production is behind main and HELD:\n• path deploy/sudoers.d/wbb-image needs a human step\n${HOLD_TAIL}`,
    ]);
  });
});

describe('(а) gates carried over: quiet main, failed SHA, PAUSED, up to date', () => {
  it('does nothing 599 s after main moved, and goes on at 600 s', () => {
    const w = imageWorld();
    const { x, img } = noopCandidate(w);
    tick(w);
    advance(w, 599);
    tick(w);
    expect(events(w)).toEqual([]);
    advance(w, 1);
    tick(w);
    expect(events(w)).toEqual(noopEvents(x, img, [w.settled.digest]));
  });

  it('restarts the quiet period when main moves again, and takes only the newest head', () => {
    const w = imageWorld();
    noopCandidate(w);
    tick(w);
    advance(w, 300);
    const { x, img } = noopCandidate(w, { 'docs/y.md': 'two\n' });
    tick(w);
    expect([readState(w).MAIN_SEEN_SHA, readState(w).MAIN_SEEN_S]).toEqual([x, '100300']);
    advance(w, 300);
    tick(w);
    expect(events(w)).toEqual([]);
    advance(w, 300);
    tick(w);
    expect(events(w)).toEqual(noopEvents(x, img, [w.settled.digest]));
  });

  it('does nothing, silently, when production is main, and records its first observation', () => {
    const w = imageWorld();
    const r = tick(w);
    expect([r.code, events(w), notes(w)]).toEqual([0, [], []]);
    expect(readState(w)).toEqual({ ...settledState(w.settled), LAST_SEEN_DEPLOYED_SHA: w.base });
  });

  it('skips main quietly when it is recorded as LAST_FAILED_SHA', () => {
    const w = imageWorld();
    const { x } = noopCandidate(w);
    seedState(w, { ...settledState(w.settled), LAST_FAILED_SHA: x });
    ready(w);
    tick(w);
    expect([events(w), notes(w)]).toEqual([[], []]);
  });

  it('does nothing at all while PAUSED', () => {
    const w = imageWorld();
    noopCandidate(w);
    writeFileSync(join(w.stateDir, 'PAUSED'), '');
    const before = stateText(w);
    const r = tick(w);
    expect([r.code, stateText(w), events(w), clonedMain(w)]).toEqual([0, before, [], w.base]);
  });

  it('refuses what could be a downgrade: production is not an ancestor of main', () => {
    const w = imageWorld();
    git(w.seed, 'checkout', '-q', '-b', 'side');
    const side = commitTo(w, { 'src/side.ts': 's' }, 'side', 'side');
    git(w.seed, 'checkout', '-q', 'main');
    const { x } = noopCandidate(w);
    patchState(w, { DEPLOYED_SHA: side });
    ready(w);
    const r = tick(w);
    expect([r.code, events(w)]).toEqual([0, []]);
    expect(notes(w)).toEqual([
      `⚠️ merge-deploy: production (${short(side)}) is not an ancestor of main (${short(x)}) — refusing what could be a downgrade. Deploy main by hand to reseed.`,
    ]);
  });
});

describe('(а) installed copies (plan п.15)', () => {
  const OVER = {
    WBB_READ_ENV: '/opt/test/bin/wbb-read-env',
    WBB_SNAPSHOT_BIN: '/opt/test/bin/wbb-db-snapshot',
    WBB_IMAGE_LIB: '/opt/test/lib/wbb-image',
    WBB_IMAGE_BIN: '/opt/test/libexec/wbb-image',
  };

  it('checks exactly the deployer, its helpers and the image helper copies, and waits while one is stale', () => {
    const w = imageWorld();
    noopCandidate(w);
    const args = join(w.bin, 'installed.args');
    const stale = stub(w.bin, 'installed-stale', [
      `printf '%s\\n' "$@" > "${args}"`,
      'echo "STALE: 1 installed file(s) differ from origin/main:"',
      'echo "  deploy/image/helper/wbb_image.py"',
      'exit 1',
    ].join('\n'));
    const over = { ...OVER, WBB_INSTALLED_CHECK: stale };
    ready(w, over);
    const r = tick(w, over);
    tick(w, over);
    expect([r.code, events(w)]).toEqual([0, []]);
    expect(readFileSync(args, 'utf8').split('\n').filter((l) => l !== '')).toEqual([
      w.repo,
      'origin/main',
      `deploy/image/autodeploy.sh=${SCRIPT}`,
      'deploy/read-env.sh=/opt/test/bin/wbb-read-env',
      'deploy/db-snapshot.sh=/opt/test/bin/wbb-db-snapshot',
      `deploy/installed-current.sh=${stale}`,
      'deploy/image/helper/wbb_image.py=/opt/test/lib/wbb-image/wbb_image.py',
      'deploy/image/helper/bounded.py=/opt/test/lib/wbb-image/bounded.py',
      'deploy/image/helper/wbb-image.sh=/opt/test/libexec/wbb-image',
      'deploy/image/warsaw-beer-bot.container=/opt/test/lib/wbb-image/warsaw-beer-bot.container',
    ]);
    expect(notes(w)).toEqual([
      '⚠️ merge-deploy is waiting: the installed deployer is out of date — a merged fix is not live until it is installed.\n'
      + 'STALE: 1 installed file(s) differ from origin/main:\n  deploy/image/helper/wbb_image.py\n'
      + 'Run: sudo bash deploy/install-autodeploy.sh (the deployer) and sudo bash deploy/install-image.sh (the image helper)',
    ]);
  });

  it('says so once a day while up to date, too', () => {
    const w = imageWorld();
    const stale = stub(w.bin, 'installed-stale', 'echo "STALE: 1 installed file(s) differ from origin/main:"; exit 1');
    tick(w, { WBB_INSTALLED_CHECK: stale });
    tick(w, { WBB_INSTALLED_CHECK: stale });
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([
      '⚠️ merge-deploy: the installed deployer is out of date — a merged fix is not live until it is installed.\n'
      + 'STALE: 1 installed file(s) differ from origin/main:\n'
      + 'Run: sudo bash deploy/install-autodeploy.sh (the deployer) and sudo bash deploy/install-image.sh (the image helper)',
    ]);
    expect(readState(w).LAST_STALE_NOTICE).toBe(DAY1);
  });
});

describe('(а) holds by path and by label, fail closed', () => {
  it.each([
    'deploy/sudoers.d/wbb-image',
    'deploy/wbb-autodeploy.service',
    'deploy/install-image.sh',
    'deploy/rsync-filter',
    'deploy/autodeploy.sh',
    'deploy/image/autodeploy.sh',
    'deploy/image/helper/wbb_image.py',
    'deploy/image/helper/bounded.py',
    'deploy/image/helper/wbb-image.sh',
    'deploy/image/warsaw-beer-bot.container',
    'deploy/db-snapshot.sh',
  ])('a change to %s holds, naming the path, calling nothing', (path) => {
    const w = imageWorld();
    noopCandidate(w, { [path]: 'changed\n' });
    ready(w);
    tick(w);
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([
      `⏸ merge-deploy: production is behind main and HELD:\n• path ${path} needs a human step\n${HOLD_TAIL}`,
    ]);
  });

  it.each([
    'deploy/image/deploy.sh',
    'deploy/image/Dockerfile',
    'deploy/image/start-check.cjs',
    'deploy/warsaw-beer-bot.service',
    'deploy/deploy.sh',
    'src/x.ts',
  ])('a change to %s does not hold', (path) => {
    const w = imageWorld();
    const { x, img } = noopCandidate(w, { [path]: 'changed\n' });
    ready(w);
    tick(w);
    expect(events(w)).toEqual(noopEvents(x, img, [w.settled.digest]));
  });

  it('says it once a day', () => {
    const w = imageWorld();
    noopCandidate(w, { 'deploy/sudoers.d/warsaw-beer-bot': 'x\n' });
    ready(w);
    tick(w);
    tick(w);
    expect(notes(w).length).toBe(1);
    expect(readState(w).LAST_HOLD_NOTICE).toBe(DAY1);
  });

  it('holds on a PR labelled exactly deploy:hold', () => {
    const w = imageWorld();
    noopCandidate(w);
    const labels = stub(w.bin, 'labels-hold', `printf '8\\tbug,deploy:hold\\n'`);
    ready(w, { WBB_PR_LABELS_CMD: labels });
    tick(w, { WBB_PR_LABELS_CMD: labels });
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([
      `⏸ merge-deploy: production is behind main and HELD:\n• PR #8 carries deploy:hold — https://github.com/ysilvestrov/warsaw-beer-bot/pull/8\n${HOLD_TAIL}`,
    ]);
  });

  it('does not hold on labels that merely contain a hold label', () => {
    const w = imageWorld();
    const { x, img } = noopCandidate(w);
    const labels = stub(w.bin, 'labels-near', `printf '8\\tdeploy:hold-later,x-rollback:unsafe,migration:contract-ish\\n'`);
    ready(w, { WBB_PR_LABELS_CMD: labels });
    tick(w, { WBB_PR_LABELS_CMD: labels });
    expect(events(w)).toEqual(noopEvents(x, img, [w.settled.digest]));
  });

  it('holds when PR labels cannot be read — fail closed', () => {
    const w = imageWorld();
    const { x } = noopCandidate(w);
    const labels = stub(w.bin, 'labels-broken', 'exit 1');
    ready(w, { WBB_PR_LABELS_CMD: labels });
    tick(w, { WBB_PR_LABELS_CMD: labels });
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([
      `⏸ merge-deploy: production is behind main and HELD:\n• could not read PR labels for ${short(x)}\n${HOLD_TAIL}`,
    ]);
  });

  it('a manual deploy past the held commit releases the hold', () => {
    const w = imageWorld();
    const held = push(w, { 'deploy/sudoers.d/warsaw-beer-bot': 'x\n' }, 'sudoers');
    const { x, img } = noopCandidate(w);
    patchState(w, { DEPLOYED_SHA: held });
    ready(w);
    tick(w);
    expect(events(w)).toEqual(noopEvents(x, img, [w.settled.digest]));
  });
});

describe('(в) a PR whose code-only rollback is not proven is a hold with --ack-incompatible', () => {
  it.each(['rollback:unsafe', 'migration:contract'])('%s holds and names the manual deploy', (label) => {
    const w = imageWorld();
    noopCandidate(w, { 'src/a.ts': '2\n' });
    const labels = stub(w.bin, 'labels-unsafe', `printf '8\\tfeat,${label}\\n'`);
    ready(w, { WBB_PR_LABELS_CMD: labels });
    const r = tick(w, { WBB_PR_LABELS_CMD: labels });
    expect([r.code, events(w)]).toEqual([0, []]);
    expect(notes(w)).toEqual([
      `⏸ merge-deploy: production is behind main and HELD:\n• PR #8 carries ${label} — a code-only rollback is not proven safe; `
      + 'deploy it by hand with bash deploy/deploy.sh --ack-incompatible — https://github.com/ysilvestrov/warsaw-beer-bot/pull/8\n'
      + HOLD_TAIL,
    ]);
  });
});

describe('(б) CI: ci AND image succeeded in one check suite', () => {
  it('waits, silently, for an image check that has not appeared', () => {
    const w = imageWorld();
    const { x } = noopCandidate(w);
    const checks = checksStub(w, 'checks-ci-only', ['ci\tcompleted\tsuccess\t101']);
    ready(w, { WBB_CHECKS_CMD: checks });
    expect(tick(w, { WBB_CHECKS_CMD: checks }).code).toBe(0);
    expect([events(w), notes(w)]).toEqual([[`checks ${x}`], []]);
  });

  it('waits, silently, while the image check is still running', () => {
    const w = imageWorld();
    const { x } = noopCandidate(w);
    const checks = checksStub(w, 'checks-image-running', ['ci\tcompleted\tsuccess\t101', 'image\tin_progress\t\t101']);
    ready(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    expect([events(w), notes(w)]).toEqual([[`checks ${x}`], []]);
  });

  it('waits when ci and image succeeded only in different suites', () => {
    const w = imageWorld();
    const { x } = noopCandidate(w);
    const checks = checksStub(w, 'checks-two-suites', ['ci\tcompleted\tsuccess\t101', 'image\tcompleted\tsuccess\t202']);
    ready(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    expect([events(w), notes(w)]).toEqual([[`checks ${x}`], []]);
  });

  it('goes on when both succeeded in one suite, whatever else ran', () => {
    const w = imageWorld();
    const { x, img } = noopCandidate(w);
    const checks = checksStub(w, 'checks-mixed', [
      'ci\tcompleted\tsuccess\t300', 'image\tcompleted\tsuccess\t101', 'ci\tcompleted\tsuccess\t101',
      'claude\tcompleted\tskipped\t400', 'note\tcompleted\tneutral\t401',
    ]);
    ready(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(events(w)).toEqual(noopEvents(x, img, [w.settled.digest]));
  });

  it('reports a failed image check once per SHA and does not record LAST_FAILED_SHA', () => {
    const w = imageWorld();
    const { x } = noopCandidate(w);
    const checks = checksStub(w, 'checks-image-red', ['ci\tcompleted\tsuccess\t101', 'image\tcompleted\tfailure\t101']);
    ready(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(events(w)).toEqual([`checks ${x}`, `checks ${x}`]);
    expect(notes(w)).toEqual([
      `⛔ merge-deploy: CI failed on ${short(x)} — not deploying. image=failure\nRe-running the failed job releases it; nothing else to do here.`,
    ]);
    expect([readState(w).LAST_CI_NOTICE_SHA, readState(w).LAST_FAILED_SHA]).toEqual([x, undefined]);
  });

  it('treats a cancelled check as a failure', () => {
    const w = imageWorld();
    const { x } = noopCandidate(w);
    const checks = checksStub(w, 'checks-cancelled', [...CHECKS_OK, 'build (root)\tcompleted\tcancelled\t101']);
    ready(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(notes(w)).toEqual([
      `⛔ merge-deploy: CI failed on ${short(x)} — not deploying. build (root)=cancelled\nRe-running the failed job releases it; nothing else to do here.`,
    ]);
  });

  it('reports CI that has not concluded after an hour, once a day', () => {
    const w = imageWorld();
    const { x } = noopCandidate(w);
    const checks = checksStub(w, 'checks-pending', ['ci\tqueued\t\t101']);
    tick(w, { WBB_CHECKS_CMD: checks });
    advance(w, 3599);
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(notes(w)).toEqual([]);
    advance(w, 1);
    tick(w, { WBB_CHECKS_CMD: checks });
    advance(w, 300);
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(notes(w)).toEqual([
      `⚠️ merge-deploy: CI has not concluded on ${short(x)} after 60 min (the required 'ci' and 'image' checks of one run are pending or absent).`,
    ]);
  });

  it.each([
    ['the API failed', 'exit 1'],
    ['a line has no suite column', `printf 'ci\\tcompleted\\tsuccess\\nimage\\tcompleted\\tsuccess\\n'`],
  ])('waits and says so once a day when CI cannot be read: %s', (_name, body) => {
    const w = imageWorld();
    const { x } = noopCandidate(w);
    const checks = stub(w.bin, 'checks-unreadable', body);
    ready(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([`⚠️ merge-deploy cannot read CI status for ${short(x)} (gh api failed). Waiting.`]);
  });
});

describe('(г) an open INCIDENT blocks everything before git and CI', () => {
  it('calls no helper, fetches nothing, reads no CI, and reminds once a day', () => {
    const w = imageWorld();
    const s = w.settled;
    seedState(w, { ...settledState(s), INCIDENT: `${w.base} ${s.digest} window failed: health check failed 3 times in a row` });
    noopCandidate(w);
    const r = tick(w);
    tick(w);
    const reminder = `🔥 merge-deploy: an INCIDENT is open — ${short(w.base)} (${s.digest}): window failed: health check failed 3 times in a row\n`
      + 'Nothing deploys until a human resolves it: bash deploy/deploy.sh --resolve-incident --settled <sha>.';
    expect([r.code, events(w), clonedMain(w), notes(w)]).toEqual([0, [], w.base, [reminder]]);
    expect(readState(w).LAST_INCIDENT_NOTICE).toBe(DAY1);
    advance(w, 86_400);
    tick(w);
    expect([events(w), notes(w)]).toEqual([[], [reminder, reminder]]);
  });
});

describe('(ґ) without a settled image the first image release is a human\'s', () => {
  it('says so once a day and calls no helper', () => {
    const w = imageWorld();
    seedState(w, { DEPLOYED_SHA: w.base });
    noopCandidate(w);
    const r = tick(w);
    tick(w);
    expect([r.code, events(w)]).toEqual([0, []]);
    expect(notes(w)).toEqual([
      '⛔ merge-deploy: there is no settled image yet — the first image release is deployed by hand (manual window, spec §8 п.2); until then nothing deploys automatically.',
    ]);
    expect(readState(w)).toEqual({ DEPLOYED_SHA: w.base, LAST_SEEN_DEPLOYED_SHA: w.base, LAST_ASSESS_NOTICE: DAY1 });
  });
});

describe('(д) the tag → digest is resolved, or the commit waits', () => {
  it('waits when no image is published for X (resolve exit 3), without attesting or blaming X', () => {
    const w = imageWorld();
    const x = push(w, { 'docs/x.md': 'a\n' }, 'docs');
    ready(w);
    const r = tick(w);
    tick(w);
    expect([r.code, events(w)]).toEqual([0, [`checks ${x}`, `resolve ${x}`, `checks ${x}`, `resolve ${x}`]]);
    expect(notes(w)).toEqual([
      `⚠️ merge-deploy: no image is published for ${short(x)} (no tag ${x} in ghcr.io/ysilvestrov/warsaw-beer-bot) — waiting; NOT a finding against the commit.`,
    ]);
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
  });

  it.each([
    ['the registry could not be read', { code: 1, stderr: 'curl: (28) Operation timed out\n' }, 1],
    ['the answer is not a digest', { code: 0, stdout: 'sha256:abc\n' }, 0],
    ['the answer is two digests', { code: 0, stdout: `sha256:${'1'.repeat(64)}\nsha256:${'2'.repeat(64)}\n` }, 0],
  ])('assesses when %s', (_name, answer, rc) => {
    const w = imageWorld();
    const { x } = noopCandidate(w);
    reply(w, 'resolve', x, answer);
    ready(w);
    expect(tick(w).code).toBe(0);
    expect(events(w)).toEqual([`checks ${x}`, `resolve ${x}`]);
    expect(notes(w)).toEqual([`⚠️ merge-deploy: could not resolve the image of ${short(x)} (exit ${rc}) — NOT a finding; retrying next tick.`]);
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
  });
});

describe('(е) no attestation, no pull', () => {
  it('refuses to pull an image the attestation does not tie to X, once a day, without LAST_FAILED_SHA', () => {
    const w = imageWorld();
    const x = push(w, { 'docs/x.md': 'a\n' }, 'docs');
    // The tag X names an image CI built from another commit.
    const foreign = publish(w, imageOf('7'.repeat(40), w.settled.content));
    hostSet(w, `tags/${x}`, foreign.digest);
    ready(w);
    const r = tick(w);
    tick(w);
    const once = [`checks ${x}`, `resolve ${x}`, `attest ${foreign.digest} ${x}`];
    expect([r.code, events(w)]).toEqual([0, [...once, ...once]]);
    expect(notes(w)).toEqual([
      `⛔ merge-deploy: the image of ${short(x)} (${foreign.digest}) did not pass attestation (exit 1) — not deploying it; NOT recorded as a failed commit.\n`
      + `Error: verifying with issuer "sigstore.dev": expected SourceRepositoryDigest to be ${x}, got ${'7'.repeat(40)}`,
    ]);
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
  });

  it('treats an attestation that could not run like one that failed', () => {
    const w = imageWorld();
    const { x, img } = noopCandidate(w);
    reply(w, 'attest', img.digest, { code: 1, stderr: 'Error: no valid Sigstore verifiers could be initialized\n' });
    ready(w);
    tick(w);
    expect(events(w)).toEqual([`checks ${x}`, `resolve ${x}`, `attest ${img.digest} ${x}`]);
    expect(notes(w)).toEqual([
      `⛔ merge-deploy: the image of ${short(x)} (${img.digest}) did not pass attestation (exit 1) — not deploying it; NOT recorded as a failed commit.\n`
      + 'Error: no valid Sigstore verifiers could be initialized',
    ]);
  });
});

describe('(є) a pull that does not confirm exactly D and X is "could not verify"', () => {
  const D = `sha256:${'d'.repeat(64)}`;
  const X1 = '1'.repeat(40);
  it.each([
    ['REFUSED (exit 2, golden)', () => golden('pull-refused'),
      `REFUSED ghcr.io/ysilvestrov/warsaw-beer-bot@${D}: label org.opencontainers.image.revision is ${'2'.repeat(40)}, expected ${X1}`],
    ['TEMPFAIL (exit 75, golden)', () => golden('pull-tempfail'),
      `TEMPFAIL podman pull ghcr.io/ysilvestrov/warsaw-beer-bot@${D} exited 125: Error: initializing source docker://ghcr.io/ysilvestrov/warsaw-beer-bot: pinging container registry ghcr.io: connection refused`],
    ['exit 1 without a line', () => ({ code: 1 }), 'UNKNOWN exit 1: no output'],
    ['exit 1 from sudo without a rule', () => ({ code: 1, stderr: 'sudo: a password is required\n' }), 'UNKNOWN exit 1: sudo: a password is required'],
    ['the PULLED line of the golden output, for another digest and commit', () => golden('pull-pulled'),
      `PULLED ${D} ${'a'.repeat(64)} ${'c'.repeat(64)} ${X1}`],
  ])('%s: assesses, calls nothing after pull, blames nothing', (_name, answer, verdict) => {
    const w = imageWorld();
    const { x, img } = noopCandidate(w);
    reply(w, 'pull', img.digest, answer());
    ready(w);
    expect(tick(w).code).toBe(0);
    expect(events(w)).toEqual(noopEvents(x, img, []).slice(0, 4));
    expect(notes(w)).toEqual([
      `⚠️ merge-deploy: the image of ${short(x)} (${img.digest}) was not pulled as asked: ${verdict} — NOT a finding; retrying next tick.`,
    ]);
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
  });

  const E = `sha256:${'e'.repeat(64)}`;
  const X2 = '2'.repeat(40);
  it.each([
    ['another digest',
      (x: string, img: Image) => `PULLED ${E} ${img.id} content=${img.content} revision=${x}`,
      (x: string, img: Image) => `PULLED ${E} ${img.id} ${img.content} ${x}`],
    ['another revision',
      (_x: string, img: Image) => `PULLED ${img.digest} ${img.id} content=${img.content} revision=${X2}`,
      (_x: string, img: Image) => `PULLED ${img.digest} ${img.id} ${img.content} ${X2}`],
  ])('assesses a PULLED line for %s', (_name, line, verdict) => {
    const w = imageWorld();
    const { x, img } = noopCandidate(w);
    reply(w, 'pull', img.digest, { code: 0, stdout: `${line(x, img)}\n` });
    ready(w);
    tick(w);
    expect(events(w)).toEqual(noopEvents(x, img, []).slice(0, 4));
    expect(notes(w)).toEqual([
      `⚠️ merge-deploy: the image of ${short(x)} (${img.digest}) was not pulled as asked: ${verdict(x, img)} — NOT a finding; retrying next tick.`,
    ]);
  });
});

describe('(і) the state: parsed, validated, written atomically', () => {
  it('ignores state.env: with no image-state.env it is a first start', () => {
    const w = imageWorld();
    const old = `DEPLOYED_SHA=${w.base}\nPREVIOUS_SHA=\nINCIDENT=${w.base} ${w.settled.digest} old\n`;
    writeFileSync(join(w.stateDir, 'state.env'), old);
    rmSync(w.statePath);
    noopCandidate(w);
    const r = tick(w);
    expect([r.code, events(w)]).toEqual([0, []]);
    expect(notes(w)).toEqual([
      '⛔ merge-deploy: there is no settled image yet — the first image release is deployed by hand (manual window, spec §8 п.2); until then nothing deploys automatically.',
    ]);
    expect(readState(w)).toEqual({ LAST_ASSESS_NOTICE: DAY1 });
    expect(readFileSync(join(w.stateDir, 'state.env'), 'utf8')).toBe(old);
  });

  it('never runs a value: $(touch …) stays text', () => {
    const w = imageWorld();
    const marker = join(w.bin, 'executed');
    seedState(w, { ...settledState(w.settled), INCIDENT: `${w.base} ${w.settled.digest} $(touch ${marker})` });
    const r = tick(w);
    expect([r.code, existsSync(marker)]).toEqual([0, false]);
    expect(notes(w)).toEqual([
      `🔥 merge-deploy: an INCIDENT is open — ${short(w.base)} (${w.settled.digest}): $(touch ${marker})\n`
      + 'Nothing deploys until a human resolves it: bash deploy/deploy.sh --resolve-incident --settled <sha>.',
    ]);
  });

  const good = (w: ImageWorld) => Object.entries(settledState(w.settled)).map(([k, v]) => `${k}=${v}\n`).join('');
  const window = (w: ImageWorld) => `WINDOW_SHA=${w.base}\nWINDOW_MODE=auto\nWINDOW_PHASE=activating\n`;
  /** A whole window of the given phase, every key it stands on. */
  const fullWindow = (w: ImageWorld, phase: string, extra: string[] = []) => [
    `WINDOW_SHA=${w.base}`, `WINDOW_DIGEST=${w.settled.digest}`, `WINDOW_ID=${w.settled.id}`, `WINDOW_CONTENT=${w.settled.content}`,
    `WINDOW_OLD=${w.base}`, `WINDOW_PREV_DIGEST=${w.settled.digest}`, 'WINDOW_MODE=auto', `WINDOW_PHASE=${phase}`,
    'WINDOW_PRE=/s/19700102T035640Z-abcdef0-pre.db', 'WINDOW_START=100000', `WINDOW_BOOT=${BOOT_ID}`,
    'WINDOW_NRESTARTS=0', 'WINDOW_FAILS=0', 'WINDOW_LAST_READ=100000', 'WINDOW_NRESTARTS_PRE=0', ...extra, '',
  ].join('\n');
  const ROLLING = ['WINDOW_REASON=a reason', 'ROLLBACK_ATTEMPTS=0'];
  const CORRUPT: Array<[string, (w: ImageWorld) => string, string]> = [
    ['an unknown key', (w) => `${good(w)}DEPLOYED_TAG=v1\n`, 'line 9: unknown key DEPLOYED_TAG'],
    ['a duplicated key', (w) => `${good(w)}DEPLOYED_SHA=${w.base}\n`, 'line 9: duplicate key DEPLOYED_SHA'],
    ['a truncated file', (w) => good(w).slice(0, -1), 'the last line has no newline (a truncated file)'],
    ['a line that is not KEY=value', (w) => `# written by hand\n${good(w)}`, 'line 1 is not KEY=value'],
    ['an empty file', () => '', 'the file is empty'],
    ['a NUL byte', (w) => `${good(w)}\0`, 'the file holds a NUL byte'],
    ['a SHA that is not 40 hex', (w) => good(w).replace(`DEPLOYED_SHA=${w.base}`, `DEPLOYED_SHA=${short(w.base)}`),
      'DEPLOYED_SHA has a value that is not of its format'],
    ['SETTLED_SHA without SETTLED_DIGEST', (w) => good(w).replace(/^SETTLED_DIGEST=.*\n/m, ''),
      'SETTLED_SHA is set but SETTLED_DIGEST is not'],
    ['WINDOW_PHASE without WINDOW_DIGEST', (w) => `${good(w)}${window(w)}`, 'WINDOW_PHASE is set but WINDOW_DIGEST is not'],
    ['an unknown WINDOW_PHASE', (w) => `${good(w)}${window(w)}WINDOW_DIGEST=${w.settled.digest}\n`.replace('=activating', '=deploying'),
      'WINDOW_PHASE has a value that is not of its format'],
    ['an integer with a leading zero', (w) => `${good(w)}MAIN_SEEN_SHA=${w.base}\nMAIN_SEEN_S=0100000\n`,
      'MAIN_SEEN_S has a value that is not of its format'],
    // F7: what each phase stands on.
    ['an activating window without WINDOW_PRE', (w) => `${good(w)}${fullWindow(w, 'activating')}`.replace(/^WINDOW_PRE=.*\n/m, ''),
      'WINDOW_PHASE is set but WINDOW_PRE is not'],
    ['a watching window without WINDOW_LAST_READ', (w) => `${good(w)}${fullWindow(w, 'watching')}`.replace(/^WINDOW_LAST_READ=.*\n/m, ''),
      'WINDOW_PHASE is set but WINDOW_LAST_READ is not'],
    ['a rolling-back window without ROLLBACK_ATTEMPTS', (w) => `${good(w)}${fullWindow(w, 'rolling-back', ['WINDOW_REASON=a reason'])}`,
      'WINDOW_PHASE is set but ROLLBACK_ATTEMPTS is not'],
    ['a manual window rolling back', (w) => `${good(w)}${fullWindow(w, 'rolling-back', ROLLING)}`.replace('WINDOW_MODE=auto', 'WINDOW_MODE=manual'),
      'WINDOW_PHASE is rolling-back but WINDOW_MODE is manual (a manual window never rolls back)'],
    ['ACTIVATE_ATTEMPTS without a window', (w) => `${good(w)}ACTIVATE_ATTEMPTS=1\n`, 'ACTIVATE_ATTEMPTS is set but WINDOW_PHASE is not'],
    // Round 2, item 3: snapshot paths — no glob character, no space, one space between list elements.
    ['a PENDING_MARK path with a glob character', (w) => `${good(w)}PENDING_MARK=/s/*-pre.db\n`, 'PENDING_MARK has a value that is not of its format'],
    ['a RETAINED_PRE list with an empty element', (w) => `${good(w)}RETAINED_PRE=/s/a-rollback-pre.db  /s/b-rollback-pre.db\n`,
      'RETAINED_PRE has a value that is not of its format'],
    ['a WINDOW_PRE that is not a pre snapshot', (w) => `${good(w)}${fullWindow(w, 'activating')}`.replace('WINDOW_PRE=/s/19700102T035640Z-abcdef0-pre.db', 'WINDOW_PRE=/s/notes.txt'),
      'WINDOW_PRE has a value that is not of its format'],
  ];

  it.each(CORRUPT)('STATE CORRUPT on %s: nothing runs, the file is untouched, 🔥 once a day, exit 3', (_name, build, problem) => {
    const w = imageWorld();
    const text = build(w);
    writeStateText(w, text);
    noopCandidate(w);
    const first = tick(w);
    const second = tick(w);
    expect([first.code, second.code]).toEqual([3, 3]);
    expect([events(w), clonedMain(w), stateText(w)]).toEqual([[], w.base, text]);
    expect(notes(w)).toEqual([
      `🔥 merge-deploy: STATE CORRUPT — ${w.statePath}: ${problem}. Nothing runs until a human repairs the file; it is never taken for a first start.`,
    ]);
  });

  it.each([
    ['a symlink to a valid state', (w: ImageWorld, real: string) => symlinkSync(real, w.statePath)],
    ['a dangling symlink', (w: ImageWorld, real: string) => { symlinkSync(real, w.statePath); rmSync(real); }],
  ])('STATE CORRUPT on %s: never a first start (F7)', (_name, link) => {
    const w = imageWorld();
    const real = join(w.home, 'elsewhere.env');
    writeFileSync(real, readFileSync(w.statePath, 'utf8'));
    rmSync(w.statePath);
    link(w, real);
    noopCandidate(w);
    expect(tick(w).code).toBe(3);
    expect([events(w), clonedMain(w)]).toEqual([[], w.base]);
    expect(notes(w)).toEqual([
      `🔥 merge-deploy: STATE CORRUPT — ${w.statePath}: the path is a symlink. Nothing runs until a human repairs the file; it is never taken for a first start.`,
    ]);
  });

  it('writes through a temporary file: fsync, rename, fsync of the directory', () => {
    const w = imageWorld();
    seedState(w, { ...settledState(w.settled), LAST_SEEN_DEPLOYED_SHA: w.base });
    const x = push(w, { 'docs/x.md': 'a\n' }, 'docs');
    tick(w);
    const s = w.settled;
    const written = [
      `DEPLOYED_SHA=${w.base}`, `LAST_SEEN_DEPLOYED_SHA=${w.base}`, `MAIN_SEEN_SHA=${x}`, 'MAIN_SEEN_S=100000',
      `DEPLOYED_DIGEST=${s.digest}`, `DEPLOYED_ID=${s.id}`, `DEPLOYED_CONTENT=${s.content}`,
      `SETTLED_SHA=${w.base}`, `SETTLED_DIGEST=${s.digest}`, `SETTLED_ID=${s.id}`, `SETTLED_CONTENT=${s.content}`,
    ];
    expect(syncs(w)).toEqual([
      `sync -- ${w.statePath}.tmp | tmp=${written.join(';')};`,
      `sync -- ${w.stateDir} | tmp=absent`,
    ]);
    expect([stateText(w), existsSync(`${w.statePath}.tmp`)]).toEqual([`${written.join('\n')}\n`, false]);
  });

  it('exits 4 and says so when the state cannot be written', () => {
    const w = imageWorld();
    tick(w); // the lock file exists while the directory is still writable
    const before = stateText(w);
    push(w, { 'docs/x.md': 'a\n' }, 'docs');
    chmodSync(w.stateDir, 0o500);
    try {
      const r = tick(w);
      expect([r.code, stateText(w)]).toEqual([4, before]);
      expect(notes(w)).toEqual([
        `🔥 merge-deploy: failed to write ${w.statePath} — its record of what is deployed may now disagree with production.`,
      ]);
    } finally {
      chmodSync(w.stateDir, 0o755);
    }
  });

  it('refuses (exit 4) to write a value with a newline', () => {
    const w = imageWorld();
    seedState(w, { ...settledState(w.settled), LAST_SEEN_DEPLOYED_SHA: w.base });
    const before = stateText(w);
    push(w, { 'docs/x.md': 'a\n' }, 'docs');
    const clock = stub(w.bin, 'clock-two-lines', `printf '100000\\n7\\n'`);
    const r = tick(w, { WBB_CLOCK_CMD: clock });
    expect([r.code, stateText(w), syncs(w)]).toEqual([4, before, []]);
    expect(notes(w)).toEqual([
      `🔥 merge-deploy: refusing to write ${w.statePath} — the value of MAIN_SEEN_S contains a newline, and the file holds one key per line. Its record of what is deployed may now disagree with production.`,
    ]);
  });

  it('refuses (exit 4) to write what it would not read back', () => {
    const w = imageWorld();
    seedState(w, { ...settledState(w.settled), LAST_SEEN_DEPLOYED_SHA: w.base });
    const before = stateText(w);
    push(w, { 'docs/x.md': 'a\n' }, 'docs');
    const clock = stub(w.bin, 'clock-float', 'echo 100000.5');
    const r = tick(w, { WBB_CLOCK_CMD: clock });
    expect([r.code, stateText(w)]).toEqual([4, before]);
    expect(notes(w)).toEqual([
      `🔥 merge-deploy: refusing to write an invalid state to ${w.statePath}: MAIN_SEEN_S has a value that is not of its format. Its record of what is deployed may now disagree with production.`,
    ]);
  });
});

describe('(а) the observed-production fence (#768)', () => {
  const record = (w: ImageWorld, sha: string) => patchState(w, { DEPLOYED_SHA: sha });
  function observed() {
    const w = imageWorld();
    const one = push(w, { 'src/a.ts': '2\n' }, 'one');
    const two = push(w, { 'src/a.ts': '3\n' }, 'two');
    record(w, two);
    tick(w);
    return { w, one, two };
  }
  const held = (w: ImageWorld, from: string, to: string, now: string, reasons = '') =>
    `⏸ merge-deploy: production is HELD: observed production regression ${short(from)} → ${short(to)}; currently ${short(now)}. `
    + `A deliberate rollback must not be overwritten automatically.${reasons}\n`
    + `Deploy main by hand (bash deploy/deploy.sh; --force if histories diverge) if it contains ${short(from)}. `
    + 'If main omits that commit, verify intended production and follow deploy/README.md → Operator acknowledgement of a replacement baseline.';

  it('reports a backwards transition with lost commit and PR counts, and holds across ticks', () => {
    const { w, two } = observed();
    record(w, w.base);
    expect(tick(w).code).toBe(0);
    const warning = `⚠️ merge-deploy: production went BACKWARDS: ${short(two)} → ${short(w.base)} (2 commits, 1 PRs no longer reachable) — `
      + 'was this a deliberate rollback? Unattended deploys are HELD. Deploy main by hand to recover.';
    expect(notes(w)).toEqual([warning, held(w, two, w.base, w.base)]);
    expect([readState(w).LAST_SEEN_DEPLOYED_SHA, readState(w).REGRESSION_FROM_SHA, readState(w).REGRESSION_TO_SHA])
      .toEqual([w.base, two, w.base]);
    noopCandidate(w);
    ready(w);
    tick(w);
    expect([events(w), notes(w).length, readState(w).DEPLOYED_SHA]).toEqual([[], 2, w.base]);
  });

  it('counts distinct PRs over all lost commits and keeps the other hold reasons', () => {
    const { w, one, two } = observed();
    record(w, w.base);
    const labels = stub(w.bin, 'lost-prs', `case "$1" in ${one}) printf '17\\t\\n18\\tdeploy:hold\\n' ;; ${two}) printf '18\\tdeploy:hold\\n' ;; esac`);
    tick(w, { WBB_PR_LABELS_CMD: labels });
    expect(notes(w)).toEqual([
      `⚠️ merge-deploy: production went BACKWARDS: ${short(two)} → ${short(w.base)} (2 commits, 2 PRs no longer reachable) — `
      + 'was this a deliberate rollback? Unattended deploys are HELD. Deploy main by hand to recover.',
      held(w, two, w.base, w.base, '\n• PR #18 carries deploy:hold — https://github.com/ysilvestrov/warsaw-beer-bot/pull/18'),
    ]);
  });

  it('keeps the observation pending and the brake durable when the notifier fails', () => {
    const { w, two } = observed();
    record(w, w.base);
    const fail = stub(w.bin, 'notify-fails', 'exit 1');
    expect(tick(w, { WBB_NOTIFY_CMD: fail }).code).toBe(0);
    expect([readState(w).LAST_SEEN_DEPLOYED_SHA, readState(w).REGRESSION_FROM_SHA, events(w)]).toEqual([two, two, []]);
    tick(w);
    expect(notes(w).filter((m) => m.includes('production went BACKWARDS:')).length).toBe(1);
    expect(readState(w).LAST_SEEN_DEPLOYED_SHA).toBe(w.base);
  });

  it('reports divergent production and holds instead of guessing a rollback', () => {
    const { w, two } = observed();
    git(w.seed, 'checkout', '-q', '-b', 'sibling', w.base);
    const sibling = commitTo(w, { 'src/a.ts': 'other\n' }, 'sibling', 'sibling');
    record(w, sibling);
    tick(w);
    expect(notes(w)).toEqual([
      `⚠️ merge-deploy: production DIVERGED: ${short(two)} → ${short(sibling)} (2 commits, 1 PRs no longer reachable) — `
      + 'was this a deliberate rollback? Unattended deploys are HELD. Deploy main by hand to recover.',
      held(w, two, sibling, sibling),
    ]);
    expect([events(w), readState(w).REGRESSION_FROM_SHA]).toEqual([[], two]);
  });

  it('retains the fence during partial recovery, clears it when regained, then proceeds', () => {
    const { w, one, two } = observed();
    record(w, w.base);
    tick(w);
    record(w, one);
    ready(w);
    tick(w);
    expect([readState(w).LAST_SEEN_DEPLOYED_SHA, readState(w).REGRESSION_FROM_SHA, events(w)]).toEqual([one, two, []]);
    record(w, two);
    tick(w);
    expect([readState(w).LAST_SEEN_DEPLOYED_SHA, readState(w).REGRESSION_FROM_SHA, readState(w).REGRESSION_TO_SHA])
      .toEqual([two, undefined, undefined]);
    const { x, img } = noopCandidate(w);
    ready(w);
    tick(w);
    expect(events(w)).toEqual(noopEvents(x, img, [w.settled.digest]));
  });

  it('reports an unassessable recorded commit without erasing the prior observation', () => {
    const { w, two } = observed();
    record(w, 'a'.repeat(40));
    tick(w);
    expect(notes(w)).toEqual([
      '⚠️ merge-deploy: cannot assess the deployed transition — recorded production (aaaaaaa) is not a locally available commit. '
      + 'Keeping the previous observation; unattended deploys are blocked. Recover the Git history or deploy and verify intended main, '
      + 'then follow deploy/README.md → Operator acknowledgement of a replacement baseline.',
    ]);
    expect([readState(w).LAST_SEEN_DEPLOYED_SHA, readState(w).REGRESSION_FROM_SHA, events(w)]).toEqual([two, undefined, []]);
  });

  it('refuses (exit 4) before sending the regression warning when its brake cannot be persisted', () => {
    const { w, two } = observed();
    record(w, w.base);
    chmodSync(w.stateDir, 0o500);
    try {
      expect(tick(w).code).toBe(4);
      expect(notes(w)).toEqual([
        `🔥 merge-deploy: failed to write ${w.statePath} — its record of what is deployed may now disagree with production.`,
      ]);
      expect([readState(w).LAST_SEEN_DEPLOYED_SHA, readState(w).REGRESSION_FROM_SHA]).toEqual([two, undefined]);
    } finally {
      chmodSync(w.stateDir, 0o755);
    }
  });
});

describe('(а) a stalled lock', () => {
  /** Holds the tick's lock in another process; resolves once it is held. */
  async function holdLock(lock: string): Promise<ChildProcess> {
    const holder = spawn('flock', ['-o', lock, 'sleep', '60'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i += 1) {
      if (spawnSync('flock', ['-n', lock, 'true']).status === 1) return holder;
      await new Promise((res) => setTimeout(res, 20));
    }
    holder.kill();
    throw new Error('the lock holder never acquired the lock');
  }

  // LOCK_STALL_S = TICK_BUDGET_S (7500) + 300.
  it('says nothing for 7799 s, then reports a held lock once a day', async () => {
    const w = imageWorld();
    const before = stateText(w);
    const holder = await holdLock(join(w.stateDir, 'lock'));
    try {
      expect(tick(w).code).toBe(0);
      advance(w, 7799);
      tick(w);
      expect(notes(w)).toEqual([]);
      advance(w, 1);
      tick(w);
      tick(w);
      expect(notes(w)).toEqual([
        `⚠️ merge-deploy: the deploy lock has been held for 130 min — no tick can run. A stuck manual deploy.sh? Check: fuser -v ${join(w.stateDir, 'lock')}`,
      ]);
      expect([stateText(w), events(w)]).toEqual([before, []]);
    } finally {
      holder.kill();
    }
  });

  it('forgets the busy period once a tick gets the lock', async () => {
    const w = imageWorld();
    const holder = await holdLock(join(w.stateDir, 'lock'));
    tick(w);
    const busy = join(w.stateDir, 'lock-busy-since');
    expect(readFileSync(busy, 'utf8').trim()).toBe('100000');
    holder.kill();
    await new Promise((res) => holder.once('exit', res));
    tick(w);
    expect(existsSync(busy)).toBe(false);
  });

  it('treats a busy-since record older than two stall periods as stale', async () => {
    const w = imageWorld();
    writeFileSync(join(w.stateDir, 'lock-busy-since'), String(100000 - 15600));
    const holder = await holdLock(join(w.stateDir, 'lock'));
    try {
      tick(w);
      expect(notes(w)).toEqual([]);
      expect(readFileSync(join(w.stateDir, 'lock-busy-since'), 'utf8').trim()).toBe('100000');
    } finally {
      holder.kill();
    }
  });
});

describe('(ї) verdict parsers on the real helper\'s golden outputs', () => {
  const SRC = readFileSync(SCRIPT, 'utf8');
  const PARSERS = SRC.slice(SRC.indexOf('# --- verdict parsers (pure'), SRC.indexOf('# --- verdict parsers ---'));
  function parse(action: string, code: number, stdout: string, stderr: string): string {
    return execFileSync('bash', ['-c', `${PARSERS}\nparse_verdict "$@"`, '_', action, String(code), stdout, stderr],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C.UTF-8' } });
  }
  const D = `sha256:${'d'.repeat(64)}`;
  const S = `sha256:${'5'.repeat(64)}`;
  const GOLDEN: Array<[string, string]> = [
    ['activate-activated', `ACTIVATED ${D}\n`],
    ['activate-failed', 'ACTIVATE_FAILED ACTIVATE FAILED: restart exited 1: Job for warsaw-beer-bot.service failed because the control '
      + 'process exited with error code. See "systemctl status warsaw-beer-bot.service" and "journalctl -xeu warsaw-beer-bot.service" for details.\n'],
    ['audit-advisory', `ADVISORY ${D}\nproxy-addr critical — proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet `
      + 'https://github.com/advisories/GHSA-jqcg-44mw-7w3h\n'],
    ['audit-clean', `CLEAN ${D}\n`],
    ['current-absent', 'CURRENT none none none absent\n'],
    ['current-foreign', `CURRENT ${S} ${'b'.repeat(64)} ${S} foreign\n`],
    ['current-quadlet', `CURRENT ${S} ${'b'.repeat(64)} ${S} quadlet\n`],
    ['local-local', `LOCAL ${S} ${'b'.repeat(64)} ${'e'.repeat(64)} ${'2'.repeat(40)}\n`],
    ['local-not-local', `NOT_LOCAL ${D}\n`],
    ['pull-pulled', `PULLED ${D} ${'a'.repeat(64)} ${'c'.repeat(64)} ${'1'.repeat(40)}\n`],
    ['pull-refused', `REFUSED ghcr.io/ysilvestrov/warsaw-beer-bot@${D}: label org.opencontainers.image.revision is ${'2'.repeat(40)}, expected ${'1'.repeat(40)}\n`],
    ['pull-tempfail', `TEMPFAIL podman pull ghcr.io/ysilvestrov/warsaw-beer-bot@${D} exited 125: Error: initializing source `
      + 'docker://ghcr.io/ysilvestrov/warsaw-beer-bot: pinging container registry ghcr.io: connection refused\n'],
    ['trial-compat-failed-start-timeout', 'COMPAT_FAILED COMPAT FAILED: START TIMEOUT: no "api listening" within 90s\n'],
    ['trial-compat-failed', 'COMPAT_FAILED COMPAT FAILED: START FAILED: bot exited (code 1) before "api listening"\n'],
    ['trial-ok', `OK ${S}\n`],
    ['trial-refused', `REFUSED previous image ${S} predates start-check --leave-running\n`],
    ['trial-start-failed', 'FAILED START FAILED: /health answered {"ok":false}\n'],
    ['trial-tempfail', `TEMPFAIL start-check in ${D} exited 75: START KILLED: bot killed by SIGKILL (out of memory?)\n`],
    ['trial-trial-failed', 'FAILED TRIAL FAILED: no such column: venue_id\n'],
  ];

  it('covers every golden output', () => {
    expect(GOLDEN.map(([n]) => `${n}.txt`)).toEqual(readdirSync(GOLDEN_DIR).sort());
  });

  it.each(GOLDEN)('%s', (name, expected) => {
    const g = golden(name);
    expect(parse(name.split('-')[0], g.code, g.stdout, g.stderr)).toBe(expected);
  });

  it.each(['pull', 'local', 'audit', 'trial', 'activate', 'current', 'prune'])(
    '%s: exit 1 with no line (sudo -n without a rule) is UNKNOWN, never a verdict', (action) => {
      expect(parse(action, 1, '', '')).toBe('UNKNOWN exit 1: no output\n');
    });

  it.each([
    ['REFUSED on the second stderr line', 'pull', 2, '', 'usage: wbb-image\nREFUSED: late\n', 'UNKNOWN exit 2: usage: wbb-image\n'],
    ['TEMPFAIL with exit 2', 'pull', 2, '', 'TEMPFAIL: x\n', 'UNKNOWN exit 2: TEMPFAIL: x\n'],
    ['REFUSED with exit 75', 'activate', 75, '', 'REFUSED: x\n', 'UNKNOWN exit 75: REFUSED: x\n'],
    ['a traceback (exit 70)', 'current', 70, '', 'Traceback (most recent call last):\n  File "x"\n', 'UNKNOWN exit 70: Traceback (most recent call last):\n'],
    ['PULLED with a second line', 'pull', 0, `PULLED ${D} ${'a'.repeat(64)} content=${'c'.repeat(64)} revision=${'1'.repeat(40)}\nmore\n`, '',
      `UNKNOWN exit 0: PULLED ${D} ${'a'.repeat(64)} content=${'c'.repeat(64)} revision=${'1'.repeat(40)}\n`],
    ['PULLED with exit 1', 'pull', 1, `PULLED ${D} ${'a'.repeat(64)} content=${'c'.repeat(64)} revision=${'1'.repeat(40)}\n`, '',
      `UNKNOWN exit 1: PULLED ${D} ${'a'.repeat(64)} content=${'c'.repeat(64)} revision=${'1'.repeat(40)}\n`],
    ['an advisory that is not the first line', 'audit', 1, `proxy-addr critical\nAUDIT ADVISORY ${D}\n`, '', 'UNKNOWN exit 1: proxy-addr critical\n'],
    ['AUDIT CLEAN with exit 1', 'audit', 1, `AUDIT CLEAN ${D}\n`, '', `UNKNOWN exit 1: AUDIT CLEAN ${D}\n`],
    ['a trial that never reached COMPAT', 'trial', 0, `TRIAL OK: schema 46 -> 47\nSTART OK ${'1'.repeat(40)}\n`, '', 'UNKNOWN exit 0: TRIAL OK: schema 46 -> 47\n'],
    ['COMPAT OK with exit 1', 'trial', 1, `TRIAL OK: s\nCOMPAT OK ${S}\n`, '', 'UNKNOWN exit 1: TRIAL OK: s\n'],
    ['a FAILED line that is not the last', 'trial', 1, 'TRIAL FAILED: x\nlater\n', '', 'UNKNOWN exit 1: TRIAL FAILED: x\n'],
    ['ACTIVATE FAILED with a second line', 'activate', 1, 'ACTIVATE FAILED: x\ny\n', '', 'UNKNOWN exit 1: ACTIVATE FAILED: x\n'],
    ['an unknown unit', 'current', 0, 'CURRENT quadlet=none container-image=none container-digest=none unit=user\n', '',
      'UNKNOWN exit 0: CURRENT quadlet=none container-image=none container-digest=none unit=user\n'],
    ['NOT LOCAL with exit 0', 'local', 0, `NOT LOCAL ${D}\n`, '', `UNKNOWN exit 0: NOT LOCAL ${D}\n`],
    ['a prune', 'prune', 0, `PRUNED 2 skipped 0 kept ${D}\n`, '', `PRUNED 2 skipped 0 kept ${D}\n`],
    // F8: `timeout` exits 124 — could not verify, never a verdict.
    ['a timed-out activate', 'activate', 124, '', '', 'UNKNOWN exit 124: no output\n'],
    ['a timed-out trial after its first steps', 'trial', 124, 'TRIAL OK: schema 46 -> 47\n', '', 'UNKNOWN exit 124: TRIAL OK: schema 46 -> 47\n'],
  ])('%s', (_name, action, code, stdout, stderr, expected) => {
    expect(parse(action, code, stdout, stderr)).toBe(expected);
  });
});

describe('the harness host', () => {
  // The fakes are the ground the other tests stand on: this pins what they report for a fresh world.
  it('starts settled: the base image runs from the Quadlet file, healthy, on a known boot', () => {
    const w = imageWorld();
    const s = w.settled;
    const env = tickEnv(w);
    const run = (name: string, ...args: string[]) => execFileSync(join(w.bin, name), args, { encoding: 'utf8', env });
    expect([run('wbb-image', 'current'), run('health', '3000'), run('boot-id'), run('unit-state'), run('restarts')]).toEqual([
      `CURRENT quadlet=${s.digest} container-image=${s.id} container-digest=${s.digest} unit=quadlet\n`,
      `${w.base}\n`,
      `${BOOT_ID}\n`,
      'ActiveState=active\nSubState=running\nMainPID=4242\n',
      '0\n',
    ]);
    expect(events(w)).toEqual(['image current']);
  });
});

describe('PR #866 review: the installed-copies check fails closed (item 1)', () => {
  const ADVICE = 'Run: sudo bash deploy/install-autodeploy.sh (the deployer) and sudo bash deploy/install-image.sh (the image helper)';
  it.each([
    ['missing', (w: ImageWorld) => join(w.bin, 'no-such-check')],
    ['not executable', (w: ImageWorld) => { const p = join(w.bin, 'not-executable'); writeFileSync(p, '#!/bin/sh\nexit 0\n'); return p; }],
  ])('a check that is %s is "cannot verify": the deploy waits, once a day, naming the path', (_name, path) => {
    const w = imageWorld();
    noopCandidate(w);
    const over = { WBB_INSTALLED_CHECK: path(w) };
    ready(w, over);
    tick(w, over);
    tick(w, over);
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([
      '⚠️ merge-deploy is waiting: the installed deployer is out of date — a merged fix is not live until it is installed.\n'
      + `cannot verify the installed copies: the check ${path(w)} is missing or not executable\n${ADVICE}`,
    ]);
  });

  it('an EMPTY WBB_INSTALLED_CHECK is the seam that turns the check off', () => {
    const w = imageWorld();
    const { x, img } = noopCandidate(w);
    ready(w, { WBB_INSTALLED_CHECK: '' });
    tick(w, { WBB_INSTALLED_CHECK: '' });
    expect(events(w)).toEqual(noopEvents(x, img, [w.settled.digest]));
  });
});

describe('PR #866 review: the range scan has a deadline (item 3)', () => {
  it('PR labels not read for the whole range within 240 s: a hold, no call after the deadline', () => {
    const w = imageWorld();
    for (const n of [1, 2, 3]) push(w, { 'docs/x.md': `${n}\n` }, `docs ${n}`);
    noopCandidate(w);
    const calls = join(w.bin, 'labels.calls');
    // Each lookup takes 100 s of monotonic time.
    const slow = stub(w.bin, 'labels-slow', `echo "$1" >> "${calls}"; echo $(( $(cat "${w.uptime}") + 100 )) > "${w.uptime}"; printf '7\\t\\n'`);
    ready(w, { WBB_PR_LABELS_CMD: slow });
    expect(tick(w, { WBB_PR_LABELS_CMD: slow }).code).toBe(0);
    expect(readFileSync(calls, 'utf8').split('\n').filter((l) => l !== '').length).toBe(3);
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([
      `⏸ merge-deploy: production is behind main and HELD:\n• could not read the PR labels of the whole range within 240s\n${HOLD_TAIL}`,
    ]);
  });
});

describe('PR #866 review: the Telegram token never reaches argv (item 4)', () => {
  it('the real notifier gives curl the URL as a config on stdin', () => {
    const w = imageWorld();
    seedState(w, { DEPLOYED_SHA: w.base });
    const argv = join(w.bin, 'curl.argv');
    const stdin = join(w.bin, 'curl.stdin');
    stub(w.pathBin, 'curl', `printf '%s\\n' "$@" > "${argv}"; cat > "${stdin}"`);
    const readEnv = stub(w.bin, 'read-env-telegram',
      'case "$1" in TELEGRAM_BOT_TOKEN) echo 123456:SECRETTOKEN ;; ADMIN_TELEGRAM_ID) echo 42 ;; *) exit 1 ;; esac');
    expect(tick(w, { WBB_NOTIFY_CMD: '', WBB_READ_ENV_CMD: readEnv }).code).toBe(0);
    const message = '⛔ merge-deploy: there is no settled image yet — the first image release is deployed by hand (manual window, spec §8 п.2); '
      + 'until then nothing deploys automatically.';
    expect(readFileSync(argv, 'utf8')).toBe(
      ['-K', '-', '-fsS', '--max-time', '10', '-X', 'POST', '--data-urlencode', 'chat_id=42', '--data-urlencode', `text=${message}`, ''].join('\n'));
    expect(readFileSync(stdin, 'utf8')).toBe('url = "https://api.telegram.org/bot123456:SECRETTOKEN/sendMessage"\n');
  });
});

describe('PR #866 review: a malformed lock-busy-since does not abort the tick (item 6)', () => {
  it('garbage is replaced by now, and the stall notice still goes out later', async () => {
    const w = imageWorld();
    const busy = join(w.stateDir, 'lock-busy-since');
    writeFileSync(busy, '100000 junk\n');
    const holder = await holdTheLock(join(w.stateDir, 'lock'));
    try {
      expect(tick(w).code).toBe(0);
      expect(readFileSync(busy, 'utf8')).toBe('100000\n');
      advance(w, 7800);
      tick(w);
      expect(notes(w)).toEqual([
        `⚠️ merge-deploy: the deploy lock has been held for 130 min — no tick can run. A stuck manual deploy.sh? Check: fuser -v ${join(w.stateDir, 'lock')}`,
      ]);
    } finally {
      holder.kill();
    }
  });
});

/** Holds the tick's lock in another process; resolves once it is held. */
async function holdTheLock(lock: string): Promise<ChildProcess> {
  const holder = spawn('flock', ['-o', lock, 'sleep', '60'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i += 1) {
    if (spawnSync('flock', ['-n', lock, 'true']).status === 1) return holder;
    await new Promise((res) => setTimeout(res, 20));
  }
  holder.kill();
  throw new Error('the lock holder never acquired the lock');
}

describe('PR #866 review, round 2', () => {
  /** A pre snapshot as db-snapshot.sh leaves it, under the world's snapshot directory. */
  function pre(w: ImageWorld, name: string): string {
    const p = join(w.snapshots, name);
    mkdirSync(w.snapshots, { recursive: true });
    writeFileSync(p, 'pre\n');
    writeFileSync(`${p}.sha256`, `${'0'.repeat(64)}\n`);
    return p;
  }
  const rb = (p: string) => p.replace(/-pre\.db$/, '-rollback-pre.db');

  it('item 1 + 3: pending marks are retried element by element, at most two per tick', () => {
    const w = imageWorld();
    const [a, b, c] = ['19700101T000001Z-aaaaaa1-pre.db', '19700101T000002Z-aaaaaa2-pre.db', '19700101T000003Z-aaaaaa3-pre.db'].map((n) => pre(w, n));
    seedState(w, { ...settledState(w.settled), PENDING_MARK: `${a} ${b} ${c}` });
    expect(tick(w).code).toBe(0);
    expect(events(w)).toEqual(['mark 19700101T000001Z-aaaaaa1-pre.db', 'mark 19700101T000002Z-aaaaaa2-pre.db']);
    expect([readState(w).PENDING_MARK, readState(w).RETAINED_PRE]).toEqual([c, `${rb(a)} ${rb(b)}`]);
    tick(w);
    expect([readState(w).PENDING_MARK, readState(w).RETAINED_PRE]).toEqual([undefined, `${rb(a)} ${rb(b)} ${rb(c)}`]);
    expect([a, b, c].map((p) => existsSync(rb(p)))).toEqual([true, true, true]);
  });

  it('item 5: a busy record in the future is malformed — replaced by now', async () => {
    const w = imageWorld();
    const busy = join(w.stateDir, 'lock-busy-since');
    writeFileSync(busy, '200000\n');
    const holder = await holdTheLock(join(w.stateDir, 'lock'));
    try {
      expect(tick(w).code).toBe(0);
      expect(readFileSync(busy, 'utf8')).toBe('100000\n');
    } finally {
      holder.kill();
    }
  });

  it('item 6: the range-scan deadline is monotonic — a wall clock stepping back does not extend it', () => {
    const w = imageWorld();
    for (const n of [1, 2, 3]) push(w, { 'docs/x.md': `${n}\n` }, `docs ${n}`);
    noopCandidate(w);
    const calls = join(w.bin, 'labels.calls');
    // Each lookup: 100 s of uptime pass while the wall clock steps 100 s back.
    const slow = stub(w.bin, 'labels-stepping', [
      `echo "$1" >> "${calls}"`,
      `echo $(( $(cat "${w.uptime}") + 100 )) > "${w.uptime}"`,
      `echo $(( $(cat "${w.clock}") - 100 )) > "${w.clock}"`,
      `printf '7\\t\\n'`,
    ].join('\n'));
    ready(w, { WBB_PR_LABELS_CMD: slow });
    expect(tick(w, { WBB_PR_LABELS_CMD: slow }).code).toBe(0);
    expect([readFileSync(calls, 'utf8').split('\n').filter((l) => l !== '').length, events(w)]).toEqual([3, []]);
    expect(notes(w)).toEqual([
      `⏸ merge-deploy: production is behind main and HELD:\n• could not read the PR labels of the whole range within 240s\n${HOLD_TAIL}`,
    ]);
  });
});
