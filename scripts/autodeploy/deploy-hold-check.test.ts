import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isHoldPath, checkHold } from './deploy-hold-check';

const AUTODEPLOY = resolve(__dirname, '../../deploy/autodeploy.sh');
const CLI = resolve(__dirname, 'deploy-hold-check.ts');

const TABLE: Array<[string, boolean]> = [
  ['deploy/sudoers.d/warsaw-beer-bot', true],
  ['deploy/litestream.yml', true],
  ['deploy/litestream.service', true],
  ['deploy/wbb-autodeploy.service', true],
  ['deploy/wbb-autodeploy.timer', true],
  ['deploy/install-autodeploy.sh', true],
  ['deploy/install-resource-monitor.sh', true],
  ['deploy/rsync-filter', true],
  ['deploy/autodeploy.sh', true],
  ['deploy/ships.sh', true],
  ['deploy/read-env.sh', true],
  ['deploy/installed-current.sh', true],
  ['deploy/db-snapshot.sh', true],
  ['deploy/trial-migrate.cjs', true],
  ['deploy/warsaw-beer-bot.service', false],
  ['deploy/deploy.sh', false],
  ['deploy/record-deployed.sh', false],
  ['deploy/README.md', false],
  ['src/index.ts', false],
  ['docs/x.md', false],
];

describe('isHoldPath', () => {
  it.each(TABLE)('%s → %s', (path, held) => {
    expect(isHoldPath(path)).toBe(held);
  });

  // The deployer's bash predicate is the authority; this copy exists only so
  // the merger sees the hold before pressing the button. Two lists that drift
  // apart make the title lie, so every row is asked of both.
  it.each(TABLE)('agrees with path_is_held in deploy/autodeploy.sh for %s', (path) => {
    const fn = execFileSync('sed', ['-n', '/^path_is_held() {/,/^}/p', AUTODEPLOY], { encoding: 'utf8' });
    const verdict = spawnSync('bash', ['-c', `${fn}\npath_is_held "$1" && echo HOLD || echo PASS`, '_', path],
      { encoding: 'utf8' }).stdout.trim();
    expect(verdict).toBe(isHoldPath(path) ? 'HOLD' : 'PASS');
  });
});

describe('checkHold', () => {
  it('passes an ordinary PR', () => {
    expect(checkHold({ title: 'feat: x', labels: [], paths: ['src/a.ts'] }))
      .toEqual({ ok: true, held: [], problems: [] });
  });

  it('passes a marked and labelled PR that touches a hold path', () => {
    expect(checkHold({ title: '[deploy:hold] fix(deploy): x', labels: ['deploy:hold'], paths: ['deploy/rsync-filter'] }))
      .toEqual({ ok: true, held: ['deploy/rsync-filter'], problems: [] });
  });

  it('fails a hold path without the title marker, naming the paths', () => {
    const r = checkHold({ title: 'fix(deploy): x', labels: ['deploy:hold'], paths: ['src/a.ts', 'deploy/sudoers.d/warsaw-beer-bot'] });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      'the title has no [deploy:hold] marker but the label is set',
      'hold paths changed without a [deploy:hold] title: deploy/sudoers.d/warsaw-beer-bot — prefix the title with [deploy:hold], add the deploy:hold label, and list the host steps in the PR body',
    ]);
  });

  it('fails a marker without the label', () => {
    expect(checkHold({ title: '[deploy:hold] x', labels: [], paths: [] }).problems)
      .toEqual(['the title carries [deploy:hold] but the deploy:hold label is missing']);
  });

  it('fails a label without the marker, even when no hold path changed', () => {
    expect(checkHold({ title: 'x', labels: ['deploy:hold'], paths: [] }).problems)
      .toEqual(['the title has no [deploy:hold] marker but the label is set']);
  });

  it('accepts a hold with no hold path (an .env key or a preflight has no path)', () => {
    expect(checkHold({ title: '[deploy:hold] feat: needs NEW_KEY in .env', labels: ['deploy:hold'], paths: ['src/a.ts'] }))
      .toEqual({ ok: true, held: [], problems: [] });
  });

  it('only a marker at the very start counts', () => {
    expect(checkHold({ title: 'fix [deploy:hold] x', labels: ['deploy:hold'], paths: [] }).ok).toBe(false);
  });
});

describe('deploy-hold-check CLI', () => {
  function cli(title: string, labels: string[], paths: string): { code: number | null; out: string } {
    const r = spawnSync('npx', ['tsx', CLI], {
      input: paths, encoding: 'utf8',
      env: { ...process.env, PR_TITLE: title, PR_LABELS: JSON.stringify(labels) },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  }

  it('exits 1 and prints the problems', () => {
    const r = cli('fix: x', [], 'deploy/rsync-filter\n');
    expect(r.code).toBe(1);
    expect(r.out).toContain('hold paths changed without a [deploy:hold] title: deploy/rsync-filter');
  });

  it('exits 0 for a correctly held PR', () => {
    expect(cli('[deploy:hold] x', ['deploy:hold'], 'deploy/rsync-filter\n').code).toBe(0);
  });

  it('exits 2 when PR_LABELS is not a JSON array of strings', () => {
    const r = spawnSync('npx', ['tsx', CLI], { input: '', encoding: 'utf8', env: { ...process.env, PR_TITLE: 'x', PR_LABELS: 'nope' } });
    expect(r.status).toBe(2);
  });

  it('exits 2 on an empty path list: a PR always changes something, so empty means the diff failed', () => {
    const r = cli('fix: x', [], '');
    expect(r.code).toBe(2);
    expect(r.out).toContain('no changed paths on stdin');
  });
});
