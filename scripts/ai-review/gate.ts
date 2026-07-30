import type {
  DroppedFinding,
  GateResult,
  GatedFinding,
  RawFinding,
} from './types';
import { MAX_QUOTE_CHARS } from './state';

/** Longest multi-line quote we will try to match, in lines. */
const MAX_QUOTE_SPAN = 40;

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * A finding's identity: file + quoted code + what is claimed about it.
 *
 * The claim is load-bearing — two different bugs can live on the same line, and
 * keying on the quote alone would publish only one of them.
 *
 * The quote is cut **before** it is normalised, at exactly the length
 * `toStored` cuts at. That order is the whole trick: a carried finding holds a
 * raw 400-character prefix, a freshly raised one holds the full quote, and both
 * therefore pass through the identical `normalizeWs(slice(0, 400))` here. Doing
 * it the other way round — normalise, then slice — desynchronises the two
 * whenever the cut lands inside a run of whitespace, because collapsing a run
 * the truncated copy no longer contains shortens it below the compared prefix.
 * The consequence would be mild but real: a still-open finding re-derived by
 * the incremental pass would miss its own carried twin and be republished as
 * new.
 */
export function findingKey(file: string, quote: string, claim: string): string {
  return [
    file,
    normalizeWs(quote.slice(0, MAX_QUOTE_CHARS)),
    normalizeWs(claim).toLowerCase(),
  ].join('::');
}

/** 1-based inclusive line span of one match of a quote. */
export interface QuoteMatch {
  start: number;
  end: number;
}

/**
 * Every place `quote` occurs in `content`, in file order.
 *
 * Matching is whitespace-normalised so a re-indented or re-wrapped quote still
 * matches: line numbers are the field models get wrong most often, so we locate
 * the text and derive the position rather than trusting what was reported.
 *
 * All occurrences matter, not just the first: a snippet that also appears
 * earlier in the file outside the diff would otherwise make applyGate test the
 * wrong line against the changed ranges and drop a real finding.
 *
 * `end` is the last line the match actually consumes, so the caller never has
 * to infer the span from how the model happened to format the quote.
 *
 * Known limitation: a multi-line quote must begin at the start of a line —
 * one that starts mid-line is not located. That is deliberate: anchoring the
 * multi-line search at the window start is what prevents a substring
 * false-positive (matching a later line's quote against an earlier line's
 * accumulated window). The failure mode this trades for is failing closed —
 * applyGate drops the finding as `quote_not_found` instead of possibly
 * mis-locating it.
 */
export function locateQuoteAll(content: string, quote: string): QuoteMatch[] {
  const needle = normalizeWs(quote);
  if (needle === '') return [];

  const lines = content.split('\n');
  const normalized = lines.map(normalizeWs);

  // Phase 1: quote fully contained within a single normalised line. Checking
  // each line in isolation (rather than an ever-growing multi-line window)
  // avoids false positives where the needle happens to appear as a substring
  // only once unrelated preceding lines have been concatenated onto it.
  const single: QuoteMatch[] = [];
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i].includes(needle)) single.push({ start: i + 1, end: i + 1 });
  }
  // Phase 2 only runs when the quote fits on no single line: a needle that is a
  // prefix of some line would otherwise also match there as a bogus multi-line
  // window, reporting a span wider than the code it quotes.
  if (single.length > 0) return single;

  // Phase 2: a quote spanning multiple lines, anchored at the start of line i.
  // The smallest window that matches is the true span, so stop at the first n.
  const multi: QuoteMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    let acc = normalized[i];
    for (let n = 1; n < MAX_QUOTE_SPAN && i + n < lines.length; n++) {
      acc = `${acc} ${normalized[i + n]}`;
      if (acc.startsWith(needle)) {
        multi.push({ start: i + 1, end: i + n + 1 });
        break;
      }
    }
  }
  return multi;
}

/** 1-based line where `quote` first starts in `content`, or null. */
export function locateQuote(content: string, quote: string): number | null {
  const matches = locateQuoteAll(content, quote);
  return matches.length > 0 ? matches[0].start : null;
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

/** Distance from `line` to the closed interval [start, end]; 0 when inside. */
function distanceTo(match: QuoteMatch, line: number): number {
  if (line < match.start) return match.start - line;
  if (line > match.end) return line - match.end;
  return 0;
}

/**
 * Which of several equally valid occurrences the finding is about.
 *
 * The quote alone cannot tell two identical changed locations apart, and
 * attributing the finding to whichever comes first in the file sends the
 * maintainer to the wrong copy. The model's reported line is not trustworthy
 * enough to *locate* a finding — that is why we search by text — but it is a
 * fine tiebreaker between candidates the text already vouched for. Without a
 * usable report (missing, zero, negative, non-finite) the first occurrence
 * stands, which is the previous behaviour.
 */
export function pickMatch(matches: QuoteMatch[], reportedLine: number): QuoteMatch {
  if (matches.length === 1) return matches[0];
  if (!Number.isFinite(reportedLine) || reportedLine < 1) return matches[0];

  let best = matches[0];
  let bestDistance = distanceTo(best, reportedLine);
  for (const match of matches.slice(1)) {
    const distance = distanceTo(match, reportedLine);
    // Strictly closer only: a tie keeps the earlier occurrence.
    if (distance < bestDistance) {
      best = match;
      bestDistance = distance;
    }
  }
  return best;
}

export function applyGate(params: {
  findings: RawFinding[];
  reviewable: string[];
  changed: Map<string, Array<[number, number]>>;
  fileContent: (path: string) => string | null;
  /**
   * Identities already published by an earlier run. An incremental pass
   * re-reads files it reviewed before, so without this seed a still-open
   * finding would be raised again and printed twice.
   */
  knownKeys?: Iterable<string>;
}): GateResult {
  const { findings, reviewable, changed, fileContent } = params;
  const inScope = new Set(reviewable);
  const seen = new Set<string>(params.knownKeys ?? []);
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

    const matches = locateQuoteAll(content, finding.quote);
    if (matches.length === 0) {
      dropped.push({ finding, reason: 'quote_not_found' });
      continue;
    }

    // A quote can occur several times; the finding is about this PR as long as
    // any occurrence is on a changed line.
    const spans = changed.get(finding.file) ?? [];
    const onChangedLines = matches.filter((m) => intersects(spans, m.start, m.end));
    if (onChangedLines.length === 0) {
      dropped.push({ finding, reason: 'outside_changed_lines' });
      continue;
    }

    const { start: matchedLine, end: matchedEndLine } = pickMatch(
      onChangedLines,
      finding.start_line,
    );

    const key = findingKey(finding.file, finding.quote, finding.claim);
    if (seen.has(key)) {
      dropped.push({ finding, reason: 'duplicate' });
      continue;
    }
    seen.add(key);

    kept.push({ ...finding, matchedLine, matchedEndLine });
  }

  return { kept, dropped };
}
