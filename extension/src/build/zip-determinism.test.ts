// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
