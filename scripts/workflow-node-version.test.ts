import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// #458. "CI runs what production runs" lived as a comment in ci.yml, and a comment
// cannot go red: production moved to Node 24 while five workflows still pinned 20,
// and nothing in the suite noticed. package.json's engines.node is the declaration;
// this test makes every workflow agree with it.
const root = path.join(__dirname, '..');

function declaredMajor(): number {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const floor = /^>=(\d+)/.exec(pkg.engines.node);
  if (!floor) throw new Error(`engines.node is not a ">=N" floor: ${pkg.engines.node}`);
  return Number(floor[1]);
}

function pins(): { file: string; major: number }[] {
  const dir = path.join(root, '.github/workflows');
  const found: { file: string; major: number }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    // Matches `node-version: 20` and matrix legs `- node: 20`. An expression such
    // as `node-version: ${{ matrix.node }}` carries no digit and is skipped — the
    // matrix entry it resolves to is caught by the same regex.
    for (const m of text.matchAll(/^\s*(?:-\s*)?node(?:-version)?:\s*['"]?(\d+)/gm)) {
      found.push({ file, major: Number(m[1]) });
    }
  }
  return found;
}

test('every workflow pins the Node major that package.json declares', () => {
  const expected = declaredMajor();
  const found = pins();

  // Anti-vacuity: a regex that matches nothing would make this test pass forever
  // while checking nothing at all.
  expect(found.length).toBeGreaterThanOrEqual(5);

  expect(found.filter((p) => p.major !== expected)).toEqual([]);
});
