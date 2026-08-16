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

  it('accepts an empty diff (nothing to deploy is not a violation)', () => {
    const r = guard(repo, lockOnly, lockOnly, 'main');
    expect(r.code).toBe(0);
  });
});
