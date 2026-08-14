import { z } from 'zod';
import type { UntriagedFailure } from '../storage/enrich_failures';
import { REVIEW_CLASSES } from './triage-analysis';

// The scope is a NECESSARY CONDITION, never a definition of the mechanism. Most real
// triage patterns (shop typos, packaging tokens, "the brewery field isn't a brewery")
// cannot be expressed as a column predicate at all. So a scope answers exactly one
// question — does this row provably CONTRADICT the issue? — and the guard rejects on
// contradiction. It never asserts that a row belongs.
export const NUMERIC_COLS = ['candidates_count', 'fail_count'] as const;
export const TEXT_COLS = ['source_url', 'brewery', 'name'] as const;
export const NULLABLE_COLS = ['abv', 'style'] as const;

export const ScopeTermSchema = z.union([
  z.object({
    col: z.enum(NUMERIC_COLS),
    op: z.enum(['=', '!=', '<', '<=', '>', '>=']),
    value: z.number(),
  }),
  z.object({ col: z.enum(TEXT_COLS), op: z.enum(['empty', 'non_empty']) }),
  z.object({ col: z.enum(TEXT_COLS), op: z.literal('contains'), value: z.string().min(1) }),
  z.object({ col: z.enum(NULLABLE_COLS), op: z.enum(['is_null', 'is_not_null']) }),
  z.object({ col: z.literal('review_class'), op: z.literal('='), value: z.enum(REVIEW_CLASSES) }),
]);
export type ScopeTerm = z.infer<typeof ScopeTermSchema>;

export const ScopeSchema = z.object({
  beer_ids: z.array(z.number().int()),
  where: z.array(ScopeTermSchema),
});
export type Scope = z.infer<typeof ScopeSchema>;

// Legality: an enumerated cohort is the narrowest scope there is, so it always
// qualifies. A `where` qualifies only if it constrains something other than the class
// itself — "all orphans in this class" is the exact shape that turned #347 into a
// dumping ground, and four open issues still carry it verbatim.
export function isLegalScope(scope: Scope): boolean {
  if (scope.beer_ids.length > 0) return true;
  return scope.where.some((t) => t.col !== 'review_class');
}

function termMatches(
  row: UntriagedFailure,
  verdictClass: (typeof REVIEW_CLASSES)[number],
  term: ScopeTerm,
): boolean {
  // review_class is evaluated against the VERDICT, not the row: every row in the batch
  // is untriaged by construction (listUntriagedFailures filters review_class IS NULL),
  // so matching it against the row would make every such term false.
  if (term.col === 'review_class') return verdictClass === term.value;

  // Switching on `term.col` first (rather than `term.op`) is what gives TS a clean
  // discriminant: NUMERIC_COLS/TEXT_COLS/NULLABLE_COLS are disjoint, so each branch
  // below narrows `term` to exactly one schema variant and `row[term.col]` to that
  // variant's field type — no `any`, no widened `string | number | null`.
  if ((NUMERIC_COLS as readonly string[]).includes(term.col)) {
    const t = term as Extract<ScopeTerm, { col: (typeof NUMERIC_COLS)[number] }>;
    const v = row[t.col];
    switch (t.op) {
      case '=': return v === t.value;
      case '!=': return v !== t.value;
      case '<': return v < t.value;
      case '<=': return v <= t.value;
      case '>': return v > t.value;
      case '>=': return v >= t.value;
    }
  }
  if ((NULLABLE_COLS as readonly string[]).includes(term.col)) {
    const t = term as Extract<ScopeTerm, { col: (typeof NULLABLE_COLS)[number] }>;
    const v = row[t.col];
    return t.op === 'is_null' ? v === null : v !== null;
  }
  const t = term as Extract<ScopeTerm, { col: (typeof TEXT_COLS)[number] }>;
  const v = row[t.col];
  if (t.op === 'contains') return v.toLowerCase().includes(t.value.toLowerCase());
  return t.op === 'empty' ? v === '' : v !== '';
}

export function rowSatisfiesScope(
  row: UntriagedFailure,
  verdictClass: (typeof REVIEW_CLASSES)[number],
  scope: Scope,
): boolean {
  if (scope.beer_ids.includes(row.beer_id)) return true;
  // An empty `where` must NOT pass vacuously — `[].every(...)` is true, which would
  // turn a cohort-only scope into "accepts everything" the moment a row falls outside
  // the cohort. That is the opposite of what a cohort scope means.
  if (scope.where.length === 0) return false;
  return scope.where.every((t) => termMatches(row, verdictClass, t));
}
