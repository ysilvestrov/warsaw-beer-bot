import type {
  DroppedFinding,
  GateResult,
  GatedFinding,
  RawFinding,
} from './types';

/** Longest multi-line quote we will try to match, in lines. */
const MAX_QUOTE_SPAN = 40;

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 1-based line where `quote` starts in `content`, or null.
 *
 * Matching is whitespace-normalised so a re-indented or re-wrapped quote still
 * matches: line numbers are the field models get wrong most often, so we locate
 * the text and derive the position rather than trusting what was reported.
 */
export function locateQuote(content: string, quote: string): number | null {
  const needle = normalizeWs(quote);
  if (needle === '') return null;

  const lines = content.split('\n');
  const normalized = lines.map(normalizeWs);

  // Phase 1: quote fully contained within a single normalised line. Checking
  // each line in isolation (rather than an ever-growing multi-line window)
  // avoids false positives where the needle happens to appear as a substring
  // only once unrelated preceding lines have been concatenated onto it.
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i].includes(needle)) return i + 1;
  }

  // Phase 2: a quote spanning multiple lines, anchored at the start of line i.
  for (let i = 0; i < lines.length; i++) {
    let acc = normalized[i];
    for (let n = 1; n < MAX_QUOTE_SPAN && i + n < lines.length; n++) {
      acc = `${acc} ${normalized[i + n]}`;
      if (acc.startsWith(needle)) return i + 1;
    }
  }
  return null;
}

/**
 * Post-image line ranges touched by the diff, per file.
 *
 * Hunk ranges include the surrounding context lines. That leniency is
 * deliberate: a bug on a context line immediately adjacent to a change is still
 * about this PR, and dropping it would cost us exactly the kind of finding the
 * greedy pass exists to surface.
 */
export function changedLineRanges(diff: string): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>();
  let file: string | null = null;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (file && !ranges.has(file)) ranges.set(file, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) ranges.get(file)!.push([start, start + count - 1]);
    }
  }
  return ranges;
}

function intersects(
  spans: Array<[number, number]>,
  start: number,
  end: number,
): boolean {
  return spans.some(([from, to]) => start <= to && end >= from);
}

export function applyGate(params: {
  findings: RawFinding[];
  reviewable: string[];
  changed: Map<string, Array<[number, number]>>;
  fileContent: (path: string) => string | null;
}): GateResult {
  const { findings, reviewable, changed, fileContent } = params;
  const inScope = new Set(reviewable);
  const seen = new Set<string>();
  const kept: GatedFinding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const finding of findings) {
    if (!inScope.has(finding.file)) {
      dropped.push({ finding, reason: 'out_of_scope' });
      continue;
    }

    const content = fileContent(finding.file);
    if (content === null) {
      dropped.push({ finding, reason: 'out_of_scope' });
      continue;
    }

    const matchedLine = locateQuote(content, finding.quote);
    if (matchedLine === null) {
      dropped.push({ finding, reason: 'quote_not_found' });
      continue;
    }

    const quotedLines = finding.quote.trim().split('\n').length;
    const matchedEndLine = matchedLine + quotedLines - 1;

    if (!intersects(changed.get(finding.file) ?? [], matchedLine, matchedEndLine)) {
      dropped.push({ finding, reason: 'outside_changed_lines' });
      continue;
    }

    const key = `${finding.file}::${normalizeWs(finding.quote)}`;
    if (seen.has(key)) {
      dropped.push({ finding, reason: 'duplicate' });
      continue;
    }
    seen.add(key);

    kept.push({ ...finding, matchedLine, matchedEndLine });
  }

  return { kept, dropped };
}
