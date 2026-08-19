import type { Analysis, Verdict } from './triage-analysis';
import type { UntriagedFailure } from '../storage/enrich_failures';
import { absenceProvedBy, type TriageProbe } from './triage-probes';
import { isLegalScope, rowSatisfiesScope, type Scope } from './triage-scope';

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
}

export const MAX_NEW_ISSUES_PER_RUN = 3;

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
  const seenBeerIds = new Set<number>();

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
        // ENRICHMENT pool (orphanWithoutMatchLinkPredicate excludes only not_a_beer and
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
        guardHits.scope_violation += 1;
        skipped++;
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
        guardHits.scope_violation += 1;
        skipped++;
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

  return { newIssues, comments, quiet, skipped, guardHits, quietCauseStripped, quietNoTarget };
}
