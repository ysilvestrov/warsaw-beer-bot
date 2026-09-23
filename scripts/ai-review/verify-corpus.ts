/**
 * The labelled corpus for the `verify` stage: claims whose correct verdict we
 * checked against the tree ourselves.
 *
 * Why this exists rather than a judge-vs-judge comparison: comparing two judges
 * measures similarity to the incumbent, not correctness — if they disagree,
 * agreement cannot say who is right. And the incumbent has been wrong: its 16
 * `refuted` verdicts on DeepSeek's claims are its own labels, checked by nobody.
 *
 * Design: docs/superpowers/specs/2026-09/2026-09-23-verify-corpus-and-runner-design.md
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Prose fields: trimming them is harmless and whitespace-only must be rejected.
const nonEmpty = z.string().trim().min(1);

// `quote` is NOT trimmed. It carries the code's own indentation, which is what the
// judge is shown, and `.trim()` would silently strip the leading whitespace of a
// single-line quote and the outer edges of a multi-line one. Probed against zod
// 4.6.5 on 2026-09-23: `z.string().trim()` does transform the parsed value, so this
// distinction is load-bearing, not stylistic.
const codeQuote = z.string().min(1).refine((v) => v.trim().length > 0, {
  message: 'quote must contain something other than whitespace',
});

const entrySchema = z.object({
  id: nonEmpty,
  provenance: z.enum(['harvested', 'constructed']),
  source: nonEmpty,
  sha: nonEmpty,
  file: nonEmpty,
  matchedLine: z.number().int().positive(),
  matchedEndLine: z.number().int().positive(),
  quote: codeQuote,
  quoteOrigin: z.enum(['original', 'reconstructed']),
  claim: nonEmpty,
  why_it_breaks: nonEmpty,
  // `out_of_scope` is deliberately absent: its ground truth depends on the diff,
  // and a label we cannot defend against the tree poisons the corpus.
  expected: z.enum(['confirmed', 'refuted']),
  why_expected: nonEmpty,
});

export type CorpusEntry = z.infer<typeof entrySchema>;

/**
 * Validate every entry, or throw.
 *
 * Fails the whole load rather than skipping a bad entry: a skipped entry is a
 * mark the candidate did not earn, and it shrinks the denominator invisibly.
 */
export function parseCorpus(raw: unknown): CorpusEntry[] {
  const list = z.array(z.unknown()).parse(raw);
  const out: CorpusEntry[] = [];
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const parsed = entrySchema.safeParse(item);
    if (!parsed.success) {
      const id = (item as { id?: unknown })?.id;
      const named = typeof id === 'string' ? id : `index ${i}`;
      throw new Error(`verify corpus entry ${named} is invalid: ${parsed.error.message}`);
    }
    if (seen.has(parsed.data.id)) {
      throw new Error(`verify corpus has a duplicate id: ${parsed.data.id}`);
    }
    seen.add(parsed.data.id);
    out.push(parsed.data);
  });
  return out;
}

export function loadCorpus(readJson?: () => unknown): CorpusEntry[] {
  const read =
    readJson ?? (() => JSON.parse(readFileSync(join(__dirname, 'verify-corpus.json'), 'utf8')));
  return parseCorpus(read());
}
