import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GUARD = resolve(__dirname, '../../deploy/autodeploy-guard.sh');
const SHIPS = resolve(__dirname, '../../deploy/ships.sh');

const REAL_FILTER = [
  '+ /package.json',
  '+ /package-lock.json',
  '+ /tsconfig.json',
  '+ /src/***',
  '+ /scripts/***',
  '+ /deploy/***',
  '- *',
  '',
].join('\n');

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

function guard(repo: string, deployed: string, target: string, mainRef: string, env: Record<string, string> = {}) {
  try {
    const out = execFileSync('bash', [GUARD, repo, deployed, target, mainRef], {
      encoding: 'utf8',
      env: { ...process.env, WBB_SHIPS: SHIPS, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
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
  let tsconfigChange: string;
  let noFilterRepo: string;
  let noFilterBase: string;
  let noFilterHead: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'wbb-guard-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');

    basec = commit(repo, {
      'package.json': '{"name":"x","dependencies":{"undici":"^7.28.0"}}',
      'package-lock.json': '{"lockfileVersion":3}',
      'src/index.ts': 'export const a = 1;\n',
      'deploy/rsync-filter': REAL_FILTER,
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

    tsconfigChange = commit(repo, { 'tsconfig.json': '{"compilerOptions":{}}' }, 'tsconfig change');

    noFilterRepo = mkdtempSync(join(tmpdir(), 'wbb-guard-nofilter-'));
    git(noFilterRepo, 'init', '-q', '-b', 'main');
    git(noFilterRepo, 'config', 'user.email', 't@example.com');
    git(noFilterRepo, 'config', 'user.name', 'T');
    noFilterBase = commit(noFilterRepo, { 'package.json': '{}' }, 'base');
    noFilterHead = commit(noFilterRepo, { 'package.json': '{"v":2}' }, 'bump');
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

  it('ACCEPTS a diff that touches extension/package-lock.json — it never reaches the server', () => {
    // FLIPPED by #527. This used to REFUSE. The old test's intent — "the
    // allowlist is string equality, not a glob" — did not disappear: it moved
    // into ships.test.ts, which pins that a nested manifest is a different
    // file from the root one. What changed is the conclusion drawn from that:
    // a file that does not ship cannot restart the bot, so it is not a reason
    // to refuse a security patch.
    const r = guard(repo, withSrc, extensionLock, 'main');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ACCEPT');
    expect(r.out).toContain('extension/package-lock.json');
    expect(r.out).toMatch(/do not ship/);
  });

  it('ACCEPTS a diff that touches a nested package.json — also not shipped', () => {
    // FLIPPED by #527, same as the extensionLock case above. The old test's
    // intent — a nested manifest is a different file from the root one —
    // lives on in ships.test.ts's "anchors file rules at the root: a nested
    // manifest is a different file".
    const r = guard(repo, extensionLock, subPackage, 'main');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ACCEPT');
    expect(r.out).toContain('sub/package.json');
  });

  it('refuses a diff that touches tsconfig.json — it ships and is not a manifest', () => {
    const r = guard(repo, subPackage, tsconfigChange, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toContain('tsconfig.json');
  });

  it('replays 2026-08-28: a diff of only non-shipping paths is accepted and named', () => {
    // The measured incident, reduced to a fixture: seven paths, none of which
    // pass the filter, refused for three and a half days.
    const before = commit(repo, { 'package.json': '{"name":"x","dependencies":{"undici":"^7.28.0"}}' }, 'anchor');
    const after = commit(repo, {
      '.gitignore': 'tmp\n',
      'docs/extension-install-uk.md': 'doc\n',
      'extension/src/popup/popup.css': 'body{}\n',
      'spec.md': 'spec\n',
    }, 'extension-only merge');
    const r = guard(repo, before, after, 'main');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ACCEPT');
    expect(r.out).toMatch(/4 changed path\(s\) do not ship/);
  });

  it('REFUSES when the ships predicate is unavailable', () => {
    const r = guard(repo, basec, lockOnly, 'main', { WBB_SHIPS: '/nonexistent/wbb-ships' });
    expect(r.code).toBe(1);
    // Unique to the classify-failure branch: no other REFUSE message in the
    // guard contains the literal substring "classify" (the unexpected-line
    // branch says "classification", which does not contain it), and
    // ships.sh itself never emits the word.
    expect(r.out).toMatch(/classify/i);
  });

  it('REFUSES when the ships predicate emits an unexpected classification line', () => {
    // Defends the `*)` arm in the classification loop against a WBB_SHIPS
    // binary whose output format does not match SHIP/SKIP — e.g. an
    // incompatible version installed out of step with the guard.
    const stubDir = mkdtempSync(join(tmpdir(), 'wbb-guard-stub-'));
    const stub = join(stubDir, 'bogus-ships.sh');
    writeFileSync(stub, '#!/usr/bin/env bash\ncat >/dev/null\necho "MAYBE package.json"\n');
    chmodSync(stub, 0o755);
    const r = guard(repo, basec, lockOnly, 'main', { WBB_SHIPS: stub });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/unexpected classification/i);
  });

  it('REFUSES when the target carries no deploy/rsync-filter', () => {
    // Tightened after fix-round 1/5: /rsync-filter/ alone also matches the
    // classify-failure branch's message ("could not classify the diff
    // against <target>:deploy/rsync-filter"), so a mutant that no-ops the
    // `git show` failure check still passed this test via that other
    // branch's wording. This phrase is unique to the git-show branch.
    const r = guard(noFilterRepo, noFilterBase, noFilterHead, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/carries no deploy\/rsync-filter/);
  });

  it('C1: refuses a bogus deployed sha instead of silently accepting', () => {
    const r = guard(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', lockOnly, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/does not resolve/);
  });
});
