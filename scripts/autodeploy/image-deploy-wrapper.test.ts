import { describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeTempDirectory } from '../test-temp';

/**
 * deploy/deploy.sh — the human's wrapper over the manual mode of the image controller (plan
 * docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-b2-harness.md, "Рішення" п.1–4, Task 1).
 *
 * Real bash and real git: a throwaway bare origin and a checkout cloned from it, holding a copy of the
 * wrapper and a deploy/autodeploy.sh beside it. The "installed" controller (WBB_INSTALLED_CONTROLLER) is a
 * stub that writes its argv to a file and exits with WBB_STUB_EXIT; the same stub bytes are the
 * checkout's autodeploy.sh, so the byte check passes unless a test breaks it. Expected argv, codes and
 * messages are literals of the test.
 */
const WRAPPER = resolve(__dirname, '../../deploy/deploy.sh');

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$WBB_STUB_LOG"
exit "\${WBB_STUB_EXIT:-0}"
`;

const SETTLED = 'a'.repeat(40);

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function commitIn(repo: string, path: string, body: string, message: string): string {
  const full = join(repo, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

interface World {
  checkout: string;
  seed: string;
  remote: string;
  installed: string;
  log: string;
  uidCmd: string;
  /** HEAD of the checkout: base. origin/main is one commit AHEAD of it after a fetch. */
  head: string;
}

/**
 * origin/main: base (the wrapper, the stub as autodeploy.sh, a file) → next. The checkout is cloned at
 * base and never pulls, so its HEAD is an ancestor of origin/main and differs from it: a target taken
 * from origin/main instead of HEAD shows up.
 */
function world(): World {
  const remote = makeTempDirectory('wbb-wrap-remote-');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = makeTempDirectory('wbb-wrap-seed-');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  git(seed, 'remote', 'add', 'origin', remote);
  mkdirSync(join(seed, 'deploy'), { recursive: true });
  writeFileSync(join(seed, 'deploy/deploy.sh'), readFileSync(WRAPPER));
  chmodSync(join(seed, 'deploy/deploy.sh'), 0o755);
  writeFileSync(join(seed, 'deploy/autodeploy.sh'), STUB);
  chmodSync(join(seed, 'deploy/autodeploy.sh'), 0o755);
  const head = commitIn(seed, 'src/a.ts', 'export const a = 1;\n', 'base');
  git(seed, 'push', '-q', 'origin', 'main');

  const parent = makeTempDirectory('wbb-wrap-checkout-');
  const checkout = join(realpathSync(parent), 'repo');
  execFileSync('git', ['clone', '-q', remote, checkout]);
  git(checkout, 'config', 'user.email', 't@example.com');
  git(checkout, 'config', 'user.name', 'T');

  commitIn(seed, 'src/a.ts', 'export const a = 2;\n', 'next');
  git(seed, 'push', '-q', 'origin', 'main');

  const bin = realpathSync(makeTempDirectory('wbb-wrap-bin-'));
  const installed = join(bin, 'wbb-autodeploy');
  writeFileSync(installed, STUB);
  chmodSync(installed, 0o755);
  const uidCmd = join(bin, 'uid');
  writeFileSync(uidCmd, '#!/usr/bin/env bash\necho "${WBB_FAKE_UID:-1000}"\n');
  chmodSync(uidCmd, 0o755);
  return { checkout, seed, remote, installed, log: join(bin, 'argv'), uidCmd, head };
}

interface Run { status: number | null; stderr: string; argv: string[] | 'never called' }

function run(w: World, args: string[], opts: { cwd?: string; script?: string; env?: Record<string, string> } = {}): Run {
  const r = spawnSync('bash', [opts.script ?? 'deploy/deploy.sh', ...args], {
    cwd: opts.cwd ?? w.checkout,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      WBB_INSTALLED_CONTROLLER: w.installed,
      WBB_UID_CMD: w.uidCmd,
      WBB_STUB_LOG: w.log,
      ...opts.env,
    },
  });
  const argv = existsSync(w.log) ? readFileSync(w.log, 'utf8').split('\n').slice(0, -1) : 'never called';
  return { status: r.status, stderr: r.stderr, argv };
}

const USAGE = `usage: bash deploy/deploy.sh [--force] [--ack-incompatible]   deploy HEAD of this checkout
       bash deploy/deploy.sh --bootstrap                         the first image release, of HEAD
       bash deploy/deploy.sh --resolve-incident --settled <sha>  close an incident: the image <sha> was restored
       bash deploy/deploy.sh --resolve-incident --flat           close an incident: the old unit and the flat tree are back
`;

const mismatch = (w: World, what: string): string =>
  `ERROR: the installed controller ${w.installed} ${what} this checkout's ${w.checkout}/deploy/autodeploy.sh. ` +
  'A manual run must execute the controller the timer runs, so nothing is started. ' +
  'Until the switchover session the installed copy is the old flat deployer and this always refuses; ' +
  'follow deploy/README.md → Switchover session (stage «в»), not the installer alone.\n';

describe('deploy/deploy.sh', () => {
  describe('(а) translates each command into the installed controller\'s --manual call', () => {
    test.each<[string[], number, (w: World) => string[]]>([
      [[], 0, (w) => ['--manual', 'deploy', '--target', w.head]],
      [['--force'], 1, (w) => ['--manual', 'deploy', '--target', w.head, '--force']],
      [['--ack-incompatible'], 2, (w) => ['--manual', 'deploy', '--target', w.head, '--ack-incompatible']],
      [['--ack-incompatible', '--force'], 3, (w) => ['--manual', 'deploy', '--target', w.head, '--force', '--ack-incompatible']],
      [['--bootstrap'], 1, (w) => ['--manual', 'bootstrap', '--target', w.head]],
      [['--resolve-incident', '--settled', SETTLED], 2, () => ['--manual', 'resolve-incident', '--settled', SETTLED]],
      [['--settled', SETTLED, '--resolve-incident'], 0, () => ['--manual', 'resolve-incident', '--settled', SETTLED]],
      [['--resolve-incident', '--flat'], 3, () => ['--manual', 'resolve-incident', '--flat']],
    ])('%j → the controller\'s argv, its exit code %i returned as is', (args, code, expected) => {
      const w = world();
      const r = run(w, args, { env: { WBB_STUB_EXIT: String(code) } });
      expect(r).toEqual({ status: code, stderr: '', argv: expected(w) });
    });
  });

  describe('(б) usage: 64, the controller never called', () => {
    test.each<[string, string[]]>([
      ['--settled without --resolve-incident', ['--settled', SETTLED]],
      ['--flat without --resolve-incident', ['--flat']],
      ['--resolve-incident with neither --settled nor --flat', ['--resolve-incident']],
      ['--resolve-incident with both --settled and --flat', ['--resolve-incident', '--settled', SETTLED, '--flat']],
      ['--force with --bootstrap', ['--bootstrap', '--force']],
      ['--ack-incompatible with --bootstrap', ['--bootstrap', '--ack-incompatible']],
      ['--force with --resolve-incident', ['--resolve-incident', '--flat', '--force']],
      ['--bootstrap with --resolve-incident', ['--bootstrap', '--resolve-incident', '--flat']],
      ['an unknown flag', ['--target', SETTLED]],
      ['a positional argument', ['deploy']],
      ['--force twice', ['--force', '--force']],
      ['--settled twice', ['--resolve-incident', '--settled', SETTLED, '--settled', SETTLED]],
      ['--settled with a short SHA', ['--resolve-incident', '--settled', 'aaaaaaa']],
      ['--settled with an upper-case SHA', ['--resolve-incident', '--settled', 'A'.repeat(40)]],
      ['--settled with no value', ['--resolve-incident', '--settled']],
    ])('%s', (_name, args) => {
      const w = world();
      expect(run(w, args)).toEqual({ status: 64, stderr: USAGE, argv: 'never called' });
    });

    test('no command is a deploy: nothing is missing', () => {
      const w = world();
      expect(run(w, [])).toEqual({ status: 0, stderr: '', argv: ['--manual', 'deploy', '--target', w.head] });
    });
  });

  test('(в) as root: refused with 1, the controller never called', () => {
    const w = world();
    expect(run(w, ['--resolve-incident', '--flat'], { env: { WBB_FAKE_UID: '0' } })).toEqual({
      status: 1,
      stderr: 'ERROR: run deploy.sh as the operator (bash deploy/deploy.sh), not as root or via sudo: '
        + 'the controller keeps its state and lock in the operator\'s $HOME and calls sudo itself, per step.\n',
      argv: 'never called',
    });
  });

  describe('(г) a tracked change refuses deploy and bootstrap; resolve-incident does not care', () => {
    const DIRTY = (w: World): string =>
      `ERROR: ${w.checkout} has tracked changes — the target is HEAD, and the tree is not HEAD. Commit or stash them:\n`
      + ' M src/a.ts\n';

    test.each<[string[]]>([[[]], [['--bootstrap']]])('%j with a modified tracked file → 1', (args) => {
      const w = world();
      writeFileSync(join(w.checkout, 'src/a.ts'), 'export const a = 9;\n');
      expect(run(w, args)).toEqual({ status: 1, stderr: DIRTY(w), argv: 'never called' });
    });

    test('an untracked file is not a change: deploy goes on', () => {
      const w = world();
      writeFileSync(join(w.checkout, 'notes.txt'), 'x\n');
      expect(run(w, [])).toEqual({ status: 0, stderr: '', argv: ['--manual', 'deploy', '--target', w.head] });
    });

    test.each<[string[], string[]]>([
      [['--resolve-incident', '--flat'], ['--manual', 'resolve-incident', '--flat']],
      [['--resolve-incident', '--settled', SETTLED], ['--manual', 'resolve-incident', '--settled', SETTLED]],
    ])('%j with a modified tracked file goes on', (args, expected) => {
      const w = world();
      writeFileSync(join(w.checkout, 'src/a.ts'), 'export const a = 9;\n');
      expect(run(w, args)).toEqual({ status: 0, stderr: '', argv: expected });
    });
  });

  describe('(ґ) HEAD must be on origin/main', () => {
    test.each<[string[], string]>([[[], 'deploy'], [['--bootstrap'], 'bootstrap']])('%j from a commit outside main → 1', (args) => {
      const w = world();
      const side = commitIn(w.checkout, 'src/side.ts', 'export const s = 1;\n', 'side');
      expect(run(w, args)).toEqual({
        status: 1,
        stderr: `ERROR: HEAD (${side}) is not on origin/main — only what was merged into main is deployed. `
          + 'Check out a commit of main (git switch main && git pull) and run this again.\n',
        argv: 'never called',
      });
    });

    test('origin unreachable: the fetch fails → 1, the controller never called', () => {
      const w = world();
      git(w.checkout, 'remote', 'set-url', 'origin', join(w.remote, 'gone'));
      const r = run(w, []);
      expect([r.status, r.stderr.trimEnd().split('\n').at(-1), r.argv]).toEqual([
        1,
        'ERROR: cannot fetch origin main — without it, nothing proves HEAD is on main. Refusing.',
        'never called',
      ]);
    });

    test('resolve-incident does not fetch: it goes on with origin unreachable', () => {
      const w = world();
      git(w.checkout, 'remote', 'set-url', 'origin', join(w.remote, 'gone'));
      expect(run(w, ['--resolve-incident', '--flat'])).toEqual({
        status: 0, stderr: '', argv: ['--manual', 'resolve-incident', '--flat'],
      });
    });
  });

  describe('(д) the installed copy must be this checkout\'s controller, byte for byte', () => {
    test.each<[string[]]>([[[]], [['--resolve-incident', '--flat']]])('%j with a copy one byte off → 1', (args) => {
      const w = world();
      writeFileSync(w.installed, STUB.replace('exit', 'exiT'));
      expect(run(w, args)).toEqual({ status: 1, stderr: mismatch(w, 'differs from'), argv: 'never called' });
    });

    test.each<[string[]]>([[[]], [['--resolve-incident', '--flat']]])('%j with no installed copy → 1', (args) => {
      const w = world();
      const gone = join(w.installed, '..', 'missing');
      const r = run(w, args, { env: { WBB_INSTALLED_CONTROLLER: gone } });
      expect(r).toEqual({
        status: 1,
        stderr: mismatch({ ...w, installed: gone }, 'does not exist, so it is not'),
        argv: 'never called',
      });
    });
  });

  describe('(е) the script finds its own checkout', () => {
    test('run from another cwd (/) by its path', () => {
      const w = world();
      expect(run(w, [], { cwd: '/', script: join(w.checkout, 'deploy/deploy.sh') })).toEqual({
        status: 0, stderr: '', argv: ['--manual', 'deploy', '--target', w.head],
      });
    });

    test('a copy outside any git checkout → 1', () => {
      const w = world();
      const loose = realpathSync(makeTempDirectory('wbb-wrap-loose-'));
      writeFileSync(join(loose, 'deploy.sh'), readFileSync(WRAPPER));
      writeFileSync(join(loose, 'autodeploy.sh'), STUB);
      expect(run(w, ['--resolve-incident', '--flat'], { cwd: '/', script: join(loose, 'deploy.sh') })).toEqual({
        status: 1,
        stderr: `ERROR: ${loose} is not inside a git checkout — run deploy.sh from a checkout of the repo (bash deploy/deploy.sh).\n`,
        argv: 'never called',
      });
    });
  });
});
