import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// #458. "CI runs what production runs" lived as a comment in ci.yml, and a comment
// cannot go red: production moved to Node 24 while five workflows still pinned 20,
// and nothing in the suite noticed. package.json's engines.node is the declaration;
// this test makes every workflow agree with it.
//
// The anti-vacuity check used to be a global floor (found.length >= 5), then a
// per-file "at least one pin" rule — both drifted into passing while covering
// less: a global count doesn't notice one workflow losing its only pin as long as
// the total stays up, and "at least one pin per file" doesn't notice a SECOND
// `actions/setup-node` step in the same file going unpinned once the first step
// already satisfies it. So the unit is the step, counted per file: a file's total
// numeric pins must be at least its total `actions/setup-node` occurrences, or the
// test fails naming the file with both counts. `.yaml` is accepted alongside
// `.yml` — GitHub Actions reads both, and a workflow the guard can't see is a
// workflow it isn't checking.
const root = path.join(__dirname, '..');

function declaredMajor(): number {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const floor = /^>=(\d+)/.exec(pkg.engines.node);
  if (!floor) throw new Error(`engines.node is not a ">=N" floor: ${pkg.engines.node}`);
  return Number(floor[1]);
}

function workflowFiles(): string[] {
  const dir = path.join(root, '.github/workflows');
  return readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}

function pinsIn(file: string): number[] {
  const text = readFileSync(path.join(root, '.github/workflows', file), 'utf8');
  // Matches `node-version: 20` and matrix legs `- node: 20`. An expression such
  // as `node-version: ${{ matrix.node }}` carries no digit and is skipped — the
  // matrix entry it resolves to is caught by the same regex. A flow-list matrix
  // (`node-version: [20, 24]`) also carries no digit directly after the colon and
  // is deliberately NOT parsed as a pin — its step still counts against the file
  // via setupNodeCount below, so an unpinned flow-list leg shows up as a shortfall
  // rather than silently passing.
  return [...text.matchAll(/^\s*(?:-\s*)?node(?:-version)?:\s*['"]?(\d+)/gm)].map((m) =>
    Number(m[1]),
  );
}

function setsUpNode(file: string): boolean {
  return setupNodeCount(file) > 0;
}

function setupNodeCount(file: string): number {
  const text = readFileSync(path.join(root, '.github/workflows', file), 'utf8');
  return (text.match(/actions\/setup-node/g) ?? []).length;
}

test('every workflow pins the Node major that package.json declares', () => {
  const expected = declaredMajor();
  const files = workflowFiles();

  // Anti-vacuity: a workflow with no `actions/setup-node` reference legitimately
  // pins no Node (e.g. autodeploy-tag.yml) and is skipped — but that exemption is
  // derived from the file's own content, not a hand-maintained list that would rot.
  const nodeWorkflows = files.filter(setsUpNode);
  expect(nodeWorkflows.length).toBeGreaterThanOrEqual(5);

  const shortfalls: { file: string; pins: number; steps: number }[] = [];
  const mismatched: { file: string; major: number }[] = [];
  for (const file of nodeWorkflows) {
    const majors = pinsIn(file);
    const steps = setupNodeCount(file);
    if (majors.length < steps) {
      shortfalls.push({ file, pins: majors.length, steps });
    }
    for (const major of majors) {
      if (major !== expected) mismatched.push({ file, major });
    }
  }

  // A file with fewer numeric pins than `actions/setup-node` steps has at least
  // one unpinned (or unparseable-pin) step — e.g. a second job using
  // `node-version-file: .nvmrc` or a flow-list matrix — and that is a coverage
  // gap, not a pass.
  expect(shortfalls).toEqual([]);
  expect(mismatched).toEqual([]);
});
