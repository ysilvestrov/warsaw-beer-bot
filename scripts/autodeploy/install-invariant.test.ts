import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const autodeploy = read('deploy/autodeploy.sh');
const unit = read('deploy/wbb-autodeploy.service');

/**
 * #527 — an installed copy has to be named in two places that nothing ties together: the pair list
 * in the controller's `installed_is_stale`, which decides what staleness MEANS, and an installer,
 * which decides what is actually put there. A copy named in one and missing from the other is either
 * never checked or never installed, and both failures are quiet. Since stage «в» the copies come from
 * two installers: install-autodeploy.sh (the controller and what it runs; one `install -m` line per
 * copy) and install-image.sh (the root helper; a FILES table of `"<source> <target> <mode>"` rows). The invariant: every pair
 * the controller checks is a row of one of them, installed exactly where the controller looks.
 */

/** install-autodeploy.sh's `install -m <mode> <source> "${OWNER[@]}" "$DEST<target>"` lines, as [source, target]. */
function installLines(installer: string): Array<[string, string]> {
  return [...read(installer).matchAll(/^install -m 0\d{3} (\S+) +"\$\{OWNER\[@\]\}" "\$DEST(\S+)"$/gm)].map((m) => [m[1], m[2]]);
}

/** install-image.sh's `"<source> <target> <mode>"` rows of its FILES table, as [source, target]. */
function rows(installer: string): Array<[string, string]> {
  const text = read(installer);
  const table = text.slice(text.indexOf('FILES=('), text.indexOf('\n)\n', text.indexOf('FILES=(')));
  const lib = /^LIB=(\S+)$/m.exec(text)?.[1] ?? '';
  return [...table.matchAll(/^\s*"(\S+)\s+(\S+)\s+0\d{3}"$/gm)].map((m) => [m[1], m[2].replace('$LIB', lib)]);
}

/** Where the controller looks for a copy: `$0` is the unit's ExecStart; a variable, its default. */
function lookedUpAt(expr: string): string {
  if (expr === '$0') return /^ExecStart=(\S+)$/m.exec(unit)?.[1] ?? '';
  const m = /^\$([A-Z_]+)(\/.*)?$/.exec(expr);
  const def = new RegExp(`^${m?.[1]}="\\$\\{WBB_[A-Z_]+:?-([^}]+)\\}"$`, 'm').exec(autodeploy);
  return `${def?.[1]}${m?.[2] ?? ''}`;
}

const block = autodeploy.slice(autodeploy.indexOf('installed_is_stale()'), autodeploy.indexOf('STALE_ADVICE='));
const declared = [...block.matchAll(/"(deploy\/[A-Za-z0-9._/-]+)=([^"]+)"/g)].map((m) => [m[1], lookedUpAt(m[2])]);
const installed = [...installLines('deploy/install-autodeploy.sh'), ...rows('deploy/install-image.sh')];

describe('every checked installed copy is installed where the controller looks', () => {
  it('the controller checks exactly these copies, at these paths', () => {
    // Pinned explicitly: without it the next test is vacuously green the moment a pair is deleted.
    expect(declared).toEqual([
      ['deploy/autodeploy.sh', '/usr/local/bin/wbb-autodeploy'],
      ['deploy/read-env.sh', '/usr/local/bin/wbb-read-env'],
      ['deploy/db-snapshot.sh', '/usr/local/bin/wbb-db-snapshot'],
      ['deploy/installed-current.sh', '/usr/local/bin/wbb-installed-current'],
      ['deploy/image/helper/wbb_image.py', '/usr/local/lib/wbb-image/wbb_image.py'],
      ['deploy/image/helper/bounded.py', '/usr/local/lib/wbb-image/bounded.py'],
      ['deploy/image/helper/wbb-image.sh', '/usr/local/libexec/wbb-image'],
      ['deploy/image/warsaw-beer-bot.container', '/usr/local/lib/wbb-image/warsaw-beer-bot.container'],
    ]);
  });

  // Plan п.14: the installer proves the install with installed-current and the controller's own pairs.
  it('install-autodeploy.sh checks, after installing, exactly the pairs the controller checks', () => {
    const pairs = [...read('deploy/install-autodeploy.sh').matchAll(/^\s+"(deploy\/[A-Za-z0-9._/-]+)=\$DEST(\S+)" \\?/gm)]
      .map((m) => [m[1], m[2].replace(/"? 2>&1\); then$/, '')]);
    expect(pairs).toEqual(declared);
  });

  it('an installer installs each of them, from that source to that path', () => {
    const key = ([s, t]: string[]) => `${s} -> ${t}`;
    const have = new Set(installed.map(key));
    expect(declared.map((d) => [key(d), have.has(key(d))])).toEqual(declared.map((d) => [key(d), true]));
  });
});
