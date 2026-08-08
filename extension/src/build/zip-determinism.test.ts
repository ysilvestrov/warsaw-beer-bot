// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '..', '..', 'scripts', 'zip-dist.py');

function build(src: string, out: string): string {
  execFileSync('python3', [script], {
    env: { ...process.env, ZIP_DIST_SRC: src, ZIP_DIST_OUT: out },
  });
  return createHash('sha256').update(readFileSync(out)).digest('hex');
}

describe('zip-dist determinism', () => {
  it('produces a byte-identical zip for identical content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zipdet-'));
    const src = join(dir, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'z.txt'), 'zeta');
    writeFileSync(join(src, 'b.txt'), 'beta');
    writeFileSync(join(src, 'sub', 'a.txt'), 'alpha');

    const first = build(src, join(dir, 'first.zip'));
    const second = build(src, join(dir, 'second.zip'));
    expect(first).toBe(second);
  });
});

describe('zip-dist naming', () => {
  it('gives the store build its own filename so it cannot overwrite the dev zip', () => {
    // Hermetic: copy zip-dist.py + a minimal package.json into a temp dir and run it
    // from there, so the script's own EXT_ROOT (dirname of dirname(__file__)) resolves
    // to the temp dir and the default OUT path lands there too. This still exercises the
    // real DEFAULT output path (no ZIP_DIST_OUT override) — the whole point of the test —
    // without ever writing to, or deleting from, the real extension/ directory, which
    // holds real build zips; determinism keeps rebuilds byte-identical (reproducible builds).
    const dir = mkdtempSync(join(tmpdir(), 'zipname-'));
    const scriptsDir = join(dir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    const copiedScript = join(scriptsDir, 'zip-dist.py');
    copyFileSync(script, copiedScript);

    const version = '9.9.9-test';
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));

    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'alpha');

    const storeZip = join(dir, `warsaw-beer-overlay-${version}-store.zip`);

    // No ZIP_DIST_OUT: this exercises the DEFAULT output path the npm scripts rely on.
    execFileSync('python3', [copiedScript], {
      env: { ...process.env, ZIP_DIST_SRC: src, CWS_BUILD: '1' },
    });

    expect(existsSync(storeZip)).toBe(true);
  });
});

describe('package.json npm script wiring', () => {
  it('propagates CWS_BUILD=1 to the zip-dist.py invocation itself, not just to vite build', () => {
    // A leading `VAR=value` in a POSIX `&&` chain scopes to ONLY the single command it
    // prefixes, not to the rest of the chain: `sh -c 'FOO=1 true && echo "[${FOO}]"'`
    // prints `[]`. If `package:store` only prefixes `vite build`, zip-dist.py never sees
    // CWS_BUILD, its SUFFIX stays empty, and `npm run package:store` silently overwrites
    // the dev zip again — the exact bug this feature exists to fix. This test is the only
    // guard standing between us and that regression sneaking back in.
    const extRoot = resolve(here, '..', '..');
    const pkg = JSON.parse(
      readFileSync(join(extRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const packageStoreScript = pkg.scripts['package:store'];
    expect(packageStoreScript).toBeDefined();

    const zipDistCommand = packageStoreScript
      .split('&&')
      .map((segment) => segment.trim())
      .find((segment) => segment.includes('zip-dist.py'));

    expect(zipDistCommand).toBeDefined();
    expect(zipDistCommand).toMatch(/^CWS_BUILD=1\s/);
  });
});
