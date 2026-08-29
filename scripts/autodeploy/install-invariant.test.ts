import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const autodeploy = readFileSync(resolve(__dirname, '../../deploy/autodeploy.sh'), 'utf8');
const installer = readFileSync(resolve(__dirname, '../../deploy/install-autodeploy.sh'), 'utf8');

/**
 * #527 — a fifth installed file is a fifth way to be silently stale, and it
 * has to be added in two files that nothing ties together: the pair list in
 * `installed_is_stale`, which decides what staleness MEANS, and the installer,
 * which decides what is actually put there. A copy named in one and missing
 * from the other is either never checked or never installed, and both failures
 * are quiet.
 */
describe('every checked installed copy is actually installed', () => {
  const block = autodeploy.slice(autodeploy.indexOf('installed_is_stale()'));
  const declared = [
    ...new Set([...block.matchAll(/"(deploy\/[A-Za-z0-9._/-]+)=/g)].map((m) => m[1])),
  ];

  it('names the four original scripts and ships.sh', () => {
    // Pinned explicitly. Without this the loop below is vacuously green the
    // moment a pair is deleted from the list.
    expect(declared).toContain('deploy/autodeploy.sh');
    expect(declared).toContain('deploy/autodeploy-guard.sh');
    expect(declared).toContain('deploy/read-env.sh');
    expect(declared).toContain('deploy/installed-current.sh');
    expect(declared).toContain('deploy/ships.sh');
  });

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // A bare substring search would treat a commented-out line — e.g.
  // `# TODO: install deploy/ships.sh` — as proof the file is installed.
  // Require an actual install command: first non-whitespace token is
  // `install`, and it carries the source path as a whole word.
  function installsPath(path: string): boolean {
    return installer.split('\n').some((line) => {
      const trimmed = line.trimStart();
      if (!/^install\b/.test(trimmed)) return false;
      return new RegExp(`(^|\\s)${escapeRegExp(path)}(\\s|$)`).test(trimmed);
    });
  }

  it('installs every declared copy', () => {
    for (const path of declared) expect(installsPath(path)).toBe(true);
  });
});
