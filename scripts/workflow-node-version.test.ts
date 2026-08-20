import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// #458. "CI runs what production runs" lived as a comment in ci.yml, and a comment
// cannot go red: production moved to Node 24 while five workflows still pinned 20,
// and nothing in the suite noticed. package.json's engines.node is the declaration;
// this test makes every workflow agree with it.
//
// The anti-vacuity check has moved six times, each time because the previous shape
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
//      unpinned step (a false negative), and a plain-text occurrence of the
//      substring "actions/setup-node" in a YAML *comment* inflated the step count
//      against an unchanged pin count (a false positive);
//   4. per-step association, but scanning only FORWARD from the `uses:` line — didn't
//      notice a `with:` block written ABOVE `uses:` in the same step. YAML mapping
//      key order carries no semantics, so that is ordinary valid YAML, not a
//      contrived shape, and the guard blocked a correctly-pinned step while
//      reporting something false. Coverage became a property of the step's whole
//      BLOCK (boundaries found first, content searched anywhere inside), not of a
//      scan direction from one line within it;
//   5. matrix resolution treated "at least one numeric value for the matrix key" as
//      coverage. A matrix with `include` entries `- node: 24` and `- node: lts/*`
//      yields one numeric value, so the `lts/*` leg — a real job that runs
//      `setup-node` on an unpinned version — passed unnoticed, and `pinsIn` never
//      caught it either, because `lts/*` is not numeric and never becomes a pin. A
//      matrix-resolved step is now covered only when EVERY value of that matrix key
//      is numeric; a key with any non-numeric leg — `lts/*`, `latest`, an
//      expression, an empty value — makes the step uncovered, and the failure names
//      the offending value.
//
// Known limitation, shared by every version of this guard above: it is a line-based
// scan, not a YAML parser. A `run: |` literal block whose text happens to contain a
// line reading like `uses: actions/setup-node@v7` or `node-version: N` is scanned
// as if it were real YAML and can produce a spurious finding. Parsing block scalars
// correctly would need an actual YAML parser, which is out of proportion here.
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

type Block = { startIdx: number; endIdx: number };

// Every YAML sequence item (`- ...`) is a candidate step. A step's boundaries are
// its own `- ` line through the line before the next one indented at or below it —
// which is exactly where the next sibling item (or the end of the list) starts.
// Blank lines don't decide anything and are skipped rather than treated as a dedent.
function listItemBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  const dashLine = /^(\s*)-\s/;
  for (let i = 0; i < lines.length; i++) {
    const m = dashLine.exec(lines[i]);
    if (!m) continue;
    const dashIndent = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      const indent = lines[j].length - lines[j].trimStart().length;
      if (indent <= dashIndent) {
        end = j;
        break;
      }
    }
    blocks.push({ startIdx: i, endIdx: end });
  }
  return blocks;
}

// `uses:` is either the block's own first key (`- uses: ...`) or a later sibling
// key of the same step (`- name: ...` then a plain `uses: ...` below it, as
// codex-review.yml writes it) — both match. A YAML comment never does: the regex
// requires `uses:` as the line's own first token, which a `#`-prefixed line isn't.
const USES_LINE = /^(?:-\s+)?uses:\s*actions\/setup-node(?:@|\s|$)/;

function usesLineIn(lines: string[], block: Block): number | null {
  for (let i = block.startIdx; i < block.endIdx; i++) {
    if (USES_LINE.test(lines[i].trimStart())) return i;
  }
  return null;
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

// EVERY value assigned to `key:` within [start, end) — matrix legs use the bare key
// (e.g. `node: 24`, `node: lts/*`) — not just the numeric ones. Coverage below
// needs to see a non-numeric leg to reject it, not silently skip past it.
function allValuesFor(lines: string[], key: string, start: number, end: number): string[] {
  const re = new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*(.+?)\\s*$`);
  const values: string[] = [];
  for (let i = start; i < end; i++) {
    const m = re.exec(lines[i]);
    if (m) values.push(m[1].replace(/^['"]|['"]$/g, ''));
  }
  return values;
}

// Coverage is decided from the step's whole block — every line between its
// boundaries — not from a position relative to the `uses:` line found within it.
// That is what makes `with:` written above `uses:` behave the same as below it.
function stepCoverage(lines: string[], block: Block): { covered: boolean; badValue?: string } {
  const versionLine = /^\s*(node-version(-file)?):\s*(.+?)\s*$/;
  for (let i = block.startIdx; i < block.endIdx; i++) {
    const m = versionLine.exec(lines[i]);
    if (!m) continue;
    if (m[2]) return { covered: false }; // node-version-file: — no numeric pin, ever.
    const value = m[3].replace(/^['"]|['"]$/g, '');
    if (/^\d+$/.test(value)) return { covered: true }; // literal number.
    const matrixRef = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(value);
    if (matrixRef) {
      const { start, end } = jobRangeFor(lines, block.startIdx);
      const values = allValuesFor(lines, matrixRef[1], start, end);
      if (values.length === 0) return { covered: false }; // matrix key never found.
      // Covered only when EVERY leg of the matrix key is numeric — one non-numeric
      // leg (lts/*, latest, an expression, empty) is a real job that will run
      // setup-node unpinned, not a value the mismatch check below can ever see:
      // pinsIn only matches digits, so a non-numeric leg never becomes a pin and
      // silently passing "at least one numeric value" would miss it entirely.
      const bad = values.find((v) => !/^\d+$/.test(v));
      if (bad !== undefined) return { covered: false, badValue: bad };
      return { covered: true }; // every leg numeric; each one is caught by pinsIn.
    }
    return { covered: false }; // e.g. a flow list `[20, 24]`, or any other expression.
  }
  return { covered: false }; // no version key in this step's block at all.
}

function setupNodeSteps(lines: string[]): { line: number; block: Block }[] {
  const steps: { line: number; block: Block }[] = [];
  for (const block of listItemBlocks(lines)) {
    const usesIdx = usesLineIn(lines, block);
    if (usesIdx !== null) steps.push({ line: usesIdx + 1, block });
  }
  return steps;
}

function pinsIn(file: string): number[] {
  const text = readFileSync(path.join(root, '.github/workflows', file), 'utf8');
  // Matches `node-version: 20` and matrix legs `- node: 20`. An expression such
  // as `node-version: ${{ matrix.node }}` carries no digit and is skipped — the
  // matrix entry it resolves to is caught by the same regex. This is the file-wide
  // "does every pin equal engines.node's major" check, unchanged since it introduced
  // no false pass/fail of its own — only the step-coverage check above did.
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

  const uncovered: { file: string; line: number; value?: string }[] = [];
  for (const file of nodeWorkflows) {
    const lines = fileLines(file);
    for (const step of setupNodeSteps(lines)) {
      const result = stepCoverage(lines, step.block);
      if (!result.covered) {
        uncovered.push(
          result.badValue !== undefined
            ? { file, line: step.line, value: result.badValue }
            : { file, line: step.line },
        );
      }
    }
  }

  const mismatched: { file: string; major: number }[] = [];
  for (const file of nodeWorkflows) {
    for (const major of pinsIn(file)) {
      if (major !== expected) mismatched.push({ file, major });
    }
  }

  // A step whose own block carries no numeric pin — `node-version-file:`, a
  // flow-list matrix, a matrix key with any non-numeric leg, or no version key at
  // all — is a coverage gap, not a pass, no matter how many pins exist elsewhere in
  // the file, and no matter where inside the step's own block the version key was
  // written.
  expect(uncovered).toEqual([]);
  expect(mismatched).toEqual([]);
});
