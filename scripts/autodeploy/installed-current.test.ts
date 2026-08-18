import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHECK = resolve(__dirname, '../../deploy/installed-current.sh');

/**
 * #435 — a merged fix is not a live fix.
 *
 * /usr/local/bin holds COPIES on purpose: the running deployer must not change
 * under a `git checkout` in the operator's working tree. The same property
 * means a merged fix stays dead until someone installs it, and nothing said
 * so. MEASURED 2026-08-18: a guard fix was merged while the timer kept running
 * the old copy — caught by memory, not by the system.
 */

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function check(repo: string, ref: string, pairs: string[]) {
  try {
    return { code: 0, out: execFileSync('bash', [CHECK, repo, ref, ...pairs], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

describe('installed-current.sh', () => {
  let repo: string;
  let installed: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'wbb-cur-repo-'));
    installed = mkdtempSync(join(tmpdir(), 'wbb-cur-bin-'));

    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    mkdirSync(join(repo, 'deploy'));
    writeFileSync(join(repo, 'deploy', 'a.sh'), '#!/bin/sh\necho A v2\n');
    writeFileSync(join(repo, 'deploy', 'b.sh'), '#!/bin/sh\necho B\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'v2');

    // The installed copies: `a` is stale (v1), `b` matches.
    writeFileSync(join(installed, 'a'), '#!/bin/sh\necho A v1\n');
    writeFileSync(join(installed, 'b'), '#!/bin/sh\necho B\n');
    chmodSync(join(installed, 'a'), 0o755);
    chmodSync(join(installed, 'b'), 0o755);
  });

  it('reports CURRENT when every copy matches the ref', () => {
    const r = check(repo, 'main', [`deploy/b.sh=${join(installed, 'b')}`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('CURRENT');
  });

  it('reports STALE, and names the file, when a copy is out of date', () => {
    // The regression that matters: byte-identical content is the ONLY thing
    // that means "installed". A merged fix that was never installed looks
    // exactly like a working system.
    const r = check(repo, 'main', [`deploy/a.sh=${join(installed, 'a')}`]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('STALE');
    expect(r.out).toContain('deploy/a.sh');
  });

  it('names only the stale file when others are current', () => {
    const r = check(repo, 'main', [
      `deploy/a.sh=${join(installed, 'a')}`,
      `deploy/b.sh=${join(installed, 'b')}`,
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('deploy/a.sh');
    expect(r.out).not.toContain('deploy/b.sh');
  });

  it('treats a copy that is not installed at all as stale', () => {
    const r = check(repo, 'main', [`deploy/b.sh=${join(installed, 'nope')}`]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not installed/);
  });

  it('names a file absent from the ref as absent, not merely different', () => {
    const r = check(repo, 'main', [`deploy/ghost.sh=${join(installed, 'b')}`]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/absent from main/);
  });

  it('is STALE for an EMPTY installed copy of a path absent from the ref', () => {
    // The case that would pass silently if `pipefail` were ever dropped from
    // installed-current.sh: `git show` on a missing path produces nothing, and
    // nothing compares equal to an empty file. `pipefail` is what refuses;
    // the explicit absent-check only supplies the reason.
    writeFileSync(join(installed, 'empty'), '');
    const r = check(repo, 'main', [`deploy/ghost.sh=${join(installed, 'empty')}`]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/absent from main/);
  });
});
