import { z } from 'zod';
import type { GatedFinding, Severity } from './types';

/**
 * What a published finding has to remember about itself so a later run can
 * carry it, close it, or re-adjudicate it without re-deriving it.
 *
 * Deliberately narrower than GatedFinding: `start_line`/`end_line` were the
 * model's untrusted guesses (the gate already replaced them with matchedLine),
 * and `confidence` is a pass-1 artefact nothing downstream reads.
 */
export interface StoredFinding {
  file: string;
  quote: string;
  matchedLine: number;
  matchedEndLine: number;
  claim: string;
  why_it_breaks: string;
  severity: Severity;
  evidence: string;
}

export interface Spend {
  usd: number;
  runs: number;
  /** Runs whose model had no verified price, so `usd` is a lower bound. */
  unpriced: number;
}

export interface ReviewState {
  v: 1;
  /** The commit the last review was computed against. */
  head: string;
  /** Open findings, in the order they were first published. */
  findings: StoredFinding[];
  spend: Spend;
}

/** A quote longer than this is stored truncated; it only has to re-anchor. */
export const MAX_QUOTE_CHARS = 400;

/** Open findings carried across pushes. Beyond this the review is noise. */
export const MAX_OPEN_FINDINGS = 20;

const STATE_OPEN = '<!-- ai-pr-review-state ';
const STATE_CLOSE = ' -->';

const storedSchema = z.object({
  file: z.string(),
  quote: z.string(),
  matchedLine: z.number().int(),
  matchedEndLine: z.number().int(),
  claim: z.string(),
  why_it_breaks: z.string(),
  severity: z.enum(['P0', 'P1', 'P2']),
  evidence: z.string(),
});

const stateSchema = z.object({
  v: z.literal(1),
  head: z.string(),
  findings: z.array(storedSchema),
  spend: z.object({
    usd: z.number(),
    runs: z.number().int(),
    unpriced: z.number().int(),
  }),
});

export function toStored(f: GatedFinding, evidence: string): StoredFinding {
  return {
    file: f.file,
    quote: f.quote.slice(0, MAX_QUOTE_CHARS),
    matchedLine: f.matchedLine,
    matchedEndLine: f.matchedEndLine,
    claim: f.claim,
    why_it_breaks: f.why_it_breaks,
    severity: f.severity,
    evidence,
  };
}

/**
 * The state as a hidden HTML comment.
 *
 * `<` and `>` are escaped to their JSON unicode forms — still valid JSON that
 * parses back byte-identical, but incapable of containing `-->`. A quoted line
 * of code with an arrow in it would otherwise close the comment early and spill
 * the rest of the state into the visible review.
 */
export function renderState(state: ReviewState): string {
  const json = JSON.stringify(state).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${STATE_OPEN}${json}${STATE_CLOSE}`;
}

/**
 * The state carried by a review body, or null if there is none we can trust.
 *
 * Every failure mode — no block, truncated JSON, a version we do not know, a
 * hand-edited body — returns null, which the caller reads as "review this PR in
 * full". Degrading to today's cost is always safe; acting on a half-understood
 * state is not.
 */
export function parseState(body: string | null | undefined): ReviewState | null {
  if (!body) return null;
  const start = body.indexOf(STATE_OPEN);
  if (start === -1) return null;
  const from = start + STATE_OPEN.length;
  const end = body.indexOf(STATE_CLOSE, from);
  if (end === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(from, end));
  } catch {
    return null;
  }
  const result = stateSchema.safeParse(parsed);
  return result.success ? (result.data as ReviewState) : null;
}

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

/**
 * The single display order used by the renderer, the caps and the state block:
 * severity first, then the order findings were published.
 *
 * One order everywhere is what makes "drop from the end" a safe rule — a P0 is
 * never dropped while a P2 survives.
 */
export function orderBySeverity<T>(items: T[], pick: (item: T) => StoredFinding): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[pick(a.item).severity] - SEVERITY_RANK[pick(b.item).severity] ||
        a.index - b.index,
    )
    .map((x) => x.item);
}

/** Display order, cut to MAX_OPEN_FINDINGS from the end. */
export function capOpenFindings<T>(
  items: T[],
  pick: (item: T) => StoredFinding,
): { kept: T[]; dropped: number } {
  const ordered = orderBySeverity(items, pick);
  return {
    kept: ordered.slice(0, MAX_OPEN_FINDINGS),
    dropped: Math.max(0, ordered.length - MAX_OPEN_FINDINGS),
  };
}
