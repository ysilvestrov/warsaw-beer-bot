import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// #458. "CI runs what production runs" lived as a comment in ci.yml, and a comment
// cannot go red: production moved to Node 24 while five workflows still pinned 20,
// and nothing in the suite noticed. package.json's engines.node is the declaration;
// this test makes every workflow agree with it.
//
// The anti-vacuity check has moved four times, each time because the previous shape
// could be satisfied while covering less:
//   1. a global floor (found.length >= 5) — didn't notice one workflow losing its
//      only pin as long as the file-wide total stayed up;
//   2. "at least one pin per file" — didn't notice a SECOND actions/setup-node step
//      in an already-covered file going unpinned (node-version-file:, or a flow-list
//      matrix with no bare digit), because the first step's pin kept the file count
//      non-zero;
//   3. "pins >= actions/setup-node occurrences, per file" — still a pair of file-wide
//      totals, not an association, so it broke two more ways at once: a SURPLUS pin
//      elsewhere in the file (ci.yml's two matrix legs) could cover an unrelated
//      unpinned step (a false negative — the dangerous direction), and a plain-text
//      occurrence of the substring "actions/setup-node" in a YAML *comment* inflated
//      the step count against an unchanged pin count (a false positive).
// The unit that is actually honest is the STEP: each `actions/setup-node` step is
// found individually and its OWN `with:` block is checked for a version key. A
// comment can never match, because the step-detection regex anchors on `uses:`
// being the line's first token (after an optional `- `) — a `#`-prefixed line never
// starts with `uses:`. A step's pin is never "covered" by a pin that lives in a
// different step or a different job, because coverage is decided from that step's
// own block (and, for a matrix expression, from a matrix key resolved within that
// step's own job) rather than from a file-wide count.
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

function fileLines(file: string): string[] {
  return readFileSync(path.join(root, '.github/workflows', file), 'utf8').split('\n');
}

// A step is a YAML sequence item; only its FIRST key carries the `- `. `uses:
// actions/setup-node@v7` is either that first key (`- uses: ...`) or a later
// sibling key of the same step (`- name: ...` then a plain `uses: ...` below it, as
// codex-review.yml writes it) — both are matched, a comment mentioning the action
// name never is, because the regex requires `uses:` as the line's own first token.
const STEP_LINE = /^(\s*)(-\s+)?uses:\s*actions\/setup-node(?:@|\s|$)/;

function setupNodeSteps(lines: string[]): { line: number; startIdx: number; column: number }[] {
  const steps: { line: number; startIdx: number; column: number }[] = [];
  lines.forEach((raw, idx) => {
    const m = STEP_LINE.exec(raw);
    if (!m) return;
    // `column` is where this step's key TEXT begins — the same column whether this
    // line carries the leading `- ` or is a dash-less sibling of a key that did,
    // since `- ` occupies exactly the width it indents past. That is what lets the
    // block scan below treat both step shapes identically.
    const column = m[1].length + (m[2]?.length ?? 0);
    steps.push({ line: idx + 1, startIdx: idx, column });
  });
  return steps;
}

// The lines belonging to a step: everything after it indented at or past the
// step's own column (sibling keys land exactly on it, nested map/list content past
// it), stopping at the first line that dedents below that column — which is either
// the next step's `- ` or the end of the `steps:` list. Blank lines don't decide
// anything either way and are skipped rather than treated as a dedent.
function stepBlock(lines: string[], startIdx: number, column: number): string[] {
  const block: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent < column) break;
    block.push(raw);
  }
  return block;
}

// Job boundaries (top-level keys directly under `jobs:`), so a matrix expression is
// resolved against ITS OWN job only. Without this scoping, a flow-list matrix
// (`node-version: [20, 24]`, no digit — deliberately unpinned) could be "resolved"
// by a same-named `node-version:` pin sitting in a completely different job's
// `with:` block, which is not a resolution at all — it is coincidence.
function jobRanges(lines: string[]): { start: number; end: number }[] {
  const starts: number[] = [];
  let inJobs = false;
  lines.forEach((raw, idx) => {
    if (/^jobs:\s*$/.test(raw)) {
      inJobs = true;
      return;
    }
    if (inJobs && /^  [\w-]+:\s*$/.test(raw)) starts.push(idx);
  });
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? lines.length }));
}

function jobRangeFor(lines: string[], idx: number): { start: number; end: number } {
  const ranges = jobRanges(lines);
  return ranges.find((r) => idx >= r.start && idx < r.end) ?? { start: 0, end: lines.length };
}

// A numeric value for `key:` (matrix legs use the bare key, e.g. `node: 24`) found
// anywhere within [start, end) — the caller passes a single job's range.
function numericValuesFor(lines: string[], key: string, start: number, end: number): number[] {
  const re = new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*['"]?(\\d+)`);
  const values: number[] = [];
  for (let i = start; i < end; i++) {
    const m = re.exec(lines[i]);
    if (m) values.push(Number(m[1]));
  }
  return values;
}

function stepCoverage(
  lines: string[],
  step: { startIdx: number; column: number },
): { covered: boolean } {
  const block = stepBlock(lines, step.startIdx, step.column);
  const versionLine = /^\s*(node-version(-file)?):\s*(.+?)\s*$/;
  for (const raw of block) {
    const m = versionLine.exec(raw);
    if (!m) continue;
    if (m[2]) return { covered: false }; // node-version-file: — no numeric pin, ever.
    const value = m[3].replace(/^['"]|['"]$/g, '');
    if (/^\d+$/.test(value)) return { covered: true }; // literal number.
    const matrixRef = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(value);
    if (matrixRef) {
      const { start, end } = jobRangeFor(lines, step.startIdx);
      const values = numericValuesFor(lines, matrixRef[1], start, end);
      return { covered: values.length > 0 };
    }
    return { covered: false }; // e.g. a flow list `[20, 24]`, or any other expression.
  }
  return { covered: false }; // no version key in this step's block at all.
}

function pinsIn(file: string): number[] {
  const text = readFileSync(path.join(root, '.github/workflows', file), 'utf8');
  // Matches `node-version: 20` and matrix legs `- node: 20`. An expression such
  // as `node-version: ${{ matrix.node }}` carries no digit and is skipped — the
  // matrix entry it resolves to is caught by the same regex. This is the file-wide
  // "does every pin equal engines.node's major" check, unchanged since it introduced
  // no false pass/fail of its own — only the per-step coverage check above did.
  return [...text.matchAll(/^\s*(?:-\s*)?node(?:-version)?:\s*['"]?(\d+)/gm)].map((m) =>
    Number(m[1]),
  );
}

test('every workflow pins the Node major that package.json declares', () => {
  const expected = declaredMajor();
  const files = workflowFiles();

  const nodeWorkflows = files.filter((f) => setupNodeSteps(fileLines(f)).length > 0);
  // Anti-vacuity: a workflow with no `actions/setup-node` step legitimately pins no
  // Node (e.g. autodeploy-tag.yml) and is skipped — but that exemption is derived
  // from the file's own content, not a hand-maintained list that would rot.
  expect(nodeWorkflows.length).toBeGreaterThanOrEqual(5);

  const uncovered: { file: string; line: number }[] = [];
  for (const file of nodeWorkflows) {
    const lines = fileLines(file);
    for (const step of setupNodeSteps(lines)) {
      if (!stepCoverage(lines, step).covered) uncovered.push({ file, line: step.line });
    }
  }

  const mismatched: { file: string; major: number }[] = [];
  for (const file of nodeWorkflows) {
    for (const major of pinsIn(file)) {
      if (major !== expected) mismatched.push({ file, major });
    }
  }

  // A step whose own `with:` block carries no numeric pin — `node-version-file:`,
  // a flow-list matrix, or no version key at all — is a coverage gap, not a pass,
  // no matter how many pins exist elsewhere in the file.
  expect(uncovered).toEqual([]);
  expect(mismatched).toEqual([]);
});
