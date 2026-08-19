import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GUARD = resolve(__dirname, '../../deploy/autodeploy-guard.sh');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [path, body] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function guard(repo: string, deployed: string, target: string, mainRef: string) {
  try {
    const out = execFileSync('bash', [GUARD, repo, deployed, target, mainRef], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

describe('autodeploy-guard.sh', () => {
  let repo: string;
  let basec: string;
  let lockOnly: string;
  let withSrc: string;
  let offMain: string;
  let extensionLock: string;
  let subPackage: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'wbb-guard-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');

    basec = commit(repo, {
      'package.json': '{"name":"x","dependencies":{"undici":"^7.28.0"}}',
      'package-lock.json': '{"lockfileVersion":3}',
      'src/index.ts': 'export const a = 1;\n',
    }, 'base');

    lockOnly = commit(repo, {
      'package.json': '{"name":"x","dependencies":{"undici":"^7.29.0"}}',
      'package-lock.json': '{"lockfileVersion":3,"bumped":true}',
    }, 'bump');

    withSrc = commit(repo, { 'src/index.ts': 'export const a = 2;\n' }, 'code change');

    git(repo, 'checkout', '-q', '-b', 'side', basec);
    offMain = commit(repo, { 'package-lock.json': '{"lockfileVersion":3,"evil":true}' }, 'off main');
    git(repo, 'checkout', '-q', 'main');

    // I1: these two stay ON main (not a side branch) so the diff each test
    // exercises is a clean single-file change — the allowlist arm is exact
    // string equality (`package.json|package-lock.json`), not a glob, and
    // these pin that against a future `*package.json|*package-lock.json`
    // regression (see the mutation proof in the fix-wave report).
    extensionLock = commit(
      repo,
      { 'extension/package-lock.json': '{"lockfileVersion":3}' },
      'extension lockfile bump',
    );
    subPackage = commit(repo, { 'sub/package.json': '{}' }, 'nested package.json');
  });

  it('accepts a lockfile-only diff that is on main', () => {
    const r = guard(repo, basec, lockOnly, 'main');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ACCEPT');
  });

  it('refuses a diff that touches src/', () => {
    const r = guard(repo, basec, withSrc, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/index.ts');
  });

  it('refuses a commit that is not an ancestor of main', () => {
    const r = guard(repo, basec, offMain, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ancestor/i);
  });

  it('REFUSES a tag behind the deployed commit — a downgrade, not a fix', () => {
    // The shape that actually occurred on the first unattended run: a stale tag
    // (git fetch --prune does NOT prune tags) pointed at an older commit. The
    // allowlist caught it only because rolling back happened to touch unrelated
    // files; a downgrade whose diff is lockfile-only must be refused on its own
    // merit, since it would quietly reinstall the vulnerable versions.
    const r = guard(repo, lockOnly, basec, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/downgrade/i);
  });

  it('accepts an empty diff (nothing to deploy is not a violation)', () => {
    const r = guard(repo, lockOnly, lockOnly, 'main');
    expect(r.code).toBe(0);
  });

  it('refuses a diff that touches extension/package-lock.json (not the same file as the root lockfile)', () => {
    const r = guard(repo, withSrc, extensionLock, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toContain('extension/package-lock.json');
  });

  it('refuses a diff that touches a nested package.json', () => {
    const r = guard(repo, extensionLock, subPackage, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toContain('sub/package.json');
  });

  it('C1: refuses a bogus deployed sha instead of silently accepting', () => {
    const r = guard(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', lockOnly, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/does not resolve/);
  });
});
