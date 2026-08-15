import { z } from 'zod';
import type { UntriagedFailure } from '../storage/enrich_failures';
import { REVIEW_CLASSES } from './review-class';

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

// Narrows `term` itself (not just `term.col`) to the schema variant(s) whose `col` is
// in `cols`. The predicate must take the whole object — TS's discriminant narrowing
// does not propagate from a guard called on a bare `term.col` property access back up
// to `term` (verified empirically; only guards applied to the object itself narrow
// it). Using a real type guard instead of a plain boolean-and-cast means the
// `term as Extract<...>` casts are gone: there is nothing left for a mis-cast to hide
// behind.
function hasCol<T extends readonly ScopeTerm['col'][]>(
  term: ScopeTerm,
  cols: T,
): term is Extract<ScopeTerm, { col: T[number] }> {
  return (cols as readonly string[]).includes(term.col);
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
  //
  // Every branch below is fail-closed by construction, not just by convention: the
  // numeric switch ends in `default: op satisfies never`, so a new operator added to
  // NUMERIC_COLS's op enum without a matching `case` is a COMPILE error, not a
  // fall-through. And the final `term satisfies never` is only reachable if `term`'s
  // col is in none of review_class/NUMERIC_COLS/NULLABLE_COLS/TEXT_COLS — impossible
  // today, and a compile error the day a new column group is added and forgotten
  // here. (An earlier version of this function used `term as Extract<...>` casts and
  // let an unmatched case fall through the numeric branch into the text branch, where
  // it mis-cast a numeric term and reported a silent false "match" — see #408 review.)
  if (hasCol(term, NUMERIC_COLS)) {
    const v = row[term.col];
    switch (term.op) {
      case '=': return v === term.value;
      case '!=': return v !== term.value;
      case '<': return v < term.value;
      case '<=': return v <= term.value;
      case '>': return v > term.value;
      case '>=': return v >= term.value;
      default:
        term satisfies never;
        return false; // unreachable: compile error above if a new op is ever added
    }
  }
  if (hasCol(term, NULLABLE_COLS)) {
    const v = row[term.col];
    return term.op === 'is_null' ? v === null : v !== null;
  }
  if (hasCol(term, TEXT_COLS)) {
    const v = row[term.col];
    if (term.op === 'contains') return v.toLowerCase().includes(term.value.toLowerCase());
    return term.op === 'empty' ? v === '' : v !== '';
  }
  // Unreachable: a compile error fires above the day a new column group is added and
  // forgotten here. The explicit `false` matters anyway — `return term satisfies never`
  // type-checks but RETURNS THE TERM OBJECT at runtime, which is truthy, i.e. the same
  // silent false "match" this function was just fixed to stop. Fail closed.
  term satisfies never;
  return false;
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

const BLOCK_RE = /```triage-scope\s*\n([\s\S]*?)\n?```/;

function describeTerm(t: ScopeTerm): string {
  return 'value' in t ? `${t.col} ${t.op} ${t.value}` : `${t.col} ${t.op}`;
}

// We render this ourselves and parse our own output back on the next run. The model
// never authors the text — it submits the structured field, which the tool schema
// already validates. That is the whole point: a parser exists, but its input is not
// model prose.
export function renderScopeBlock(scope: Scope): string {
  const parts: string[] = [];
  if (scope.beer_ids.length > 0) parts.push(`beer_ids ${scope.beer_ids.join(', ')}`);
  if (scope.where.length > 0) parts.push(scope.where.map(describeTerm).join(' AND '));
  // The human-readable line is rendered BEFORE the fenced block and BLOCK_RE takes the
  // FIRST match, so a backtick run here would open a spurious fence ahead of the real
  // one. `contains` values are free text authored by the model, and the failure is not
  // a parse error but a SILENT WRONG SCOPE: a value that is itself valid block JSON is
  // returned instead of the real one. Backticks are REPLACED, not \u-escaped like the
  // payload below — this line is display-only, and ``` would reach a human reader
  // as those six literal characters.
  const prose = parts.join(' OR ').replace(/`/g, "'");
  // A free-text `contains` value can legally contain a backtick run (e.g. a source_url
  // fragment). JSON does not escape backticks, so an unescaped ` ``` ` inside the JSON
  // payload would look like the fence's own closing delimiter to BLOCK_RE and truncate
  // the capture mid-string, breaking JSON.parse on the next run. ` is a valid JSON
  // string escape for backtick that JSON.parse decodes back to `, so this keeps every
  // literal backtick out of the fenced content without changing the parsed value.
  const json = JSON.stringify(scope).replace(/`/g, '\\u0060');
  return [
    `Scope: ${prose}`,
    '',
    '```triage-scope',
    json,
    '```',
  ].join('\n');
}

export function parseScopeBlock(body: string): Scope | null {
  const m = BLOCK_RE.exec(body);
  if (!m) return null;
  try {
    const parsed = ScopeSchema.safeParse(JSON.parse(m[1]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
