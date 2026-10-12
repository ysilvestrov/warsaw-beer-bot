import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Golden outputs of the root helper wbb-image (plan
// docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md, "Рішення" п.9, Task 0).
// The image controller's parsers are tested on scripts/autodeploy/fixtures/wbb-image/*.txt; this
// keeps those files equal to what the helper's own main() prints today.
const root = resolve(__dirname, '../..');
const committed = resolve(root, 'scripts/autodeploy/fixtures/wbb-image');
const REGENERATE = 'stale golden output: run `python3 -B scripts/autodeploy/wbb-image-golden.py '
  + 'scripts/autodeploy/fixtures/wbb-image` and commit the result';

const NAMES = [
  'activate-activated.txt',
  'activate-failed.txt',
  'audit-advisory.txt',
  'audit-clean.txt',
  'current-absent.txt',
  'current-foreign.txt',
  'current-quadlet.txt',
  'local-local.txt',
  'local-not-local.txt',
  'pull-pulled.txt',
  'pull-refused.txt',
  'pull-tempfail.txt',
  'trial-compat-failed-start-timeout.txt',
  'trial-compat-failed.txt',
  'trial-ok.txt',
  'trial-refused.txt',
  'trial-start-failed.txt',
  'trial-tempfail.txt',
  'trial-trial-failed.txt',
];

describe.skipIf(process.platform !== 'linux')('wbb-image golden outputs', () => {
  let fresh = '';
  let generated: ReturnType<typeof spawnSync>;
  beforeAll(() => {
    fresh = mkdtempSync(resolve(tmpdir(), 'wbb-image-golden-'));
    generated = spawnSync('python3', ['-B', 'scripts/autodeploy/wbb-image-golden.py', fresh], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
    });
  });
  afterAll(() => rmSync(fresh, { recursive: true, force: true }));

  it('the generator runs cleanly', () => {
    expect([generated.status, generated.stdout, generated.stderr]).toEqual([0, '', '']);
  });

  it('makes exactly the committed set of cases', () => {
    expect([readdirSync(fresh).sort(), readdirSync(committed).sort()]).toEqual([NAMES, NAMES]);
  });

  it.each(NAMES)('%s is what the helper prints now', (name) => {
    expect(readFileSync(resolve(committed, name), 'utf8'), REGENERATE)
      .toEqual(readFileSync(resolve(fresh, name), 'utf8'));
  });

  // The advisory's details are the real verdict CLI's text for the npm-audit advisory fixture,
  // not a shape someone remembered.
  it('AUDIT ADVISORY carries the audit-verdict CLI output for the advisory fixture', () => {
    const cli = spawnSync(resolve(root, 'node_modules/.bin/tsx'), ['scripts/autodeploy/audit-verdict-cli.ts'], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
      input: readFileSync(resolve(root, 'scripts/autodeploy/fixtures/npm-audit/advisory.json')),
    });
    const golden = readFileSync(resolve(committed, 'audit-advisory.txt'), 'utf8');
    expect([cli.status, golden]).toEqual([10,
      'exit=1\n--- stdout\nAUDIT ADVISORY sha256:' + 'd'.repeat(64) + '\n' + cli.stdout + '--- stderr\n']);
  });

  // Plan "Рішення" п.9: on 2 and 75 the controller reads the FIRST line of stderr.
  it.each([
    ['pull-refused.txt', 'exit=2', 'REFUSED: '],
    ['pull-tempfail.txt', 'exit=75', 'TEMPFAIL: '],
    ['trial-refused.txt', 'exit=2', 'REFUSED: '],
    ['trial-tempfail.txt', 'exit=75', 'TEMPFAIL: '],
  ])('%s: the verdict is the first line of stderr', (name, exit, prefix) => {
    const text = readFileSync(resolve(committed, name), 'utf8');
    const stderr = text.slice(text.indexOf('--- stderr\n') + '--- stderr\n'.length).split('\n');
    expect([text.split('\n')[0], stderr[0].startsWith(prefix)]).toEqual([exit, true]);
  });
});
