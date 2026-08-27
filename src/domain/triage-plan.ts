import type { Analysis, Verdict } from './triage-analysis';
import type { UntriagedFailure } from '../storage/enrich_failures';
import { absenceProvedBy, type TriageProbe } from './triage-probes';
import { explainScopeRejection, isLegalScope, rowSatisfiesScope, type Scope } from './triage-scope';

export interface PlannedNewIssue {
  key: string;
  title: string;
  body: string;
  labels: string[];
  scope: Scope;                   // rendered into the issue body by the job
  verdicts: Verdict[];
}

export interface PlannedComment {
  issueNumber: number;
  verdicts: Verdict[];
}

// An open triage issue as the guards need to see it: its parsed scope (null when the
// body carries no `triage-scope` block) and how many rows were attached to it AFTER it
// was created. Parsing and counting are I/O, so they happen at the call site — this
// module stays pure.
export interface ScopedIssue {
  number: number;
  scope: Scope | null;
  postCreationRows: number;
}

// Why a verdict was refused. Counted rather than logged here (this is a pure function),
// so the job can surface them in one line. Every reason here is a fact about the ROW —
// a hallucinated scope, a row that contradicts its target, an absence nobody probed —
// which is what makes retrying it tomorrow worthwhile: a different model call can give a
// different answer. Saturation was once in this list and is not a fact about the row
// (#431), so it no longer refuses anything.
export type GuardReason = 'illegal_scope' | 'scope_violation' | 'unprobed_absence';

export interface TriagePlan {
  newIssues: PlannedNewIssue[];   // deduped + capped, labels forced, only keys actually referenced
  comments: PlannedComment[];     // grouped per existing issue
  quiet: Verdict[];               // not_on_untappd / unidentifiable — DB write only
  skipped: number;                // invalid verdicts left untriaged for tomorrow
  guardHits: Record<GuardReason, number>;
  // #432: the three ways an actionable class ends up with no issue are counted where
  // each is decided, never as a sum. The third is guardHits.unprobed_absence. Deriving
  // any of them by subtraction can go negative — a stripped verdict may still be dropped
  // as a foreign row — and a report that can print a negative number is not a report.
  quietCauseStripped: number;     // #358 gate stripped the cause, row went quiet
  quietNoTarget: number;          // the model named neither an issue nor a key
  // #509: refused routing, class kept — a fourth way an actionable class ends with no
  // issue, counted where it is decided like the other three.
  quietOffScope: number;
}

export const MAX_NEW_ISSUES_PER_RUN = 3;

// #509 review (finding 1): the refused TARGET must be bounded on its own, separately from
// the note's overall 500-char cap. `target` at the proposed-issue site is
// `verdict.new_issue_key`, which VerdictSchema bounds only by `z.string().min(1)` — no
// maximum — so a long enough key can eat the whole `.slice(0, 500)` budget on its own and
// truncate away the `: <reason>` separator `groupOwnerless`'s OFF_SCOPE regex depends on
// (triage-inbox.ts), silently dropping the row into the `unrecognised` bucket instead of
// under the target that refused it. Real model-authored keys measured in production run
// 15-30 characters (`flasker_glued_brewery`, `garbled-name-noise`,
// `lobster_brewery_suffix`); 60 is a generous multiple of that, chosen so nothing
// legitimate is ever truncated while nothing pathological can consume the budget the
// structured prefix needs to survive.
//
// #509 review round 3 (rejected finding): two DISTINCT model-authored targets that both
// exceed 60 characters AND agree on their first 60 would collide under one inbox group
// heading. Accepted as-is — it needs two keys past the measured 15-30 char range that
// also share a 60-char prefix, has never occurred, and the failure mode (two mechanisms
// sharing one heading) is visible to the human reading the report, not silent data loss.
const MAX_TARGET_CHARS = 60;

// #509 review round 5 (hole 1): `reason` has no bound of its own either. It comes from
// `explainScopeRejection` (triage-scope.ts), which for a `contains` term is
// `describeTerm(failing)` = `${col} ${op} ${value}` — `value` is the model-authored
// `contains` term's free-text value, `z.string().min(1)`, no max, no charset. Bounding
// `target` alone (above) is not enough: a long enough `reason` can, on its own, push the
// note's structured part (`off-scope <target>: <reason>`) right up against the outer
// `.slice(0, 500)` cut, so the cut lands inside the ` | ` delimiter itself instead of past
// it — not truncating the tail cleanly, but leaving a note that ends in a bare `" |"`
// with no trailing space. `OFF_SCOPE`'s tail group requires the full three-character
// literal ` | ` to match at all, so it fails, and the non-greedy reason group backtracks
// to swallow the stray `" |"` into the reason text: the note still matches (this is why
// it is a display bug, not a parse failure), but a dangling pipe leaks into what the
// inbox shows as the reason, and the model's own review_note is silently dropped instead
// of merely truncated. Same fix as the target: bound the piece BEFORE assembly. With
// target capped at 60 and reason capped here at 200, the structured prefix plus the full
// delimiter is at most `"off-scope ".length (10) + 60 + ": ".length (2) + 200 + " | ".length (3)` =
// 275 characters — nowhere near 500 — so the delimiter is always assembled whole before
// the outer slice ever runs, and the only thing that slice can still cut is the model's
// own trailing sentence. That is the degenerate case this cap accepts on purpose: a
// reason long enough to want the ENTIRE 500-character budget for itself still only ever
// gets truncated to 200 well-formed characters, producing a note with no tail sentence at
// all (`review_note` dropped) rather than a note with half a delimiter. A note missing its
// tail is a smaller loss than one whose reason field is corrupted — the tail is optional
// context, the reason is the fact a human is meant to act on. 200 is picked the same way
// 60 is for the target: production reasons are `<col> <op> <value>` over a handful of
// short column names and operators (`source_url contains ...`, `brewery = ...`), so 200
// leaves generous headroom over anything measured while still leaving most of the
// 500-character budget for the tail in the common case.
const MAX_REASON_CHARS = 200;

// #509 review round 3 (findings A & B — see MAX_TARGET_CHARS above for the rejected
// finding C): the prior two rounds each patched OFF_SCOPE's regex (triage-inbox.ts) to
// survive one more shape of model text, and each patch immediately produced a new failure
// of the same kind, because the two fields the note encodes alongside the fixed literal
// text — `target` (verdict.new_issue_key, `z.string().nullable()`, no max, no charset) and
// `reason` (built from explainScopeRejection, which for a `contains` term interpolates the
// model-authored `value`, `z.string().min(1)`, no max, no charset either) — are
// UNCONSTRAINED. A regex is a fixed pattern; it cannot be made safe against text it does
// not control, because for any delimiter it looks for there is always a model string that
// reproduces it (`cider: brand` reproduces `: `, a `contains` value of `foo | bar`
// reproduces ` | `). The fix is therefore at the WRITE site, not the parse site: sanitize
// the two model-authored fields before they are encoded, so neither can contain a
// delimiter OFF_SCOPE depends on. This is the one place that KNOWS which characters are
// structural — the writer built the format — whereas the parser can only ever react to
// text already committed to the column. Substitution (not deletion) keeps the note
// lossy-but-visible: a human reading the inbox still sees what the model meant, just with
// the two structural sequences defanged. Once these are sanitized, OFF_SCOPE needs no
// further widening — its job was never wrong, its input was.
//
// #509 review round 4: three more findings, all newlines — in the target, in the reason,
// and in the model's own `review_note` (which round 3 left unsanitized entirely, since it
// is appended raw after the note's second `|`). OFF_SCOPE's `.` groups never span `\n`
// (JS regex, no `s` flag), so a newline ANYWHERE in the note — not just in the field that
// carries it — makes the whole `^...$` fail to match, and the row falls to
// UNRECOGNISED_KEY. Same fix as round 3, same reasoning: sanitize at the write site,
// where the structural characters are known.
//
// Order matters, and it is not arbitrary: collapse whitespace runs (newlines and tabs
// included) to a single space FIRST, and only THEN do the `: `/`|` substitutions. A key
// of `"cider:\nbrand"` collapses to `"cider: brand"` — now containing the literal `: `
// trigger — so the substitution below correctly catches it and produces `"cider; brand"`.
// Reverse the order and that case escapes: substituting first tests the ORIGINAL string
// for the literal two-character sequence `: ` (colon immediately followed by a space),
// finds none (a `\n` sits between them, not a space), leaves it untouched, and only
// THEN collapses the untouched `:\n` down to `: ` — which still contains the very
// delimiter OFF_SCOPE splits on, now smuggled in by whitespace instead of by the model
// typing it directly. Collapse-then-substitute is the only order that closes both the
// literal-delimiter case and the delimiter-hiding-behind-whitespace case in one pass.
//
// #509 review round 5 (hole 2): `\s+` collapses an INTERIOR run to one space but leaves a
// single LEADING or TRAILING space untouched — collapsing a run of length 1 is a no-op.
// A target of `" cider "` therefore survived as `" cider "`, not `"cider"`: an invisible
// padding difference that made `groupOwnerless` file it under its own heading instead of
// joining the `"cider"` group, and rendered as a heading with leading/trailing blank
// space in the inbox. `.trim()` after the collapse removes exactly that padding. Order
// between collapse and trim does not matter here (trim only ever touches the edges,
// collapse only ever touches interior runs, and neither can reintroduce work for the
// other), unlike the `: `/`|` substitutions below, which genuinely do depend on running
// after the collapse — so this is placed after collapse simply to read as one pipeline,
// not because reversing it would break anything.
const collapseWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim();
const sanitizeTarget = (s: string): string =>
  collapseWhitespace(s).replace(/: /g, '; ').replace(/\|/g, '/');
const sanitizeReason = (s: string): string =>
  collapseWhitespace(s).replace(/\|/g, '/');
// `review_note` is appended raw after the note's final `|` and is never parsed back out
// into a captured field (OFF_SCOPE's tail, `(?: \| .*)?`, is non-capturing) — so it needs
// no delimiter substitution, `|` and `: ` inside it are harmless. But it can still break
// the WHOLE match if it carries a newline (see round 4 above), so it gets the same
// whitespace collapse the other two fields get.
const sanitizeReviewNote = (s: string): string => collapseWhitespace(s);

// Rows attached AFTER creation, not lifetime rows — #405 was opened carrying 15
// enumerated rows, so a lifetime count would misread the very shape (a narrow issue
// split out of a magnet) this whole area exists to encourage. Measured on prod
// 2026-08-14: issues nobody complains about sit at <= 7 rows, while the magnets ran to
// 36 (#347) and 90 (#254), so any threshold in 10-15 separates them.
//
// #431: this used to be a GATE. It is now purely a reporting threshold — being wrong
// about it costs a mislabelled issue, never a discarded row.
export const SATURATION_ALERT_ROWS = 12;

// An issue carrying enough evidence that the next move is a fix, not more triage.
export interface SaturatedIssue {
  issueNumber: number;
  rows: number;
}

// Computed over ALL open issues passed in, including those this run never touched:
// saturation is a property of the issue's accumulated evidence, not of today's batch.
// An issue CREATED by this run never appears here: postCreationRows counts rows
// attached after creation, and a new issue's founding rows land at creation.
//
// #431: `attachedThisRun` must count only rows that actually landed — a comment
// planned but never posted (github.commentOnIssue threw) attaches nothing, and the
// caller must not pass a count for it. This is why the count is a parameter rather
// than something this function derives from a plan: a pure planner can only describe
// what it INTENDS to attach, and intent is not evidence until the write that makes it
// real (the GitHub call, then the DB row) has actually succeeded. Feeding this
// function planned-but-unwritten counts is exactly the bug #431 fixes — the label,
// the digest and the database would each tell a different story for a day.
export function computeSaturated(
  issues: readonly { number: number; postCreationRows: number }[],
  attachedThisRun: ReadonlyMap<number, number>,
): SaturatedIssue[] {
  return issues
    .map((i) => ({
      issueNumber: i.number,
      rows: i.postCreationRows + (attachedThisRun.get(i.number) ?? 0),
    }))
    .filter((i) => i.rows >= SATURATION_ALERT_ROWS)
    .sort((a, b) => b.rows - a.rows || a.issueNumber - b.issueNumber);
}

// Single source of truth for which classes go to GitHub and which label each
// maps to — the actionable check derives from these keys.
//
// #377 part B: not_a_beer is actionable on the same criterion as the other two — it
// has a fix owner, namely the ingest filter that let a T-shirt into `beers`. It is
// also the only class whose consequence is irreversible, and an irreversible verdict
// that leaves a scoped issue trail is safer than one written silently into a column.
const CLASS_LABELS = {
  parser_bug: 'parser-bug',
  matcher_bug: 'matcher-bug',
  not_a_beer: 'not-a-beer',
} as const;

type ActionableClass = keyof typeof CLASS_LABELS;
type ActionableVerdict = Verdict & { review_class: ActionableClass };

const isActionable = (verdict: Verdict): verdict is ActionableVerdict =>
  verdict.review_class in CLASS_LABELS;

function pushInto<K>(map: Map<K, ActionableVerdict[]>, key: K, verdict: ActionableVerdict): void {
  const list = map.get(key);
  if (list) list.push(verdict);
  else map.set(key, [verdict]);
}

// Pure validation/routing of the LLM proposal. The LLM only proposes — this is
// where hallucinated issue numbers, ghost keys, duplicate keys, issue spam,
// out-of-batch beer_ids and duplicate beer_ids get filtered. The prompt quotes
// older beer_ids inside open-issue bodies/comment tables, so the model can echo
// a stray id that isn't part of the current selection — that verdict must never
// reach the unconditional `UPDATE ... WHERE beer_id=?` write, actionable or
// quiet alike (a stray not_a_beer would permanently exclude a foreign row).
// Skipped verdicts keep review_class NULL and re-enter tomorrow's selection.
//
// #408 adds the scope guards. It takes the batch ROWS (not just their ids) and the
// issues' parsed scopes because judging a routing decision requires the evidence the
// decision was made about — the old signature could see neither.
export function planTriageActions(
  analysis: Analysis,
  openIssues: ScopedIssue[],
  batchRows: UntriagedFailure[],
  probes: Map<number, TriageProbe>,
  // #432: verdicts whose cause the verification gate stripped before planning, keyed by
  // OBJECT IDENTITY rather than beer_id. The strip decision is per-verdict, not per-beer:
  // the model can emit two verdicts for the same beer_id (e.g. one echoed from an
  // open-issue body), and planTriageActions keeps only the first via seenBeerIds below.
  // An id-keyed set would misattribute the surviving first verdict to a strip that
  // actually hit a discarded later duplicate. Identity is exact here because this
  // function iterates the very verdict objects the job produced.
  // Passed in rather than marked on the Verdict: Verdict is the model's own parsed
  // output, and a marker there is one schema edit away from being model-settable, which
  // would let a model launder a stripped cause into a voluntary declination.
  strippedVerdicts: ReadonlySet<Verdict>,
): TriagePlan {
  const byNumber = new Map(openIssues.map((i) => [i.number, i]));
  const rowById = new Map(batchRows.map((r) => [r.beer_id, r]));
  const guardHits: Record<GuardReason, number> = {
    illegal_scope: 0, scope_violation: 0, unprobed_absence: 0,
  };

  // Guard 1: an illegal scope kills the proposed issue before it can claim a class.
  // A `where` made only of `review_class` is the exact shape that turned #347 into a
  // dumping ground — it declares the whole class as scope, so every future row of that
  // class is trivially "already covered". Dropped BEFORE the dedupe/cap so an illegal
  // proposal cannot consume one of the three slots either.
  const uniqueIssues = new Map<string, Analysis['new_issues'][number]>();
  for (const entry of analysis.new_issues) {
    if (!isLegalScope(entry.scope)) { guardHits.illegal_scope += 1; continue; }
    if (!uniqueIssues.has(entry.key)) uniqueIssues.set(entry.key, entry);
  }
  const cappedIssues = [...uniqueIssues.values()].slice(0, MAX_NEW_ISSUES_PER_RUN);
  const allowedKeys = new Set(cappedIssues.map((i) => i.key));

  const byKey = new Map<string, ActionableVerdict[]>();
  const byIssue = new Map<number, ActionableVerdict[]>();
  const quiet: Verdict[] = [];
  let skipped = 0;
  let quietCauseStripped = 0;
  let quietNoTarget = 0;
  let quietOffScope = 0;
  const seenBeerIds = new Set<number>();

  // #509: a scope violation refutes the TARGET, not the class. The verdict goes quiet with
  // its class intact and a trace of what refused it — the model's own note survives too
  // (appended after the machine reason), the same thing the unprobed_absence branch above
  // does for its own note; before this the machine reason replaced it outright. It is
  // deliberately NOT re-routed to another issue: choosing a different target by title
  // similarity is what built #347, and the guard exists to stop it.
  const refuseRoute = (verdict: ActionableVerdict, row: UntriagedFailure, target: string, scope: Scope | null): void => {
    guardHits.scope_violation += 1;
    // CRITICAL (#509 review): not_a_beer must NOT fall through to `quiet` here. Every
    // other class's refusal is recoverable — the row keeps its issue_number NULL, stays
    // in the enrichment pool, and a later run (different scope, different model call)
    // can route it correctly. not_a_beer is the one class whose write is IRREVERSIBLE:
    // orphanNotOnTapPredicate (src/storage/beers.ts) excludes it from BOTH enrichment
    // pools unconditionally — not on backoff, not ever — and listOwnerlessRows only
    // covers matcher_bug/parser_bug, so a quiet not_a_beer with no issue would leave the
    // pipeline for good with no issue trail and nothing in the inbox either. CLASS_LABELS
    // above already states the rule this violates: an irreversible verdict is safe only
    // when it leaves a scoped issue trail, and a refused routing leaves none. So this one
    // class falls back to the pre-#509 shape — skipped, retried tomorrow — instead of
    // being recorded quietly. Measured by replaying all 28 archived production runs: 0 of
    // 62 not_a_beer verdicts EVER named an issue at all (matcher_bug: 302/369 do;
    // parser_bug: 15/98), so this costs at most one extra LLM verdict on a day that has
    // never yet happened.
    if (verdict.review_class === 'not_a_beer') { skipped++; return; }
    // Every ActionableClass reaching this line is now parser_bug or matcher_bug — the
    // not_a_beer branch above already returned. #432: their own no-target site fifteen
    // lines below counts the same way, for the same reason (outcome.notABeer already
    // owns not_a_beer's digest part, so counting it twice would double it).
    quietOffScope += 1;
    // A missing scope block and a contradicted term are different facts about the issue,
    // not two spellings of the same one: the row never claimed cohort membership and lost,
    // so explainScopeRejection's "outside the cohort" would misreport WHY nothing matched.
    const reason = scope === null ? 'no scope block' : explainScopeRejection(row, verdict.review_class, scope);
    // Bound TARGET and REASON before the outer cap, not instead of it: capping only the
    // whole string (the pre-review shape) truncates wherever the 500-char limit happens
    // to fall, which for a long enough target OR reason lands inside the structured
    // prefix itself and eats a delimiter the parser depends on ("off-scope <target>"
    // losing its ": " separator, or "<reason>" losing the " | " tail delimiter — see
    // MAX_REASON_CHARS above for the full failure mode of the second one). Bounding both
    // pieces first guarantees the structured prefix `off-scope <target>: <reason>` always
    // survives whole, delimiters included; the outer `.slice(0, 500)` remains as the
    // belt-and-braces bound on the one piece that is genuinely free-text tail now: the
    // model's own review_note.
    //
    // #509 review round 3: sanitize BEFORE bounding, not instead of it — sanitizeTarget
    // and sanitizeReason never GROW their input (each delimiter substitution is one
    // character for one or two, and round 4's whitespace collapse can only shrink a run
    // down to one space), so the char budgets always land on sanitized content, never
    // mid-substitution.
    const sanitizedTarget = sanitizeTarget(target);
    const boundedTarget = sanitizedTarget.length > MAX_TARGET_CHARS
      ? sanitizedTarget.slice(0, MAX_TARGET_CHARS) : sanitizedTarget;
    const sanitizedReason = sanitizeReason(reason);
    const boundedReason = sanitizedReason.length > MAX_REASON_CHARS
      ? sanitizedReason.slice(0, MAX_REASON_CHARS) : sanitizedReason;
    quiet.push({
      ...verdict,
      issue_number: null,
      new_issue_key: null,
      review_note: `off-scope ${boundedTarget}: ${boundedReason} | ${sanitizeReviewNote(verdict.review_note)}`.slice(0, 500),
    });
  };

  for (const verdict of analysis.verdicts) {
    const row = rowById.get(verdict.beer_id);
    if (!row) { skipped++; continue; }                            // foreign row — never write
    if (seenBeerIds.has(verdict.beer_id)) { skipped++; continue; } // first verdict per beer wins
    seenBeerIds.add(verdict.beer_id);

    // Guard 3: absence is claimable only from a probe that RAN and came back empty.
    // `''` = ran, no results (strong evidence); `undefined` = never ran (no evidence).
    // triage-probes.ts keeps those distinct on purpose — collapsing them invites the
    // guessing this guard exists to stop. #377 measured the "no probe ran" cohort as
    // wrong 3 of 3, and hits from OTHER breweries read as absence 4 times out of 11.
    //
    // NOTE: collectTriageProbes skips rows with candidates_count > 0 by construction,
    // so every candidate-bearing not_on_untappd degrades here. That is the intended
    // direction — the prompt's own pivot rule says candidates_count > 0 means the
    // search works and the miss is on the match side. Probing those rows too is #377's
    // dropped proposal 2, tracked in #357; until then a genuinely absent beer with
    // unrelated candidates is retried instead of being closed, which is the cheaper
    // error of the two.
    if (verdict.review_class === 'not_on_untappd') {
      if (!absenceProvedBy(probes.get(verdict.beer_id))) {
        guardHits.unprobed_absence += 1;
        // matcher_bug with no target falls into the `quiet` branch below: the class is
        // recorded so the row leaves the UNTRIAGED pool, but it stays in the
        // ENRICHMENT pool (orphanNotOnTapPredicate excludes only not_a_beer and
        // retired_at), so the cron keeps retrying it under BACKOFF_HOURS.
        // Wrong-but-recoverable replaces wrong-and-terminal.
        quiet.push({
          ...verdict,
          review_class: 'matcher_bug',
          issue_number: null,
          new_issue_key: null,
          review_note: `no absence evidence: ${verdict.review_note}`.slice(0, 500),
        });
        continue;
      }
    }

    if (!isActionable(verdict)) {
      quiet.push(verdict); // quiet classes never touch GitHub; stray refs are ignored
      continue;
    }
    const hasIssue = verdict.issue_number !== null;
    const hasKey = verdict.new_issue_key !== null;
    if (hasIssue && hasKey) { skipped++; continue; } // contradictory routing
    // Actionable class with no target: either the model deliberately declined to
    // name a cause, or the job stripped an unverified one. Record the class so the
    // row leaves the untriaged pool instead of regenerating the same unprovable
    // hypothesis every day; it stays findable via the issues' `Scope:` queries.
    if (!hasIssue && !hasKey) {
      // #432 CRITICAL 1: not_a_beer is deliberately excluded from both quiet counters.
      // It already owns its own counter and digest part (outcome.notABeer, incremented
      // in orphan-triage.ts from plan.quiet) — counting it again here would republish a
      // number beside its own part, which is the exact double-count defect this branch
      // exists to remove (12 not_a_beer + 13 без цілі reading as 25 on a 13-row day).
      if (verdict.review_class === 'parser_bug' || verdict.review_class === 'matcher_bug') {
        if (strippedVerdicts.has(verdict)) quietCauseStripped += 1;
        else quietNoTarget += 1;
      }
      quiet.push(verdict);
      continue;
    }
    if (hasIssue) {
      const target = byNumber.get(verdict.issue_number!);
      if (!target) { skipped++; continue; }
      // Guard 2: the row must not contradict what the issue claims to be about. An
      // unscoped issue (no `triage-scope` block in its body) accepts nothing — that is
      // what makes the one-time backfill of existing issues load-bearing rather than
      // cosmetic. We deliberately do NOT re-route on failure: choosing a different
      // issue is exactly the title-similarity judgement that produced the pile.
      if (target.scope === null || !rowSatisfiesScope(row, verdict.review_class, target.scope)) {
        refuseRoute(verdict, row, `#${verdict.issue_number}`, target.scope);
        continue;
      }
      pushInto(byIssue, verdict.issue_number!, verdict);
    } else {
      const proposed = uniqueIssues.get(verdict.new_issue_key!);
      if (!proposed || !allowedKeys.has(verdict.new_issue_key!)) { skipped++; continue; }
      // Guard 2 applies to a PROPOSED issue too. Without this a model could file an
      // issue whose scope its own founding row contradicts — the consequence would be
      // applied with no row evidence, which is the invariant this whole change exists
      // to enforce, and the issue would be born unable to accept the very row that
      // created it.
      if (!rowSatisfiesScope(row, verdict.review_class, proposed.scope)) {
        refuseRoute(verdict, row, verdict.new_issue_key!, proposed.scope);
        continue;
      }
      pushInto(byKey, verdict.new_issue_key!, verdict);
    }
  }

  const newIssues: PlannedNewIssue[] = cappedIssues
    .filter((i) => byKey.has(i.key))
    .map((i) => {
      const verdicts = byKey.get(i.key)!;
      const labels = ['orphan-triage', ...new Set(verdicts.map((x) => CLASS_LABELS[x.review_class]))];
      return { key: i.key, title: i.title, body: i.body, labels, scope: i.scope, verdicts };
    });

  const comments: PlannedComment[] = [...byIssue.entries()]
    .map(([issueNumber, verdicts]) => ({ issueNumber, verdicts }));

  return {
    newIssues, comments, quiet, skipped, guardHits, quietCauseStripped, quietNoTarget, quietOffScope,
  };
}
