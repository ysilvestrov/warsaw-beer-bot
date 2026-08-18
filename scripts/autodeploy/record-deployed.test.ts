import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RECORD = resolve(__dirname, '../../deploy/record-deployed.sh');

/**
 * #435 — the deployed baseline.
 *
 * The autodeploy guard diffs from the DEPLOYED commit, so a stale baseline does
 * not merely mislead: every merge that is not deployed adds paths to that diff,
 * and once it leaves the allowlist every future security tag is refused —
 * invisibly, because a refusal looks exactly like the guard working correctly.
 * MEASURED 2026-08-18: three merges, twelve files, autodeploy dead with no error
 * anywhere. So the baseline is written where reality changes, by deploy.sh.
 */

function run(stateHome: string, sha: string): string {
  return execFileSync('bash', [RECORD, sha], {
    encoding: 'utf8',
    env: { ...process.env, XDG_STATE_HOME: stateHome },
  });
}

const statePath = (stateHome: string): string =>
  join(stateHome, 'wbb-autodeploy', 'state.env');

describe('record-deployed.sh', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wbb-state-'));
  });

  it('creates the state file and its directory when neither exists', () => {
    run(home, 'abc123');
    expect(readFileSync(statePath(home), 'utf8')).toContain('DEPLOYED_SHA=abc123');
  });

  it('PRESERVES the keys autodeploy.sh owns', () => {
    // The regression that matters: a deploy landing between two autodeploy
    // ticks must not wipe the rollback target or the failed-tag memory, or
    // C3's "do not retry a failed tag every five minutes" silently resets.
    const p = statePath(home);
    run(home, 'first');
    writeFileSync(
      p,
      'DEPLOYED_SHA=first\nPREVIOUS_SHA=older\nLAST_FAILED_SHA=badtag\nLAST_DRIFT_NOTICE=2026-08-18\n',
    );
    run(home, 'second');
    const out = readFileSync(p, 'utf8');
    expect(out).toContain('DEPLOYED_SHA=second');
    expect(out).toContain('PREVIOUS_SHA=older');
    expect(out).toContain('LAST_FAILED_SHA=badtag');
    expect(out).toContain('LAST_DRIFT_NOTICE=2026-08-18');
    // Exactly one, not an accumulating pile.
    expect(out.match(/^DEPLOYED_SHA=/gm)).toHaveLength(1);
  });

  it('clears the baseline when handed an empty sha', () => {
    run(home, 'abc123');
    const out = run(home, '');
    expect(readFileSync(statePath(home), 'utf8')).toMatch(/^DEPLOYED_SHA=$/m);
    expect(out).toMatch(/cleared/i);
  });

  it('leaves no temp file behind', () => {
    run(home, 'abc123');
    const leftovers = readdirSync(join(home, 'wbb-autodeploy')).filter((f) =>
      f.startsWith('.state.'),
    );
    expect(leftovers).toEqual([]);
    expect(existsSync(statePath(home))).toBe(true);
  });
});
