import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOT_ID, DAY1,
  events, fault, git, hostRead, hostSet, imageOf, imageWorld, notes, publish, push, readState, ready, reply, runImage,
  markThenKill, seedState, settledState, short, stub, tick, writes, type Image, type ImageWorld, type Reply,
} from './image-autodeploy-harness';

// A resumed window is polled to its end inside one tick (up to 61 polls).
vi.setConfig({ testTimeout: 60_000 });

/**
 * Recovery after an interrupted tick — Task 3 of
 * docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md: every row of spec §7.2 is its
 * own test, its state and its simulated host seeded as literals; the end-to-end kill tests prove that a real
 * interruption leaves exactly the state the seeded rows start from. Also the tails of Task 2's (і), (к), (д)
 * and (н), which need a resumed window.
 */

interface Rec { w: ImageWorld; x: string; img: Image; s: Image; preName: string; pre: string }

const OTHER_BOOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/**
 * main has X, its image pulled (it is local: the trial ran); the window was written at 100600 (the pre's
 * stamp) and this tick runs at 100900 — 300 s later.
 */
function recoveryWorld(): Rec {
  const w = imageWorld();
  const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
  const img = publish(w, imageOf(x));
  hostSet(w, `local/${img.digest}`, '');
  // The tick that wrote the window had fetched X as main's head (plan b2 п.19 reads it).
  git(w.repo, 'fetch', '-q', 'origin');
  const preName = `19700102T035640Z-${short(x)}-pre.db`;
  const pre = join(w.snapshots, preName);
  mkdirSync(w.snapshots, { recursive: true });
  writeFileSync(pre, 'pre\n');
  writeFileSync(`${pre}.sha256`, `${'0'.repeat(64)}\n`);
  writeFileSync(join(w.bin, 'clock'), '100900');
  hostSet(w, 'activated_at', '100600');
  return { w, x, img, s: w.settled, preName, pre };
}

/** The literal states a tick leaves in each phase (what Task 2 writes). */
const activating = (r: Rec): Record<string, string> => ({
  ...settledState(r.s), LAST_SEEN_DEPLOYED_SHA: r.s.sha, MAIN_SEEN_SHA: r.x, MAIN_SEEN_S: '100000',
  WINDOW_SHA: r.x, WINDOW_DIGEST: r.img.digest, WINDOW_ID: r.img.id, WINDOW_CONTENT: r.img.content, WINDOW_OLD: r.s.sha,
  WINDOW_PREV_DIGEST: r.s.digest, WINDOW_KIND: 'deploy', WINDOW_MODE: 'auto', WINDOW_PHASE: 'activating', WINDOW_PRE: r.pre, WINDOW_BOOT: BOOT_ID,
});
const watching = (r: Rec, extra: Record<string, string> = {}): Record<string, string> => ({
  // Plan b2 п.18: an activation records DEPLOYED_* but not LAST_SEEN (proven forward motion only).
  ...activating(r), DEPLOYED_SHA: r.x,
  DEPLOYED_DIGEST: r.img.digest, DEPLOYED_ID: r.img.id, DEPLOYED_CONTENT: r.img.content,
  WINDOW_PHASE: 'watching', WINDOW_START: '100600', WINDOW_LAST_READ: '100890', WINDOW_FAILS: '0', WINDOW_NRESTARTS: '0',
  ...extra,
});
const rollingBack = (r: Rec, extra: Record<string, string> = {}): Record<string, string> => ({
  ...watching(r), LAST_FAILED_SHA: r.x, WINDOW_PHASE: 'rolling-back',
  WINDOW_REASON: 'health check failed 3 times in a row (last at +290s)', ROLLBACK_ATTEMPTS: '0', ...extra,
});

const marked = (r: Rec) => r.pre.replace(/-pre\.db$/, '-rollback-pre.db');
const clock = (w: ImageWorld) => readFileSync(join(w.bin, 'clock'), 'utf8').trim();
const polls = (n: number) => Array<string>(n).fill('image current');
const settledEnd = (r: Rec) => [`image prune --keep ${r.img.digest}`, 'prune'];
/** X settled: the state every successful recovery ends in. */
const settledX = (r: Rec) => ({
  ...settledState(r.img), PREVIOUS_SHA: r.s.sha, LAST_SEEN_DEPLOYED_SHA: r.x, MAIN_SEEN_SHA: r.x, MAIN_SEEN_S: '100000',
});
/** Rolled back to S: what every completed code-only rollback ends in. */
const rolledBackTo = (r: Rec) => ({
  ...settledState(r.s), LAST_SEEN_DEPLOYED_SHA: r.s.sha, MAIN_SEEN_SHA: r.x, MAIN_SEEN_S: '100000',
  LAST_FAILED_SHA: r.x, RETAINED_PRE: marked(r),
});
/** An incident opened in a window that had activated D. */
const incidentState = (r: Rec, reason: string) => ({
  // Plan b2 п.18: neither the activation nor the incident observes a transition — LAST_SEEN stays at S.
  ...settledState(r.s), DEPLOYED_SHA: r.x, LAST_SEEN_DEPLOYED_SHA: r.s.sha,
  DEPLOYED_DIGEST: r.img.digest, DEPLOYED_ID: r.img.id, DEPLOYED_CONTENT: r.img.content,
  MAIN_SEEN_SHA: r.x, MAIN_SEEN_S: '100000', LAST_FAILED_SHA: r.x, RETAINED_PRE: marked(r), INCIDENT: `${r.x} ${r.img.digest} ${reason}`,
});
const incidentNote = (r: Rec, reason: string, manual = '') =>
  `🔥 merge-deploy INCIDENT: ${short(r.x)} (${r.img.digest}) — ${reason}. Nothing was rolled back automatically${manual}; the database is untouched.\n`
  + `Pre-deploy snapshot: ${marked(r)} (kept until a human removes it: rm ${marked(r)} ${marked(r)}.sha256)\n`
  + 'Nothing deploys until a human restores production and runs: bash deploy/deploy.sh --resolve-incident --settled <sha>';

describe('§7.2 row 1: activating, the Quadlet file names S, S runs', () => {
  it('cancels the window without blaming X and activating nothing; the next tick deploys X afresh', () => {
    const r = recoveryWorld();
    seedState(r.w, activating(r));
    const t = tick(r.w);
    expect(t.code).toBe(0);
    expect(events(r.w)).toEqual(['image current', `discard ${r.preName}`]);
    expect(readState(r.w)).toEqual({
      ...settledState(r.s), LAST_SEEN_DEPLOYED_SHA: r.s.sha, MAIN_SEEN_SHA: r.x, MAIN_SEEN_S: '100000', LAST_ASSESS_NOTICE: DAY1,
    });
    expect(notes(r.w)).toEqual([
      `⚠️ merge-deploy: the deploy of ${short(r.x)} was interrupted before its activation; production still runs the settled ${short(r.s.sha)}, `
      + `so the window is cancelled and ${short(r.x)} is tried again next tick.`,
    ]);
    expect(tick(r.w).code).toBe(0);
    expect(events(r.w).filter((e) => e.startsWith('image activate'))).toEqual([`image activate --digest ${r.img.digest}`]);
    expect(readState(r.w).SETTLED_SHA).toBe(r.x);
  });
});

describe('§7.2 row 2: activating, the Quadlet file names D, D does not run', () => {
  it.each([
    ['S runs', (_r: Rec) => { /* the seeded host: S runs */ }],
    ['nothing runs', (r: Rec) => { hostSet(r.w, 'container', null); hostSet(r.w, 'running_sha', null); }],
  ])('%s: one `activate D`, then a full window from now', (_name, host) => {
    const r = recoveryWorld();
    seedState(r.w, activating(r));
    hostSet(r.w, 'quadlet', r.img.digest);
    host(r);
    expect(tick(r.w).code).toBe(0);
    expect(events(r.w)).toEqual(['image current', `image activate --digest ${r.img.digest}`, ...polls(61), ...settledEnd(r)]);
    expect([readState(r.w), clock(r.w)]).toEqual([settledX(r), '101500']);
  });

  it('end to end: a tick killed after `activate D` wrote the Quadlet file is finished by the next one', () => {
    const w = imageWorld();
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
    const img = publish(w, imageOf(x));
    ready(w);
    reply(w, 'activate', img.digest, 'kill-after-write');
    expect(tick(w).code).toBe(null);
    const r: Rec = { w, x, img, s: w.settled, preName: `19700102T035640Z-${short(x)}-pre.db`, pre: join(w.snapshots, `19700102T035640Z-${short(x)}-pre.db`) };
    expect([readState(w), hostRead(w, 'quadlet'), hostRead(w, 'container')])
      .toEqual([{ ...activating(r), ACTIVATE_ATTEMPTS: '1' }, img.digest, w.settled.digest]);
    expect(tick(w).code).toBe(0);
    expect(events(w).filter((e) => e === `image activate --digest ${img.digest}`).length).toBe(2);
    expect(readState(w).SETTLED_SHA).toBe(x);
  });
});

describe('§7.2 row 3: activating, D already runs', () => {
  it('activates nothing: PHASE=watching, WINDOW_START=now, base 0 (no restart since the activation); still watching at +590 s', () => {
    const r = recoveryWorld();
    seedState(r.w, activating(r));
    runImage(r.w, r.img);
    hostSet(r.w, 'nrestarts', '0');
    hostSet(r.w, 'activated_at', '100900');
    fault(r.w, 'kill', 590, 600);
    expect(tick(r.w).code).toBe(null);
    expect(readState(r.w)).toEqual(watching(r, { WINDOW_START: '100900', WINDOW_LAST_READ: '101480', WINDOW_NRESTARTS: '0' }));
    expect(tick(r.w).code).toBe(0);
    expect(events(r.w).filter((e) => e.startsWith('image activate'))).toEqual([]);
    expect([readState(r.w), clock(r.w)]).toEqual([settledX(r), '101500']);
  });

  it('end to end: a tick killed after ACTIVATED D, before writing `watching`, is finished without a second restart', () => {
    const w = imageWorld();
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
    const img = publish(w, imageOf(x));
    ready(w);
    reply(w, 'activate', img.digest, 'kill-after');
    expect(tick(w).code).toBe(null);
    const r: Rec = { w, x, img, s: w.settled, preName: `19700102T035640Z-${short(x)}-pre.db`, pre: join(w.snapshots, `19700102T035640Z-${short(x)}-pre.db`) };
    expect([readState(w), hostRead(w, 'container')]).toEqual([{ ...activating(r), ACTIVATE_ATTEMPTS: '1' }, img.digest]);
    expect(tick(w).code).toBe(0);
    expect(events(w).filter((e) => e === `image activate --digest ${img.digest}`).length).toBe(1);
    expect(readState(w)).toEqual(settledX(r));
  });
});

describe('V14 on resume: row 3 — D runs, and NRestarts counts its own restarts since the activation', () => {
  it('D runs with NRestarts 2: the candidate restarted during startup — failed, rolled back', () => {
    const r = recoveryWorld();
    seedState(r.w, activating(r));
    runImage(r.w, r.img);
    hostSet(r.w, 'nrestarts', '2');
    expect(tick(r.w).code).toBe(2);
    expect(notes(r.w)[0]).toBe(`⚠️ merge-deploy ${short(r.x)} failed inside its window: the candidate restarted during startup (NRestarts 2 since its activation) — `
      + `rolling back to ${short(r.s.sha)} (code only; the database is not touched).`);
  });
});

describe('§7.2 row 4: watching, the same boot', () => {
  it('goes on from the recorded WINDOW_START and settles at +600 s', () => {
    const r = recoveryWorld();
    seedState(r.w, watching(r));
    runImage(r.w, r.img);
    expect(tick(r.w).code).toBe(0);
    expect(events(r.w)).toEqual(['image current', ...polls(31), ...settledEnd(r)]);
    expect([readState(r.w), clock(r.w)]).toEqual([settledX(r), '101200']);
  });

  it('NRestarts above the recorded base: the bot restarted while nobody watched — failed, rolled back', () => {
    const r = recoveryWorld();
    seedState(r.w, watching(r));
    runImage(r.w, r.img);
    hostSet(r.w, 'nrestarts', '1');
    expect(tick(r.w).code).toBe(2);
    expect(events(r.w)).toEqual(['image current', 'image current', `mark ${r.preName}`, 'image current',
      `image activate --digest ${r.s.digest}`, 'image current']);
    expect(readState(r.w)).toEqual(rolledBackTo(r));
    expect(notes(r.w)[0]).toBe(`⚠️ merge-deploy ${short(r.x)} failed inside its window: service restarted (NRestarts 0 -> 1) at +300s — `
      + `rolling back to ${short(r.s.sha)} (code only; the database is not touched).`);
  });

  it('(к) end to end: two failed polls, a kill, and the next tick\'s third failed poll fails the window', () => {
    const w = imageWorld();
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
    const img = publish(w, imageOf(x));
    ready(w);
    fault(w, 'health', 300, 99999, img.digest);
    fault(w, 'kill', 320, 321);
    expect(tick(w).code).toBe(null);
    expect(readState(w).WINDOW_FAILS).toBe('2');
    expect(tick(w).code).toBe(2);
    expect([readState(w).LAST_FAILED_SHA, notes(w)[0]]).toEqual([x,
      `⚠️ merge-deploy ${short(x)} failed inside its window: health check failed 3 times in a row (last at +320s) — `
      + `rolling back to ${short(w.settled.sha)} (code only; the database is not touched).`]);
  });

  it('(д) end to end: an unread poll at 600 s and a kill; the next tick\'s clean poll settles at once', () => {
    const w = imageWorld();
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
    const img = publish(w, imageOf(x));
    ready(w);
    fault(w, 'current', 600, 99999, img.digest);
    fault(w, 'kill', 610, 611);
    expect(tick(w).code).toBe(null);
    expect([readState(w).WINDOW_PHASE, readState(w).WINDOW_LAST_READ]).toEqual(['watching', '101190']);
    hostSet(w, `fault.current.${img.digest}`, null);
    const before = events(w).length;
    expect(tick(w).code).toBe(0);
    expect(events(w).slice(before)).toEqual(['image current', 'image current', `image prune --keep ${img.digest}`, 'prune']);
    expect([readState(w).SETTLED_SHA, clock(w)]).toEqual([x, '101210']);
  });
});

describe('§7.2 row 5: a reboot inside the window', () => {
  it('another boot id: no failure, a new NRestarts base, a full window from now', () => {
    const r = recoveryWorld();
    seedState(r.w, watching(r));
    runImage(r.w, r.img);
    hostSet(r.w, 'boot_id', OTHER_BOOT);
    hostSet(r.w, 'nrestarts', '1');
    expect(tick(r.w).code).toBe(0);
    expect(events(r.w)).toEqual(['image current', ...polls(61), ...settledEnd(r)]);
    expect([readState(r.w), clock(r.w)]).toEqual([settledX(r), '101500']);
    expect(notes(r.w)).toEqual([
      `⚠️ merge-deploy ${short(r.x)}: the window lost its evidence (a reboot: the boot id changed) — watching a full 600s window again from now.`,
      `✅ merge-deploy ${short(r.x)} is live and settled.`,
    ]);
  });
});

describe('§7.2 row 6: a failure after resume, auto', () => {
  it('rolls back code only, exit 2', () => {
    const r = recoveryWorld();
    seedState(r.w, watching(r));
    runImage(r.w, r.img);
    fault(r.w, 'health-sha', 0, 99999, r.img.digest);
    expect(tick(r.w).code).toBe(2);
    expect(readState(r.w)).toEqual(rolledBackTo(r));
    expect(notes(r.w)[0]).toBe(`⚠️ merge-deploy ${short(r.x)} failed inside its window: /health answers releaseSha fffffff, not ${short(r.x)}, at +300s — `
      + `rolling back to ${short(r.s.sha)} (code only; the database is not touched).`);
  });
});

describe('§7.2 row 7: interrupted during the rollback', () => {
  it.each([
    ['the Quadlet file names S, nothing runs', (r: Rec) => { hostSet(r.w, 'quadlet', r.s.digest); hostSet(r.w, 'container', null); hostSet(r.w, 'running_sha', null); }],
    ['D still runs', (r: Rec) => runImage(r.w, r.img)],
  ])('%s: `activate S` and the check, exit 2, LAST_FAILED_SHA stays X', (_name, host) => {
    const r = recoveryWorld();
    seedState(r.w, rollingBack(r));
    host(r);
    expect(tick(r.w).code).toBe(2);
    expect(events(r.w)).toEqual(['image current', `mark ${r.preName}`, 'image current', `image activate --digest ${r.s.digest}`, 'image current']);
    expect(readState(r.w)).toEqual(rolledBackTo(r));
  });

  it('end to end: a tick killed after `activate S` wrote the Quadlet file — the next one activates S again', () => {
    const w = imageWorld();
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
    const img = publish(w, imageOf(x));
    ready(w);
    fault(w, 'health', 300, 99999, img.digest);
    reply(w, 'activate', w.settled.digest, 'kill-after-write');
    expect(tick(w).code).toBe(null);
    expect([readState(w).WINDOW_PHASE, readState(w).ROLLBACK_ATTEMPTS, hostRead(w, 'quadlet'), hostRead(w, 'container')])
      .toEqual(['rolling-back', '1', w.settled.digest, img.digest]);
    expect(tick(w).code).toBe(2);
    expect(events(w).filter((e) => e === `image activate --digest ${w.settled.digest}`).length).toBe(2);
    expect([readState(w).LAST_FAILED_SHA, readState(w).DEPLOYED_DIGEST]).toEqual([x, w.settled.digest]);
  });

  it('end to end: a tick killed after S started, before the final write — finished with no further restart', () => {
    const w = imageWorld();
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
    const img = publish(w, imageOf(x));
    ready(w);
    fault(w, 'health', 300, 99999, img.digest);
    reply(w, 'activate', w.settled.digest, 'kill-after');
    expect(tick(w).code).toBe(null);
    const r: Rec = { w, x, img, s: w.settled, preName: `19700102T035640Z-${short(x)}-pre.db`, pre: join(w.snapshots, `19700102T035640Z-${short(x)}-pre.db`) };
    expect(readState(w)).toEqual(rollingBack(r, {
      WINDOW_PRE: marked(r), RETAINED_PRE: marked(r), ROLLBACK_ATTEMPTS: '1', ACTIVATE_ATTEMPTS: '1', WINDOW_FAILS: '3', WINDOW_LAST_READ: '100920',
      WINDOW_REASON: 'health check failed 3 times in a row (last at +320s)',
    }));
    expect(tick(w).code).toBe(2);
    expect(events(w).filter((e) => e === `image activate --digest ${w.settled.digest}`).length).toBe(1);
    expect(readState(w)).toEqual(rolledBackTo(r));
  });
});

describe('§7.2 row 8: the rollback did not bring S up', () => {
  it('(н) ROLLBACK_ATTEMPTS=2 already: S gets its start-up time, then INCIDENT without a third `activate S`; then nothing runs', () => {
    const r = recoveryWorld();
    seedState(r.w, rollingBack(r, { ROLLBACK_ATTEMPTS: '2' }));
    runImage(r.w, r.img);
    expect(tick(r.w).code).toBe(3);
    // The wait for S (0..120 s, 13 reads), then the fact before the would-be third attempt.
    expect(events(r.w)).toEqual(['image current', `mark ${r.preName}`, ...polls(13), 'image current']);
    const reason = `the rollback to ${short(r.s.sha)} did not bring it up after 2 attempts (health check failed 3 times in a row (last at +290s))`;
    expect(readState(r.w)).toEqual(incidentState(r, reason));
    expect(notes(r.w)).toEqual([incidentNote(r, reason)]);
    expect(tick(r.w).code).toBe(0);
    expect(events(r.w).length).toBe(16);
  });

  it('one attempt left and S cannot start: one `activate S`, then INCIDENT', () => {
    const r = recoveryWorld();
    seedState(r.w, rollingBack(r, { ROLLBACK_ATTEMPTS: '1' }));
    runImage(r.w, r.img);
    hostSet(r.w, `sick/${r.s.digest}`, '');
    expect(tick(r.w).code).toBe(3);
    expect(events(r.w)).toEqual(['image current', `mark ${r.preName}`, ...polls(13), 'image current',
      `image activate --digest ${r.s.digest}`, 'image current']);
    expect(readState(r.w).INCIDENT).toBe(`${r.x} ${r.img.digest} the rollback to ${short(r.s.sha)} did not bring it up after 2 attempts (health check failed 3 times in a row (last at +290s))`);
  });

  it('end to end: killed after the second `activate S` — the next tick opens the incident, no third', () => {
    const w = imageWorld();
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
    const img = publish(w, imageOf(x));
    ready(w);
    fault(w, 'health', 300, 99999, img.digest);
    fault(w, 'health', 0, 99999, w.settled.digest);
    reply(w, 'activate', w.settled.digest, 'pass', 'kill-after');
    expect(tick(w).code).toBe(null);
    expect([readState(w).WINDOW_PHASE, readState(w).ROLLBACK_ATTEMPTS, readState(w).INCIDENT]).toEqual(['rolling-back', '2', undefined]);
    expect(tick(w).code).toBe(3);
    expect(events(w).filter((e) => e === `image activate --digest ${w.settled.digest}`).length).toBe(2);
    expect(readState(w).INCIDENT).toBe(`${x} ${img.digest} the rollback to ${short(w.settled.sha)} did not bring it up after 2 attempts (health check failed 3 times in a row (last at +320s))`);
  });

  it('end to end: killed after the incident is written, before it is told — the next tick only reminds', () => {
    const w = imageWorld();
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
    const img = publish(w, imageOf(x));
    ready(w);
    fault(w, 'health', 300, 99999, img.digest);
    fault(w, 'health', 0, 99999, w.settled.digest);
    const notify = stub(w.bin, 'notify-dies-on-incident', [
      `printf '%s\\n<<END>>\\n' "$1" >> "${join(w.bin, 'notify.log')}"`,
      'case "$1" in "🔥 merge-deploy INCIDENT"*) . "$WBB_FAKE_LIB"; kill_tick ;; esac',
    ].join('\n'));
    expect(tick(w, { WBB_NOTIFY_CMD: notify }).code).toBe(null);
    const reason = `the rollback to ${short(w.settled.sha)} did not bring it up after 2 attempts (health check failed 3 times in a row (last at +320s))`;
    const st = readState(w);
    expect([st.INCIDENT, st.WINDOW_PHASE, st.LAST_FAILED_SHA]).toEqual([`${x} ${img.digest} ${reason}`, undefined, x]);
    const before = events(w).length;
    expect(tick(w).code).toBe(0);
    expect(events(w).length).toBe(before);
    expect(notes(w)[notes(w).length - 1].split('\n')[0]).toBe(`🔥 merge-deploy: an INCIDENT is open — ${short(x)} (${img.digest}): ${reason}`);
  });

  it('an INCIDENT written while the window is still in the state blocks before resume', () => {
    const r = recoveryWorld();
    seedState(r.w, rollingBack(r, { INCIDENT: `${r.x} ${r.img.digest} rollback failed` }));
    expect(tick(r.w).code).toBe(0);
    expect(events(r.w)).toEqual([]);
  });
});

describe('§7.2 row 9: a manual window after a reboot fails — (і)', () => {
  const reason = 'the manual window failed: not healthy within 120s';
  function failingManual(): Rec {
    const r = recoveryWorld();
    seedState(r.w, watching(r, { WINDOW_MODE: 'manual' }));
    runImage(r.w, r.img);
    hostSet(r.w, 'boot_id', OTHER_BOOT);
    fault(r.w, 'health', 0, 99999, r.img.digest);
    return r;
  }

  it('no rollback: the incident is written first with the window, then the pre is marked and kept; exit 3', () => {
    const r = failingManual();
    expect(tick(r.w).code).toBe(3);
    expect(events(r.w)).toEqual(['image current', ...polls(13), `mark ${r.preName}`]);
    expect(readState(r.w)).toEqual(incidentState(r, reason));
    // F1: the first write that names X failed opens the incident, with the window still in it (the pre not
    // yet marked); the next one keeps the marked pre and clears the window.
    const all = writes(r.w);
    const first = all.findIndex((st) => st.LAST_FAILED_SHA !== undefined);
    expect(all.slice(first)).toEqual([
      { ...watching(r, { WINDOW_MODE: 'manual', WINDOW_START: '100900', WINDOW_LAST_READ: '101020', WINDOW_BOOT: OTHER_BOOT }),
        LAST_FAILED_SHA: r.x, INCIDENT: `${r.x} ${r.img.digest} ${reason}` },
      incidentState(r, reason),
    ]);
    expect(notes(r.w)[1]).toBe(incidentNote(r, reason, ' (a manual window)'));
  });

  it('F1: killed between the mark and the second write — the incident blocks; the window never settles', () => {
    const r = failingManual();
    expect(tick(r.w, { WBB_MARK_CMD: markThenKill(r.w) }).code).toBe(null);
    expect([readState(r.w).INCIDENT, readState(r.w).WINDOW_PHASE]).toEqual([`${r.x} ${r.img.digest} ${reason}`, 'watching']);
    // The bot recovers; a resumed window would now settle it.
    hostSet(r.w, `fault.health.${r.img.digest}`, null);
    const before = events(r.w).length;
    expect(tick(r.w).code).toBe(0);
    expect([events(r.w).length, readState(r.w).SETTLED_SHA]).toEqual([before, r.s.sha]);
  });
});

describe('§7.2 row 10: the unit is not our Quadlet', () => {
  // F3: not X's fault — no LAST_FAILED_SHA is added (a rolling-back window already carries its own).
  it.each([
    ['activating', activating, (_r: Rec) => undefined],
    ['watching', watching, (_r: Rec) => undefined],
    ['rolling-back', rollingBack, (r: Rec) => r.x],
  ])('%s: no activate, no prune, INCIDENT, exit 3', (phase, state, failed) => {
    const r = recoveryWorld();
    seedState(r.w, state(r));
    hostSet(r.w, 'unit', 'foreign');
    expect(tick(r.w).code).toBe(3);
    expect(events(r.w)).toEqual(['image current', `mark ${r.preName}`]);
    expect([readState(r.w).INCIDENT, readState(r.w).LAST_FAILED_SHA])
      .toEqual([`${r.x} ${r.img.digest} the unit is not our Quadlet (unit=foreign) in the ${phase} window`, failed(r)]);
  });

  it('F3: a Quadlet file naming neither image is an incident without blame', () => {
    const r = recoveryWorld();
    seedState(r.w, activating(r));
    hostSet(r.w, 'quadlet', `sha256:${'7'.repeat(64)}`);
    expect(tick(r.w).code).toBe(3);
    expect([readState(r.w).INCIDENT, readState(r.w).LAST_FAILED_SHA]).toEqual([
      `${r.x} ${r.img.digest} the Quadlet file names sha256:${'7'.repeat(64)}, neither ${short(r.x)} nor the settled image, in an activating window`,
      undefined,
    ]);
  });
});

describe('F2: a gap nobody watched is lost evidence', () => {
  it('a watching window found OBSERVE_MAX_S or more after its last read starts afresh: ⚠️, a full window, no failure', () => {
    const r = recoveryWorld();
    seedState(r.w, watching(r));
    runImage(r.w, r.img);
    writeFileSync(join(r.w.bin, 'clock'), '101300');
    expect(tick(r.w).code).toBe(0);
    expect(events(r.w)).toEqual(['image current', ...polls(61), ...settledEnd(r)]);
    expect([readState(r.w), clock(r.w)]).toEqual([settledX(r), '101900']);
    expect(notes(r.w)[0]).toBe(
      `⚠️ merge-deploy ${short(r.x)}: the window lost its evidence (nobody watched for 410s) — watching a full 600s window again from now.`);
  });

  it('a gap just under it goes on from the recorded start', () => {
    const r = recoveryWorld();
    seedState(r.w, watching(r));
    runImage(r.w, r.img);
    writeFileSync(join(r.w.bin, 'clock'), '101189');
    expect(tick(r.w).code).toBe(0);
    expect([readState(r.w), clock(r.w), notes(r.w)]).toEqual([settledX(r), '101209', [`✅ merge-deploy ${short(r.x)} is live and settled.`]]);
  });
});

describe('F5 and F6: an activation that does not complete', () => {
  const t75: Reply = { code: 75, stderr: 'TEMPFAIL: systemctl restart timed out after 180s\n' };

  it('each `activate D` is counted before it runs; after three, an incident without blame — what runs is named', () => {
    const r = recoveryWorld();
    seedState(r.w, { ...activating(r), ACTIVATE_ATTEMPTS: '1' });
    hostSet(r.w, 'quadlet', r.img.digest);
    reply(r.w, 'activate', r.img.digest, t75, t75);
    expect(tick(r.w).code).toBe(0);
    expect(tick(r.w).code).toBe(0);
    expect([readState(r.w).ACTIVATE_ATTEMPTS, readState(r.w).WINDOW_PHASE, notes(r.w).length]).toEqual(['3', 'activating', 1]);
    expect(tick(r.w).code).toBe(3);
    expect(events(r.w).filter((e) => e.startsWith('image activate')).length).toBe(2);
    expect([readState(r.w).INCIDENT, readState(r.w).LAST_FAILED_SHA, readState(r.w).ACTIVATE_ATTEMPTS]).toEqual([
      `${r.x} ${r.img.digest} the activation of ${short(r.x)} did not complete after 3 attempts; production: quadlet=${r.img.digest} container-digest=${r.s.digest} unit=quadlet`,
      undefined, undefined,
    ]);
  });

  it('REFUSED while the Quadlet file names D: the window stays activating, the pre is kept', () => {
    const r = recoveryWorld();
    seedState(r.w, activating(r));
    hostSet(r.w, 'quadlet', r.img.digest);
    reply(r.w, 'activate', r.img.digest, { code: 2, stderr: 'REFUSED: daemon-reload left a foreign unit; the previous Quadlet file is restored\n' });
    expect(tick(r.w).code).toBe(0);
    expect(events(r.w)).toEqual(['image current', `image activate --digest ${r.img.digest}`, 'image current']);
    expect(readState(r.w)).toEqual({ ...activating(r), ACTIVATE_ATTEMPTS: '1', LAST_ASSESS_NOTICE: DAY1 });
    expect(notes(r.w)).toEqual([
      `⚠️ merge-deploy: the activation of ${short(r.x)} was refused (daemon-reload left a foreign unit; the previous Quadlet file is restored), `
      + 'but the Quadlet file already names it; the window stays activating and the next tick activates again.',
    ]);
  });
});

describe('resume never guesses', () => {
  it('an unknown WINDOW_PHASE is STATE CORRUPT, not a resume', () => {
    const r = recoveryWorld();
    seedState(r.w, { ...activating(r), WINDOW_PHASE: 'settling' });
    expect(tick(r.w).code).toBe(3);
    expect(events(r.w)).toEqual([]);
  });

  it('a window whose `current` cannot be read waits, changing nothing', () => {
    const r = recoveryWorld();
    seedState(r.w, watching(r));
    const tempfail: Reply = { code: 75, stderr: 'TEMPFAIL: podman inspect timed out after 60s\n' };
    reply(r.w, 'current', '-', tempfail);
    expect(tick(r.w).code).toBe(0);
    expect([events(r.w), readState(r.w)]).toEqual([['image current'], { ...watching(r), LAST_ASSESS_NOTICE: DAY1 }]);
  });
});
