import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// #458. "CI runs what production runs" lived as a comment in ci.yml, and a comment
// cannot go red: production moved to Node 24 while five workflows still pinned 20,
// and nothing in the suite noticed. package.json's engines.node is the declaration;
// this test makes every workflow agree with it.
//
// The anti-vacuity check used to be a global floor (found.length >= 5), but a global
// count cannot notice coverage shrinking as long as the total stays above it: if one
// workflow switched from a bare-digit pin to `node-version-file: .nvmrc`, the count
// would drop by one and the floor would still pass — that workflow would silently
// stop being checked. So the check is per file instead: every workflow that sets up
// Node at all must contribute a numeric pin, or the test fails naming that file.
const root = path.join(__dirname, '..');

function declaredMajor(): number {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const floor = /^>=(\d+)/.exec(pkg.engines.node);
  if (!floor) throw new Error(`engines.node is not a ">=N" floor: ${pkg.engines.node}`);
  return Number(floor[1]);
}

function workflowFiles(): string[] {
  const dir = path.join(root, '.github/workflows');
  return readdirSync(dir).filter((f) => f.endsWith('.yml'));
}

function pinsIn(file: string): number[] {
  const text = readFileSync(path.join(root, '.github/workflows', file), 'utf8');
  // Matches `node-version: 20` and matrix legs `- node: 20`. An expression such
  // as `node-version: ${{ matrix.node }}` carries no digit and is skipped — the
  // matrix entry it resolves to is caught by the same regex.
  return [...text.matchAll(/^\s*(?:-\s*)?node(?:-version)?:\s*['"]?(\d+)/gm)].map((m) =>
    Number(m[1]),
  );
}

function setsUpNode(file: string): boolean {
  const text = readFileSync(path.join(root, '.github/workflows', file), 'utf8');
  return text.includes('actions/setup-node');
}

test('every workflow pins the Node major that package.json declares', () => {
  const expected = declaredMajor();
  const files = workflowFiles();

  // Anti-vacuity: a workflow with no `actions/setup-node` reference legitimately
  // pins no Node (e.g. autodeploy-tag.yml) and is skipped — but that exemption is
  // derived from the file's own content, not a hand-maintained list that would rot.
  const nodeWorkflows = files.filter(setsUpNode);
  expect(nodeWorkflows.length).toBeGreaterThanOrEqual(5);

  const badFiles: string[] = [];
  const mismatched: { file: string; major: number }[] = [];
  for (const file of nodeWorkflows) {
    const majors = pinsIn(file);
    if (majors.length === 0) {
      badFiles.push(file);
      continue;
    }
    for (const major of majors) {
      if (major !== expected) mismatched.push({ file, major });
    }
  }

  // A file that sets up Node but yields no numeric pin (e.g. `node-version-file:
  // .nvmrc`) is a coverage gap, not a pass.
  expect(badFiles).toEqual([]);
  expect(mismatched).toEqual([]);
});
