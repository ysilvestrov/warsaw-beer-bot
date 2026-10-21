import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOT_ID, SCRIPT,
  advance, events, fault, golden, hostRead, hostSet, imageOf, imageWorld, notes, patchState, publish, push, readState, ready, reply,
  DB_SNAPSHOT, markThenKill, seedState, settledState, short, stateAtActivate, stub, tick, type Image, type ImageWorld, type Reply,
} from './image-autodeploy-harness';

// A deploy tick polls a whole simulated 10-minute window (61 polls, ~6 processes each).
vi.setConfig({ testTimeout: 60_000 });

/**
 * The image controller's path to production — Task 2 of
 * docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md: audit, the settled image S
 * local, the pre snapshot, trial, the window in the state before production changes, activate, the
 * watched window, settled, the code-only rollback, the incident, retention and the tick's budget.
 * Bullets (а)–(п) of the task are the describe blocks below. (і) — a failed `manual` window — needs a
 * window the controller resumes (only the manual entry of the next stage opens one), so it is tested
 * with resume_window in Task 3.
 */

/** The candidate's digest is the golden outputs' D, so the real helper's lines name it. */
const GD = `sha256:${'d'.repeat(64)}`;

interface Deploy { w: ImageWorld; x: string; img: Image; s: Image; pre: string }

/**
 * main has X (a change that runs) with its image published; X has been quiet for ten minutes, so
 * the next tick deploys. The tick starts at 100600 (1970-01-02T03:56:40Z): the pre snapshot's stamp.
 */
function deployWorld(opts: { goldenDigest?: boolean; files?: Record<string, string> } = {}): Deploy {
  const w = imageWorld();
  const x = push(w, opts.files ?? { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
  const img = publish(w, opts.goldenDigest === true ? { ...imageOf(x), digest: GD } : imageOf(x));
  ready(w);
  return { w, x, img, s: w.settled, pre: `19700102T035640Z-${short(x)}-pre.db` };
}

/** The calls of a deploy tick up to and including `activate D`. */
const toActivate = ({ x, img, s, pre }: Deploy) => [
  `checks ${x}`, `resolve ${x}`, `attest ${img.digest} ${x}`, `image pull --sha ${x} --digest ${img.digest}`, 'image current',
  `image audit --digest ${img.digest}`, `image local --digest ${s.digest}`, `snapshot ${pre}`,
  `image trial --digest ${img.digest} --previous ${s.digest} --snapshot ${pre}`, `image activate --digest ${img.digest}`,
];
const polls = (n: number) => Array<string>(n).fill('image current');
/** After a failed window: pre marked, then the fact checked before the one `activate S`, then S seen up. */
const rollbackEvents = ({ s, pre }: Deploy, factChecks = 1) =>
  ['mark ' + pre, ...polls(factChecks), `image activate --digest ${s.digest}`, 'image current'];

const marked = (d: Deploy) => join(d.w.snapshots, d.pre.replace(/-pre\.db$/, '-rollback-pre.db'));
const clock = (w: ImageWorld) => readFileSync(join(w.bin, 'clock'), 'utf8').trim();

/** The state of a settled production at `img` after `x` was first seen at 100000. */
const settledAt = (img: Image, x: string, extra: Record<string, string> = {}) => ({
  ...settledState(img), LAST_SEEN_DEPLOYED_SHA: img.sha, MAIN_SEEN_SHA: x, MAIN_SEEN_S: '100000', ...extra,
});

const failedNote = (d: Deploy, reason: string) =>
  `⚠️ merge-deploy ${short(d.x)} failed inside its window: ${reason} — rolling back to ${short(d.s.sha)} (code only; the database is not touched).`;
const rolledBackNote = (d: Deploy, reason: string) =>
  `🔥 merge-deploy ROLLED BACK ${short(d.x)} → ${short(d.s.sha)} (code only, DB untouched): ${reason}.\n`
  + `Whatever ${short(d.x)} migrated or wrote is still in the database.\n`
  + `Pre-deploy snapshot: ${marked(d)} (kept until a human removes it: rm ${marked(d)} ${marked(d)}.sha256)`;

/** A failed window rolled back by one `activate S`: the facts every rollback test shares. */
function expectRolledBack(d: Deploy, code: number | null, reason: string, pollsBefore: number, factChecks = 1): void {
  expect(code).toBe(2);
  expect(events(d.w)).toEqual([...toActivate(d), ...polls(pollsBefore), ...rollbackEvents(d, factChecks)]);
  expect(readState(d.w)).toEqual(settledAt(d.s, d.x, { LAST_FAILED_SHA: d.x, RETAINED_PRE: marked(d) }));
  expect(notes(d.w)).toEqual([failedNote(d, reason), rolledBackNote(d, reason)]);
  expect(hostRead(d.w, 'quadlet')).toBe(d.s.digest);
}

describe('(а) the happy path', () => {
  it('audits, checks S locally, trials, activates, watches 600 s and settles', () => {
    const d = deployWorld();
    const r = tick(d.w);
    expect(r.code).toBe(0);
    expect(events(d.w)).toEqual([...toActivate(d), ...polls(61), `image prune --keep ${d.img.digest}`, 'prune']);
    expect(readState(d.w)).toEqual({ ...settledAt(d.img, d.x), PREVIOUS_SHA: d.w.base });
    expect(notes(d.w)).toEqual([`✅ merge-deploy ${short(d.x)} is live and settled — #7.`]);
    expect([hostRead(d.w, 'quadlet'), hostRead(d.w, 'container'), clock(d.w)]).toEqual([d.img.digest, d.img.digest, '101200']);
    expect(readdirSync(d.w.snapshots).sort()).toEqual([d.pre, `${d.pre}.sha256`]);
  });

  it('is up to date, silently, on the next tick', () => {
    const d = deployWorld();
    tick(d.w);
    const before = events(d.w).length;
    const r = tick(d.w);
    expect([r.code, events(d.w).length, notes(d.w).length]).toEqual([0, before, 1]);
  });
});

describe('(б) the window is in the state before production changes', () => {
  const windowState = (d: Deploy) => settledAt(d.s, d.x, {
    WINDOW_SHA: d.x, WINDOW_DIGEST: d.img.digest, WINDOW_ID: d.img.id, WINDOW_CONTENT: d.img.content,
    WINDOW_OLD: d.w.base, WINDOW_PREV_DIGEST: d.s.digest, WINDOW_MODE: 'auto', WINDOW_PHASE: 'activating',
    WINDOW_PRE: join(d.w.snapshots, d.pre), WINDOW_BOOT: BOOT_ID, ACTIVATE_ATTEMPTS: '1',
  });

  it('a tick killed before `activate D` leaves exactly the window, PHASE=activating, and S in the Quadlet', () => {
    const d = deployWorld();
    reply(d.w, 'activate', d.img.digest, 'kill-before');
    const r = tick(d.w);
    expect(r.code).toBe(null);
    expect(readState(d.w)).toEqual(windowState(d));
    expect([hostRead(d.w, 'quadlet'), events(d.w), notes(d.w)]).toEqual([d.s.digest, toActivate(d), []]);
  });

  it('`activate D` finds the window already written', () => {
    const d = deployWorld();
    tick(d.w);
    expect(stateAtActivate(d.w, 1)).toEqual(windowState(d));
  });
});

describe('(в) the helper\'s verdicts, row by row (plan п.9)', () => {
  /** What a row fixes: the exit code, the failed SHA, the hold, the discarded pre, the activations, the first note line. */
  interface Outcome { code: number; failed?: string; held?: string; discards: string[]; activateD: number; activateS: number; note: string }
  const S_GOLDEN = `sha256:${'5'.repeat(64)}`;
  const t75: Reply = { code: 75, stderr: 'TEMPFAIL: systemctl restart timed out after 180s\n' };
  const ROWS: Array<[string, string, () => Reply[], (d: Deploy) => Outcome]> = [
    ['audit AUDIT ADVISORY (golden) refuses X', 'audit', () => [golden('audit-advisory')], (d) => ({
      code: 1, failed: d.x, discards: [], activateD: 0, activateS: 0,
      note: `⛔ merge-deploy refused ${short(d.x)}: npm audit --omit=dev in its image reports a high or critical advisory.` })],
    ['audit TEMPFAIL is "could not verify"', 'audit', () => [{ code: 75, stderr: 'TEMPFAIL: podman run timed out after 300s\n' }], (d) => ({
      code: 0, discards: [], activateD: 0, activateS: 0,
      note: `⚠️ merge-deploy: the audit of ${short(d.x)} (${GD}) could not run: TEMPFAIL podman run timed out after 300s — NOT a finding; retrying next tick.` })],
    ['audit exit 1 with no line is "could not verify"', 'audit', () => [{ code: 1 }], (d) => ({
      code: 0, discards: [], activateD: 0, activateS: 0,
      note: `⚠️ merge-deploy: the audit of ${short(d.x)} (${GD}) could not run: UNKNOWN exit 1: no output — NOT a finding; retrying next tick.` })],
    ['trial TRIAL FAILED (golden) refuses X', 'trial', () => [golden('trial-trial-failed')], (d) => ({
      code: 1, failed: d.x, discards: [`discard ${d.pre}`], activateD: 0, activateS: 0,
      note: `⛔ merge-deploy refused ${short(d.x)}: the trial on a copy of production failed: TRIAL FAILED: no such column: venue_id` })],
    ['trial START FAILED (golden) refuses X', 'trial', () => [golden('trial-start-failed')], (d) => ({
      code: 1, failed: d.x, discards: [`discard ${d.pre}`], activateD: 0, activateS: 0,
      note: `⛔ merge-deploy refused ${short(d.x)}: the trial on a copy of production failed: START FAILED: /health answered {"ok":false}` })],
    ['trial COMPAT FAILED (golden) holds X, no failed SHA', 'trial', () => [golden('trial-compat-failed')], (d) => ({
      code: 0, held: `${d.x} ${GD} ${d.s.digest}`, discards: [`discard ${d.pre}`], activateD: 0, activateS: 0,
      note: `⏸ merge-deploy: ${short(d.x)} is HELD — the settled ${short(d.s.sha)} does not start on the database ${short(d.x)} migrated, `
        + 'so a code-only rollback is not possible: COMPAT FAILED: START FAILED: bot exited (code 1) before "api listening"' })],
    ['trial COMPAT FAILED: START TIMEOUT (golden) holds X', 'trial', () => [golden('trial-compat-failed-start-timeout')], (d) => ({
      code: 0, held: `${d.x} ${GD} ${d.s.digest}`, discards: [`discard ${d.pre}`], activateD: 0, activateS: 0,
      note: `⏸ merge-deploy: ${short(d.x)} is HELD — the settled ${short(d.s.sha)} does not start on the database ${short(d.x)} migrated, `
        + 'so a code-only rollback is not possible: COMPAT FAILED: START TIMEOUT: no "api listening" within 90s' })],
    ['trial REFUSED (golden) waits, no hold, no failed SHA', 'trial', () => [golden('trial-refused')], (d) => ({
      code: 0, discards: [`discard ${d.pre}`], activateD: 0, activateS: 0,
      note: `⏸ merge-deploy: the trial of ${short(d.x)} was refused: previous image ${S_GOLDEN} predates start-check --leave-running` })],
    ['trial TEMPFAIL (golden) is "could not verify"', 'trial', () => [golden('trial-tempfail')], (d) => ({
      code: 0, discards: [`discard ${d.pre}`], activateD: 0, activateS: 0,
      note: `⚠️ merge-deploy: the trial of ${short(d.x)} could not judge it: TEMPFAIL start-check in ${GD} exited 75: `
        + 'START KILLED: bot killed by SIGKILL (out of memory?) — NOT a finding; retrying next tick.' })],
    ['trial exit 70 is "could not verify"', 'trial', () => [{ code: 70, stderr: 'Traceback (most recent call last):\n' }], (d) => ({
      code: 0, discards: [`discard ${d.pre}`], activateD: 0, activateS: 0,
      note: `⚠️ merge-deploy: the trial of ${short(d.x)} could not judge it: UNKNOWN exit 70: Traceback (most recent call last): — NOT a finding; retrying next tick.` })],
    ['activate TEMPFAIL leaves the window activating', 'activate', () => [t75], (d) => ({
      code: 0, discards: [], activateD: 1, activateS: 0,
      note: `⚠️ merge-deploy: the activation of ${short(d.x)} (${GD}) could not be confirmed: TEMPFAIL systemctl restart timed out after 180s. `
        + 'The next tick looks at what runs and finishes or cancels it.' })],
    ['activate REFUSED with our unit cancels the window', 'activate', () => [{ code: 2, stderr: 'REFUSED: the Quadlet file changed under us\n' }], (d) => ({
      code: 0, discards: [`discard ${d.pre}`], activateD: 1, activateS: 0,
      note: `⚠️ merge-deploy: the activation of ${short(d.x)} was refused and changed nothing: the Quadlet file changed under us — retrying next tick.` })],
  ];

  it.each(ROWS)('%s', (_name, action, answer, outcome) => {
    const d = deployWorld({ goldenDigest: true });
    reply(d.w, action, GD, ...answer());
    const r = tick(d.w);
    const st = readState(d.w);
    expect({
      code: r.code,
      failed: st.LAST_FAILED_SHA,
      held: st.CANDIDATE_HELD,
      discards: events(d.w).filter((e) => e.startsWith('discard ')),
      activateD: events(d.w).filter((e) => e === `image activate --digest ${GD}`).length,
      activateS: events(d.w).filter((e) => e === `image activate --digest ${d.s.digest}`).length,
      note: notes(d.w)[0].split('\n')[0],
    }).toEqual(outcome(d));
  });

  // The real host after a failed restart: the Quadlet file names D and no container runs (the fake's
  // `activate` of a sick digest), so S is activated again.
  it('activate ACTIVATE FAILED fails the window and activates S again', () => {
    const d = deployWorld({ goldenDigest: true });
    hostSet(d.w, `sick/${GD}`, '');
    const r = tick(d.w);
    expect({
      code: r.code,
      failed: readState(d.w).LAST_FAILED_SHA,
      activations: events(d.w).filter((e) => e.startsWith('image activate')),
      note: notes(d.w)[0],
    }).toEqual({
      code: 2, failed: d.x, activations: [`image activate --digest ${GD}`, `image activate --digest ${d.s.digest}`],
      note: failedNote(d, 'the activation failed: ACTIVATE FAILED: restart exited 1: Job for warsaw-beer-bot.service failed because the control process exited with error code.'),
    });
  });

  it('activate TEMPFAIL keeps PHASE=activating and production unrecorded', () => {
    const d = deployWorld({ goldenDigest: true });
    reply(d.w, 'activate', GD, t75);
    tick(d.w);
    expect([readState(d.w).WINDOW_PHASE, readState(d.w).DEPLOYED_SHA, readState(d.w).DEPLOYED_DIGEST]).toEqual(['activating', d.w.base, d.s.digest]);
  });

  it('activate REFUSED with a foreign unit is an incident (exit 3)', () => {
    const d = deployWorld({ goldenDigest: true });
    reply(d.w, 'activate', GD, { code: 2, stderr: 'REFUSED: warsaw-beer-bot.service is not generated from our Quadlet file\n' });
    reply(d.w, 'current', '-', 'pass', { code: 0, stdout: `CURRENT quadlet=${d.s.digest} container-image=${d.s.id} container-digest=${d.s.digest} unit=foreign\n` });
    const r = tick(d.w);
    const pre = join(d.w.snapshots, d.pre.replace(/-pre\.db$/, '-rollback-pre.db'));
    expect(r.code).toBe(3);
    expect(readState(d.w)).toEqual(settledAt(d.s, d.x, {
      RETAINED_PRE: pre, INCIDENT: `${d.x} ${GD} the unit is not our Quadlet (unit=foreign); the activation was refused`,
    }));
    expect(notes(d.w)).toEqual([
      `🔥 merge-deploy INCIDENT: ${short(d.x)} (${GD}) — the unit is not our Quadlet (unit=foreign); the activation was refused. `
      + 'Nothing was rolled back automatically; the database is untouched.\n'
      + `Pre-deploy snapshot: ${pre} (kept until a human removes it: rm ${pre} ${pre}.sha256)\n`
      + 'Nothing deploys until a human restores production and runs: bash deploy/deploy.sh --resolve-incident --settled <sha>',
    ]);
  });
});

describe('(г) a held candidate and a retried one', () => {
  it('COMPAT FAILED holds X quietly; a new head clears the hold', () => {
    const d = deployWorld({ goldenDigest: true });
    reply(d.w, 'trial', GD, golden('trial-compat-failed'));
    tick(d.w);
    const after = events(d.w).length;
    expect(tick(d.w).code).toBe(0);
    expect([events(d.w).slice(after), notes(d.w).length]).toEqual([[`checks ${d.x}`, `resolve ${d.x}`], 1]);

    const y = push(d.w, { 'src/a.ts': 'export const a = 3;\n' }, 'next');
    const imgY = publish(d.w, imageOf(y));
    ready(d.w);
    expect(tick(d.w).code).toBe(0);
    expect(readState(d.w).CANDIDATE_HELD).toBe(undefined);
    expect(readState(d.w).SETTLED_SHA).toBe(y);
    expect(readState(d.w).SETTLED_DIGEST).toBe(imgY.digest);
  });

  it('a trial REFUSED is not tried before an hour has passed, and is tried again after it', () => {
    const d = deployWorld({ goldenDigest: true });
    reply(d.w, 'trial', GD, golden('trial-refused'));
    tick(d.w);
    expect([readState(d.w).CANDIDATE_RETRY_X, readState(d.w).CANDIDATE_RETRY_AT]).toEqual([d.x, '104200']);
    const after = events(d.w).length;
    advance(d.w, 3599);
    tick(d.w);
    expect(events(d.w).slice(after)).toEqual([`checks ${d.x}`]);
    advance(d.w, 1);
    expect(tick(d.w).code).toBe(0);
    expect(readState(d.w).SETTLED_SHA).toBe(d.x);
    expect([readState(d.w).CANDIDATE_RETRY_X, readState(d.w).LAST_FAILED_SHA]).toEqual([undefined, undefined]);
  });
});

describe('(ґ) the rollback target S is local and is what the state says', () => {
  it('S local with another image id: assess, no snapshot', () => {
    const d = deployWorld();
    reply(d.w, 'local', d.s.digest, { code: 0, stdout: `LOCAL ${d.s.digest} ${'9'.repeat(64)} content=${d.s.content} revision=${d.s.sha}\n` });
    const r = tick(d.w);
    expect(r.code).toBe(0);
    expect(events(d.w)).toEqual(toActivate(d).slice(0, 7));
    expect(notes(d.w)).toEqual([
      `⚠️ merge-deploy: the settled image ${d.s.digest} is not usable as the rollback target: LOCAL ${d.s.digest} ${'9'.repeat(64)} ${d.s.content} ${d.s.sha} `
      + `(expected id ${d.s.id}, revision ${d.s.sha}). Not deploying ${short(d.x)}; retrying next tick.`,
    ]);
  });

  it('S not local: pulled by its digest and checked again, then the deploy goes on', () => {
    const d = deployWorld();
    hostSet(d.w, `local/${d.s.digest}`, null);
    expect(tick(d.w).code).toBe(0);
    expect(events(d.w).slice(6, 9)).toEqual([
      `image local --digest ${d.s.digest}`, `image pull --sha ${d.s.sha} --digest ${d.s.digest}`, `image local --digest ${d.s.digest}`,
    ]);
    expect(readState(d.w).SETTLED_SHA).toBe(d.x);
  });
});

describe('(д) the window', () => {
  it('two failed health polls in a row settle; three fail it', () => {
    const two = deployWorld();
    fault(two.w, 'health', 300, 320, two.img.digest);
    expect(tick(two.w).code).toBe(0);
    expect(readState(two.w).SETTLED_SHA).toBe(two.x);

    const three = deployWorld();
    fault(three.w, 'health', 300, 330, three.img.digest);
    expectRolledBack(three, tick(three.w).code, 'health check failed 3 times in a row (last at +320s)', 33);
  });

  it('fails on a restart of the service (NRestarts above its base)', () => {
    const d = deployWorld();
    fault(d.w, 'restarts-plus', 300, 99999, d.img.digest);
    expectRolledBack(d, tick(d.w).code, 'service restarted (NRestarts 0 -> 1) at +300s', 31);
  });

  it('fails on another releaseSha', () => {
    const d = deployWorld();
    fault(d.w, 'health-sha', 300, 99999, d.img.digest);
    expectRolledBack(d, tick(d.w).code, `/health answers releaseSha fffffff, not ${short(d.x)}, at +300s`, 31);
  });

  it('fails when the container runs another image id', () => {
    const d = deployWorld();
    fault(d.w, 'foreign-image', 300, 99999, d.img.digest);
    expectRolledBack(d, tick(d.w).code,
      `production runs another image (quadlet=${d.img.digest} container-image=${'f'.repeat(64)} container-digest=${d.img.digest}) at +300s`, 31);
  });

  it('settles only on a fully read poll: an unread poll at 600 s defers it to 610 s', () => {
    const d = deployWorld();
    fault(d.w, 'current', 600, 610, d.img.digest);
    expect(tick(d.w).code).toBe(0);
    expect([readState(d.w).SETTLED_SHA, clock(d.w)]).toEqual([d.x, '101210']);
  });
});

describe('(е) the start', () => {
  it('fails when /health does not answer X within 120 s', () => {
    const d = deployWorld();
    fault(d.w, 'health', 0, 99999, d.img.digest);
    expectRolledBack(d, tick(d.w).code, 'not healthy within 120s', 13);
  });
});

describe('(є) the code-only rollback', () => {
  it('records the failed SHA and the phase before `activate S`; touches no database; never retries X', () => {
    const d = deployWorld();
    fault(d.w, 'health', 300, 99999, d.img.digest);
    tick(d.w);
    expect(stateAtActivate(d.w, 2)).toEqual({
      ...settledAt(d.img, d.x), SETTLED_SHA: d.s.sha, SETTLED_DIGEST: d.s.digest, SETTLED_ID: d.s.id, SETTLED_CONTENT: d.s.content,
      LAST_FAILED_SHA: d.x, RETAINED_PRE: marked(d),
      WINDOW_SHA: d.x, WINDOW_DIGEST: d.img.digest, WINDOW_ID: d.img.id, WINDOW_CONTENT: d.img.content, WINDOW_OLD: d.w.base,
      WINDOW_PREV_DIGEST: d.s.digest, WINDOW_MODE: 'auto', WINDOW_PHASE: 'rolling-back', WINDOW_PRE: marked(d), WINDOW_START: '100600',
      WINDOW_BOOT: BOOT_ID, WINDOW_NRESTARTS: '0', WINDOW_FAILS: '3', WINDOW_LAST_READ: '100920',
      WINDOW_REASON: 'health check failed 3 times in a row (last at +320s)', ROLLBACK_ATTEMPTS: '1', ACTIVATE_ATTEMPTS: '1',
    });
    // Nothing touches the database: no restore, no post snapshot, no service stop — the helper and the pre's mark only.
    expect(events(d.w)).toEqual([...toActivate(d), ...polls(33), ...rollbackEvents(d)]);
    const before = events(d.w).length;
    advance(d.w, 600);
    expect(tick(d.w).code).toBe(0);
    expect(events(d.w).length).toBe(before);
  });

  it('(ж) ACTIVATE FAILED: D could not start, S is activated again', () => {
    const d = deployWorld();
    hostSet(d.w, `sick/${d.img.digest}`, '');
    const reason = 'the activation failed: ACTIVATE FAILED: restart exited 1: Job for warsaw-beer-bot.service failed because the control process exited with error code.';
    expectRolledBack(d, tick(d.w).code, reason, 0);
  });

  it('(з) `activate S` answering 75 and then ACTIVATED rolls back', () => {
    const d = deployWorld();
    fault(d.w, 'health', 300, 99999, d.img.digest);
    reply(d.w, 'activate', d.s.digest, { code: 75, stderr: 'TEMPFAIL: systemctl restart timed out after 180s\n' });
    expect(tick(d.w).code).toBe(2);
    expect(events(d.w).slice(-6)).toEqual([
      `mark ${d.pre}`, 'image current', `image activate --digest ${d.s.digest}`,
      'image current', `image activate --digest ${d.s.digest}`, 'image current',
    ]);
    expect(readState(d.w).DEPLOYED_DIGEST).toBe(d.s.digest);
  });

  it('(з) `activate S` answering 75 twice is an incident', () => {
    const d = deployWorld();
    fault(d.w, 'health', 300, 99999, d.img.digest);
    const tempfail: Reply = { code: 75, stderr: 'TEMPFAIL: systemctl restart timed out after 180s\n' };
    reply(d.w, 'activate', d.s.digest, tempfail, tempfail);
    expect(tick(d.w).code).toBe(3);
    expect(events(d.w).filter((e) => e === `image activate --digest ${d.s.digest}`).length).toBe(2);
    expect(readState(d.w).INCIDENT).toBe(`${d.x} ${d.img.digest} the rollback to ${short(d.s.sha)} did not bring it up after 2 attempts (health check failed 3 times in a row (last at +320s))`);
  });

  it('(и) S that does not come up is an INCIDENT; then nothing runs', () => {
    const d = deployWorld();
    fault(d.w, 'health', 300, 99999, d.img.digest);
    fault(d.w, 'health', 0, 99999, d.s.digest);
    const r = tick(d.w);
    const reason = `the rollback to ${short(d.s.sha)} did not bring it up after 2 attempts (health check failed 3 times in a row (last at +320s))`;
    expect(r.code).toBe(3);
    expect(readState(d.w)).toEqual({
      ...settledAt(d.img, d.x), SETTLED_SHA: d.s.sha, SETTLED_DIGEST: d.s.digest, SETTLED_ID: d.s.id, SETTLED_CONTENT: d.s.content,
      LAST_FAILED_SHA: d.x, RETAINED_PRE: marked(d), INCIDENT: `${d.x} ${d.img.digest} ${reason}`,
    });
    expect(notes(d.w)).toEqual([
      failedNote(d, 'health check failed 3 times in a row (last at +320s)'),
      `🔥 merge-deploy INCIDENT: ${short(d.x)} (${d.img.digest}) — ${reason}. Nothing was rolled back automatically; the database is untouched.\n`
      + `Pre-deploy snapshot: ${marked(d)} (kept until a human removes it: rm ${marked(d)} ${marked(d)}.sha256)\n`
      + 'Nothing deploys until a human restores production and runs: bash deploy/deploy.sh --resolve-incident --settled <sha>',
    ]);
    const before = events(d.w).length;
    expect(tick(d.w).code).toBe(0);
    expect(events(d.w).length).toBe(before);
  });
});

describe('(й) "running" is the unit\'s state, not the container\'s ids', () => {
  it('a unit that is not running with the right image is a failed health; three fail the window', () => {
    const d = deployWorld();
    fault(d.w, 'unit', 300, 330, d.img.digest);
    expectRolledBack(d, tick(d.w).code, 'health check failed 3 times in a row (last at +320s)', 33);
  });
});

describe('(к) the window\'s history is in the state after every poll', () => {
  it('a tick killed after two failed polls leaves WINDOW_FAILS=2 and the last full read', () => {
    const d = deployWorld();
    fault(d.w, 'health', 300, 99999, d.img.digest);
    fault(d.w, 'kill', 320, 321);
    expect(tick(d.w).code).toBe(null);
    const st = readState(d.w);
    expect([st.WINDOW_PHASE, st.WINDOW_FAILS, st.WINDOW_LAST_READ, st.DEPLOYED_SHA, st.LAST_FAILED_SHA])
      .toEqual(['watching', '2', '100910', d.x, undefined]);
  });
});

describe('(л) a window that cannot be observed fails', () => {
  it('300 s without a fully read poll fails it ("could not observe")', () => {
    const d = deployWorld();
    fault(d.w, 'current', 300, 600, d.img.digest);
    expectRolledBack(d, tick(d.w).code,
      'could not observe production for 300s (current, NRestarts or the unit state unreadable)', 60, 2);
  });

  it('290 s without one does not', () => {
    const d = deployWorld();
    fault(d.w, 'current', 300, 590, d.img.digest);
    expect(tick(d.w).code).toBe(0);
    expect([readState(d.w).SETTLED_SHA, clock(d.w)]).toEqual([d.x, '101200']);
  });
});

describe('(м) lost evidence starts a new window, never fails one', () => {
  // After V14 a base above 0 exists only where a window re-based without comparing (lost evidence, a
  // reboot); the tick that took it is stood in for by a window killed at +10 s whose base is set to 5.
  it('NRestarts below its base in the same boot: a full window from then, ⚠️', () => {
    const d = deployWorld();
    fault(d.w, 'kill', 10, 11);
    expect(tick(d.w).code).toBe(null);
    patchState(d.w, { WINDOW_NRESTARTS: '5' });
    hostSet(d.w, 'nrestarts', '5');
    fault(d.w, 'restarts-minus', 300, 99999, d.img.digest);
    expect(tick(d.w).code).toBe(0);
    expect([readState(d.w).SETTLED_SHA, readState(d.w).LAST_FAILED_SHA, clock(d.w)]).toEqual([d.x, undefined, '101500']);
    expect(notes(d.w)).toEqual([
      `⚠️ merge-deploy ${short(d.x)}: the window lost its evidence (NRestarts went down in the same boot (5 -> 4)) — watching a full 600s window again from now.`,
      `✅ merge-deploy ${short(d.x)} is live and settled.`, // a resumed window does not re-read the range's PRs
    ]);
  });

  it('the clock going back: a full window from then, ⚠️', () => {
    const d = deployWorld();
    hostSet(d.w, 'clock-back', '300 100');
    expect(tick(d.w).code).toBe(0);
    // The probe at +300 s (100900) moves the clock to 100800; the next poll, after its 10 s sleep, reads 100810.
    expect([readState(d.w).SETTLED_SHA, clock(d.w)]).toEqual([d.x, '101410']);
    expect(notes(d.w)[0]).toBe(
      `⚠️ merge-deploy ${short(d.x)}: the window lost its evidence (the clock went back: now 100810, window start 100600, last read 100900) — watching a full 600s window again from now.`);
  });
});

describe('(н) the rollback looks at the facts before every attempt', () => {
  it('S already running and answering: rolled back with no `activate S`', () => {
    const d = deployWorld();
    hostSet(d.w, 'swap', `300 ${d.s.digest}`);
    const r = tick(d.w);
    const reason = `production runs another image (quadlet=${d.s.digest} container-image=${d.s.id} container-digest=${d.s.digest}) at +300s`;
    expect(r.code).toBe(2);
    expect(events(d.w)).toEqual([...toActivate(d), ...polls(31), `mark ${d.pre}`, 'image current']);
    expect(notes(d.w)).toEqual([failedNote(d, reason), rolledBackNote(d, reason)]);
  });
});

describe('(ї) retention with the real db-snapshot.sh', () => {
  it('a failed window\'s pre is marked and kept by its new name through prune of four later settled windows', () => {
    const d = deployWorld();
    fault(d.w, 'health', 300, 99999, d.img.digest);
    expect(tick(d.w).code).toBe(2);
    expect(readState(d.w).RETAINED_PRE).toBe(marked(d));
    const later: string[] = [];
    for (const n of [3, 4, 5, 6]) {
      const y = push(d.w, { 'src/a.ts': `export const a = ${n};\n` }, `feat ${n}`);
      publish(d.w, imageOf(y));
      ready(d.w);
      expect(tick(d.w).code).toBe(0);
      later.push(short(y));
    }
    // prune 3 after each of the four settled windows: the oldest unmarked pre is gone, the marked one stays.
    const pres = readdirSync(d.w.snapshots).filter((f) => f.endsWith('.db')).sort();
    expect(pres.map((f) => f.replace(/^\d{8}T\d{6}Z-/, ''))).toEqual([
      `${short(d.x)}-rollback-pre.db`, `${later[1]}-pre.db`, `${later[2]}-pre.db`, `${later[3]}-pre.db`,
    ]);
    expect([pres[0], existsSync(`${marked(d)}.sha256`)]).toEqual([d.pre.replace(/-pre\.db$/, '-rollback-pre.db'), true]);
  });
});

describe('(о) a noop commit released by hand, then a real release that fails', () => {
  it('the rollback waits for the settled image\'s own SHA; the gates count from the advanced DEPLOYED_SHA', () => {
    const w = imageWorld();
    const n = push(w, { 'deploy/sudoers.d/wbb-image': 'x\n' }, 'held noop');
    // What the manual deploy of the held noop commit records: DEPLOYED_SHA moved, the image did not.
    seedState(w, { ...settledState(w.settled), DEPLOYED_SHA: n });
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');
    const img = publish(w, imageOf(x));
    fault(w, 'health', 300, 99999, img.digest);
    ready(w);
    const r = tick(w);
    expect(r.code).toBe(2);
    expect(readState(w)).toEqual({
      ...settledState(w.settled), DEPLOYED_SHA: n, LAST_SEEN_DEPLOYED_SHA: n, MAIN_SEEN_SHA: x, MAIN_SEEN_S: '100000',
      LAST_FAILED_SHA: x, RETAINED_PRE: join(w.snapshots, `19700102T035640Z-${short(x)}-rollback-pre.db`),
    });
    expect(hostRead(w, 'running_sha')).toBe(w.base);
  });
});

describe('(п) the tick\'s budget', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const block = src.slice(src.indexOf('# --- timeouts and the tick\'s budget (plan'), src.indexOf('# --- timeouts and the tick\'s budget ---'));
  const lockStall = /^LOCK_STALL_S=.*$/m.exec(src)?.[0] ?? '';
  const value = (name: string) =>
    Number(execFileSync('bash', ['-c', `${block}\n${lockStall}\necho "$${name}"`], { encoding: 'utf8' }).trim());
  const steps = [...block.matchAll(/^(STEP_TIMEOUT_[A-Z_]+_S)=\d+/gm)].map((m) => m[1]);

  it('every STEP_TIMEOUT bounds a call: each is used outside the budget block', () => {
    const code = src.slice(0, src.indexOf('# --- timeouts and the tick\'s budget (plan'))
      + src.slice(src.indexOf('# --- timeouts and the tick\'s budget ---'));
    expect(steps.filter((n) => !code.includes(`$${n}`))).toEqual([]);
    expect(steps.length).toBe(19);
  });

  it('the worst tick, built from those bounds and the loops, fits TICK_BUDGET_S', () => {
    expect([value('WINDOW_WORST_S'), value('ROLLBACK_WORST_S'), value('WORST_PATH_S'), value('TICK_BUDGET_S')])
      .toEqual([1120, 1690, 7290, 7500]);
    expect(value('WORST_PATH_S') < value('TICK_BUDGET_S')).toBe(true);
    expect(value('LOCK_STALL_S')).toBe(7800);
  });

  it('the helper runs under `timeout` with its action\'s bound (the real default seam, a fake sudo)', () => {
    const w = imageWorld();
    const x = push(w, { 'docs/x.md': 'a\n' }, 'docs');
    const img = publish(w, imageOf(x, w.settled.content));
    const log = join(w.bin, 'sudo.log');
    stub(w.pathBin, 'sudo', [
      `echo "$(tr '\\0' ' ' < /proc/$PPID/cmdline)" >> "${log}"`,
      '[ "$1" = -n ] && shift',
      'exec "$@"',
    ].join('\n'));
    const over = { WBB_IMAGE_CMD: '', WBB_IMAGE_BIN: join(w.bin, 'wbb-image') };
    ready(w, over);
    expect(tick(w, over).code).toBe(0);
    const helper = join(w.bin, 'wbb-image');
    expect(readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').map((l) => l.trim())).toEqual([
      `timeout 660 sudo -n ${helper} pull --sha ${x} --digest ${img.digest}`,
      `timeout 90 sudo -n ${helper} current`,
      `timeout 300 sudo -n ${helper} prune --keep ${w.settled.digest}`,
    ]);
  });
});

describe('F4: an unreadable fact is waited for, not counted as an attempt', () => {
  it('`current` unreadable for 80 s at the rollback: no attempt spent, `activate S` once it reads', () => {
    const d = deployWorld();
    fault(d.w, 'health', 300, 99999, d.img.digest);
    fault(d.w, 'current', 320, 400, d.img.digest);
    expect(tick(d.w).code).toBe(2);
    expect(events(d.w).slice(-12)).toEqual(rollbackEvents(d, 9));
    expect(stateAtActivate(d.w, 2).ROLLBACK_ATTEMPTS).toBe('1');
  });

  it('unreadable for STARTUP_S: an incident, no `activate S`', () => {
    const d = deployWorld();
    fault(d.w, 'health', 300, 99999, d.img.digest);
    fault(d.w, 'current', 320, 99999, d.img.digest);
    expect(tick(d.w).code).toBe(3);
    expect(events(d.w).filter((e) => e.startsWith('image activate'))).toEqual([`image activate --digest ${d.img.digest}`]);
    expect([readState(d.w).LAST_FAILED_SHA, readState(d.w).INCIDENT]).toEqual([d.x,
      `${d.x} ${d.img.digest} could not read whether ${short(d.s.sha)} runs for 120s during the rollback (health check failed 3 times in a row (last at +320s))`]);
  });
});

describe('F7: a watched window stands on an NRestarts base', () => {
  it('NRestarts unreadable for 300 s from the start: the window fails as unobservable', () => {
    const d = deployWorld();
    fault(d.w, 'restarts', 0, 99999, d.img.digest);
    const reason = 'could not observe production: NRestarts unreadable for 300s at the start of the window';
    expect(tick(d.w).code).toBe(2);
    expect(events(d.w)).toEqual([...toActivate(d), ...rollbackEvents(d)]);
    expect(notes(d.w)).toEqual([failedNote(d, reason), rolledBackNote(d, reason)]);
  });
});

describe('F9: the retained pre is the name the rename produced', () => {
  it('a tick killed between the rename and its write: the next one finds the renamed file and keeps it', () => {
    const d = deployWorld();
    fault(d.w, 'health', 300, 99999, d.img.digest);
    expect(tick(d.w, { WBB_MARK_CMD: markThenKill(d.w) }).code).toBe(null);
    expect([readState(d.w).WINDOW_PRE, readState(d.w).RETAINED_PRE]).toEqual([join(d.w.snapshots, d.pre), undefined]);
    const before = events(d.w).length;
    expect(tick(d.w).code).toBe(2);
    expect(events(d.w).slice(before)).toEqual(['image current', 'image current', `image activate --digest ${d.s.digest}`, 'image current']);
    expect(readState(d.w).RETAINED_PRE).toBe(marked(d));
  });

  it('a mark that answers another name is not believed: nothing is retained, the note says so', () => {
    const d = deployWorld();
    fault(d.w, 'health', 300, 99999, d.img.digest);
    const liar = stub(d.w.bin, 'mark-liar', `echo "mark $(basename "$1")" >> "${d.w.eventsLog}"; echo /elsewhere/x-rollback-pre.db`);
    expect(tick(d.w, { WBB_MARK_CMD: liar }).code).toBe(2);
    expect([readState(d.w).RETAINED_PRE, readState(d.w).PENDING_MARK]).toEqual([undefined, join(d.w.snapshots, d.pre)]);
    expect(notes(d.w)[1].split('\n')[2]).toBe(
      `Pre-deploy snapshot: NOT marked yet (mark-rollback did not answer ${marked(d)}); retried every tick, and snapshots are not pruned until it is: ${join(d.w.snapshots, d.pre)}`);
  });
});

describe('F10: a pre snapshot no window owns is discarded by the next tick', () => {
  it('a tick killed during the trial leaves PENDING_PRE; the next discards it, clears it, and deploys afresh', () => {
    const d = deployWorld();
    reply(d.w, 'trial', d.img.digest, 'kill-before');
    expect(tick(d.w).code).toBe(null);
    expect([readState(d.w).PENDING_PRE, readState(d.w).WINDOW_PHASE]).toEqual([join(d.w.snapshots, d.pre), undefined]);
    const before = events(d.w).length;
    expect(tick(d.w).code).toBe(0);
    expect(events(d.w)[before]).toBe(`discard ${d.pre}`);
    expect([readState(d.w).PENDING_PRE, readState(d.w).SETTLED_SHA]).toEqual([undefined, d.x]);
    expect(readdirSync(d.w.snapshots).filter((f) => f.endsWith('.db'))).toEqual([d.pre]);
  });
});

describe('PR #866 review: a failed mark never loses the evidence (item 2)', () => {
  it('PENDING_MARK is kept, retried by every tick, and holds back the snapshot prune until the mark succeeds', () => {
    const d = deployWorld();
    fault(d.w, 'health', 300, 99999, d.img.digest);
    // mark-rollback that fails while host/mark-broken exists, and is the real db-snapshot.sh otherwise.
    const mark = stub(d.w.bin, 'mark-flaky', [
      `echo "mark $(basename "$1")" >> "${d.w.eventsLog}"`,
      `[ ! -f "${join(d.w.host, 'mark-broken')}" ] || exit 1`,
      `exec bash "${DB_SNAPSHOT}" mark-rollback "$1"`,
    ].join('\n'));
    hostSet(d.w, 'mark-broken', '');
    const over = { WBB_MARK_CMD: mark };
    expect(tick(d.w, over).code).toBe(2);
    expect([readState(d.w).PENDING_MARK, readState(d.w).RETAINED_PRE]).toEqual([join(d.w.snapshots, d.pre), undefined]);

    // The next release settles while the mark still fails: retried, and no snapshot prune.
    const y = push(d.w, { 'src/a.ts': 'export const a = 3;\n' }, 'next');
    publish(d.w, imageOf(y));
    ready(d.w, over);
    const before = events(d.w).length;
    expect(tick(d.w, over).code).toBe(0);
    const ev = events(d.w).slice(before);
    expect([ev[0], ev.includes('prune'), ev[ev.length - 1]]).toEqual([`mark ${d.pre}`, false, `image prune --keep ${imageOf(y).digest}`]);
    expect(notes(d.w)[notes(d.w).length - 1]).toBe(
      `✅ merge-deploy ${short(y)} is live and settled — #7. Snapshot pruning skipped: not yet marked ${join(d.w.snapshots, d.pre)}.`);

    // The mark works again: the first thing the next tick does is mark and retain it.
    hostSet(d.w, 'mark-broken', null);
    tick(d.w, over);
    expect([readState(d.w).PENDING_MARK, readState(d.w).RETAINED_PRE]).toEqual([undefined, marked(d)]);
    expect([existsSync(marked(d)), existsSync(join(d.w.snapshots, d.pre))]).toEqual([true, false]);
  });
});

describe('spec V14: after an activation NRestarts counts only the candidate\'s own restarts', () => {
  it('above 0 at the start: the candidate restarted during startup — failed, rolled back', () => {
    const d = deployWorld();
    fault(d.w, 'restarts-plus', 0, 99999, d.img.digest);
    const reason = 'the candidate restarted during startup (NRestarts 1 since its activation)';
    expect(tick(d.w).code).toBe(2);
    expect(events(d.w)).toEqual([...toActivate(d), ...rollbackEvents(d)]);
    expect(notes(d.w)).toEqual([failedNote(d, reason), rolledBackNote(d, reason)]);
  });

  it('the old release had restarted 5 times and the candidate once before the first read: still a failed start', () => {
    const d = deployWorld();
    hostSet(d.w, 'nrestarts', '5');
    fault(d.w, 'restarts-plus', 0, 99999, d.img.digest);
    const reason = 'the candidate restarted during startup (NRestarts 1 since its activation)';
    expect(tick(d.w).code).toBe(2);
    expect([notes(d.w), readState(d.w).LAST_FAILED_SHA]).toEqual([[failedNote(d, reason), rolledBackNote(d, reason)], d.x]);
  });

  it('the old release had restarted 5 times, the candidate never: the window stands on base 0', () => {
    const d = deployWorld();
    hostSet(d.w, 'nrestarts', '5');
    fault(d.w, 'kill', 10, 11);
    expect(tick(d.w).code).toBe(null);
    expect([readState(d.w).WINDOW_NRESTARTS_PRE, readState(d.w).WINDOW_NRESTARTS, readState(d.w).WINDOW_PHASE]).toEqual([undefined, '0', 'watching']);
  });
});
