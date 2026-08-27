import {
  planTriageActions, computeSaturated, SATURATION_ALERT_ROWS, type ScopedIssue,
} from './triage-plan';
import { groupOwnerless } from './triage-inbox';
import type { Analysis, Verdict } from './triage-analysis';
import type { UntriagedFailure } from '../storage/enrich_failures';
import type { TriageProbe } from './triage-probes';

const v = (over: Partial<Verdict>): Verdict => ({
  beer_id: 1, review_class: 'matcher_bug', review_note: 'note',
  issue_number: null, new_issue_key: null, ...over,
});

const row = (id: number, over: Partial<UntriagedFailure> = {}): UntriagedFailure => ({
  beer_id: id, brewery: 'B', name: 'N', search_url: '', source_url: '',
  candidates_count: 3, candidates_summary: '', fail_count: 1,
  last_at: '2026-08-14T00:00:00.000Z', abv: null, style: null, ...over,
});
const rows = (...ids: number[]) => ids.map((id) => row(id));

// A cohort scope wide enough for the routing tests below: those tests are about
// routing, not about scoping, so the scope must never be the reason a verdict moves.
const COHORT: ScopedIssue['scope'] = { beer_ids: [1, 2, 3, 4, 5, 998, 999], where: [] };
const open = (number: number, over: Partial<ScopedIssue> = {}): ScopedIssue =>
  ({ number, scope: COHORT, postCreationRows: 0, ...over });

const issue = (key: string) => ({
  key, title: `t-${key}`, body: 'b', labels: ['wrong'], scope: { beer_ids: [1, 2, 3, 4], where: [] },
});

const noProbes = new Map<number, TriageProbe>();

// #431: computeSaturated takes what actually landed as a plain map, not a plan — the
// job builds that map from outcome.commented (real GitHub writes), never from the
// plan's routing decisions. In these tests "what landed" is exactly what the plan
// just routed, since there is no GitHub call standing between planning and landing.
const attachedFrom = (p: { comments: { issueNumber: number; verdicts: unknown[] }[] }) =>
  new Map(p.comments.map((c) => [c.issueNumber, c.verdicts.length]));

test('splits quiet actionable verdicts into cause-stripped and no-target', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, review_note: 'unverified: cause the gate stripped' }),
      v({ beer_id: 2, review_note: 'unverified: looks stripped but is not' }),
    ],
    new_issues: [],
  };
  const plan = planTriageActions(a, [], rows(1, 2), noProbes, new Set([a.verdicts[0]]));
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([1, 2]);
  expect(plan.quietCauseStripped).toBe(1);
  expect(plan.quietNoTarget).toBe(1);
});

// #432 fix: the stripped set is keyed by VERDICT IDENTITY, not beer_id, because the
// strip decision is per-verdict while duplicates are collapsed first-wins by beer_id
// (seenBeerIds below). Here the model echoes a second verdict for beer 1 — a plain,
// untouched matcher_bug with no target survives as the FIRST verdict, while a
// DIFFERENT object for the same beer_id is the one the verification gate stripped.
// planTriageActions keeps only the first (seenBeerIds), so the survivor must count as
// a voluntary no-target, not as a stripped cause. An id-keyed set gets this wrong: it
// would see beer_id 1 in the stripped set and misattribute the survivor.
test('a duplicate stripped verdict for the same beer does not taint the surviving first verdict', () => {
  const first = v({ beer_id: 1, review_note: 'voluntary decline' });
  const second = v({ beer_id: 1, review_note: 'unverified: dropped cause' });
  const a: Analysis = { verdicts: [first, second], new_issues: [] };
  const plan = planTriageActions(a, [], rows(1), noProbes, new Set([second]));
  expect(plan.skipped).toBe(1); // the duplicate (second) is skipped by seenBeerIds
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([1]);
  expect(plan.quietNoTarget).toBe(1);
  expect(plan.quietCauseStripped).toBe(0);
});

test('a downgraded absence counts in neither quiet split', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, review_class: 'not_on_untappd' })],
    new_issues: [],
  };
  const plan = planTriageActions(a, [], rows(1), noProbes, new Set());
  expect(plan.guardHits.unprobed_absence).toBe(1);
  expect(plan.quietCauseStripped).toBe(0);
  expect(plan.quietNoTarget).toBe(0);
});

test('routes verdicts: existing issue, new issue, quiet', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, issue_number: 228 }),
      v({ beer_id: 2, new_issue_key: 'k1', review_class: 'parser_bug' }),
      v({ beer_id: 3, review_class: 'not_on_untappd' }),
      v({ beer_id: 4, review_class: 'unidentifiable' }),
    ],
    new_issues: [issue('k1')],
  };
  const plan = planTriageActions(a, [open(228)], rows(1, 2, 3, 4), noProbes, new Set());
  expect(plan.comments).toEqual([{ issueNumber: 228, verdicts: [a.verdicts[0]] }]);
  expect(plan.newIssues).toHaveLength(1);
  expect(plan.newIssues[0].verdicts.map((x) => x.beer_id)).toEqual([2]);
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([3, 4]);
  expect(plan.skipped).toBe(0);
});

test('forces labels from verdict classes, ignoring model labels', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, new_issue_key: 'k1', review_class: 'parser_bug' }),
      v({ beer_id: 2, new_issue_key: 'k1', review_class: 'matcher_bug' }),
    ],
    new_issues: [issue('k1')],
  };
  const plan = planTriageActions(a, [], rows(1, 2), noProbes, new Set());
  expect(plan.newIssues[0].labels.sort())
    .toEqual(['matcher-bug', 'orphan-triage', 'parser-bug']);
});

test('skips invalid verdicts: unknown issue, unknown key, both refs', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, issue_number: 999 }),                       // not open
      v({ beer_id: 2, new_issue_key: 'ghost' }),                  // no such entry
      v({ beer_id: 3, issue_number: 228, new_issue_key: 'k1' }),  // both refs
      v({ beer_id: 5, review_class: 'not_on_untappd', issue_number: 228 }), // quiet class ignores refs
    ],
    new_issues: [issue('k1')],
  };
  const plan = planTriageActions(a, [open(228)], rows(1, 2, 3, 5), noProbes, new Set());
  expect(plan.skipped).toBe(3);
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([5]);
  expect(plan.newIssues).toHaveLength(0); // k1 unused → not created
  expect(plan.comments).toHaveLength(0);
});

test('dedupes duplicate new_issues keys: first occurrence wins, no wasted cap slots', () => {
  const scope = { beer_ids: [1, 2, 3], where: [] };
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, new_issue_key: 'k1' }),
      v({ beer_id: 2, new_issue_key: 'k2' }),
      v({ beer_id: 3, new_issue_key: 'k3' }),
    ],
    // k1 appears 3 times — duplicates must not spawn duplicate issues nor
    // consume cap slots, so k2 and k3 still fit under MAX_NEW_ISSUES_PER_RUN.
    new_issues: [
      { key: 'k1', title: 'first', body: 'first-body', labels: [], scope },
      { key: 'k1', title: 'dup', body: 'dup-body', labels: [], scope },
      { key: 'k2', title: 't-k2', body: 'b', labels: [], scope },
      { key: 'k1', title: 'dup2', body: 'dup2-body', labels: [], scope },
      { key: 'k3', title: 't-k3', body: 'b', labels: [], scope },
    ],
  };
  const plan = planTriageActions(a, [], rows(1, 2, 3), noProbes, new Set());
  expect(plan.newIssues.map((i) => i.key)).toEqual(['k1', 'k2', 'k3']);
  expect(plan.newIssues[0].title).toBe('first');
  expect(plan.newIssues[0].body).toBe('first-body');
  expect(plan.newIssues[0].verdicts.map((x) => x.beer_id)).toEqual([1]);
  expect(plan.skipped).toBe(0);
});

test('groups multiple verdicts on the same existing issue into one comment', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, issue_number: 228 }),
      v({ beer_id: 2, issue_number: 228, review_class: 'parser_bug' }),
      v({ beer_id: 3, issue_number: 231 }),
    ],
    new_issues: [],
  };
  const plan = planTriageActions(a, [open(228), open(231)], rows(1, 2, 3), noProbes, new Set());
  expect(plan.comments).toHaveLength(2);
  const c228 = plan.comments.find((c) => c.issueNumber === 228)!;
  expect(c228.verdicts.map((x) => x.beer_id)).toEqual([1, 2]);
  const c231 = plan.comments.find((c) => c.issueNumber === 231)!;
  expect(c231.verdicts.map((x) => x.beer_id)).toEqual([3]);
  expect(plan.skipped).toBe(0);
});

test('caps new issues at 3 in array order; overflow verdicts are skipped', () => {
  const a: Analysis = {
    verdicts: [1, 2, 3, 4].map((n) => v({ beer_id: n, new_issue_key: `k${n}` })),
    new_issues: [issue('k1'), issue('k2'), issue('k3'), issue('k4')],
  };
  const plan = planTriageActions(a, [], rows(1, 2, 3, 4), noProbes, new Set());
  expect(plan.newIssues.map((i) => i.key)).toEqual(['k1', 'k2', 'k3']);
  expect(plan.skipped).toBe(1);
});

test('drops verdicts whose beer_id is outside the current batch (actionable and quiet alike)', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, issue_number: 228 }),                          // in batch, fine
      v({ beer_id: 999, issue_number: 228 }),                        // actionable, foreign row
      v({ beer_id: 998, review_class: 'unidentifiable' }),                  // quiet, foreign row
    ],
    new_issues: [],
  };
  const plan = planTriageActions(a, [open(228)], rows(1), noProbes, new Set());
  expect(plan.comments).toEqual([{ issueNumber: 228, verdicts: [a.verdicts[0]] }]);
  expect(plan.quiet).toEqual([]);
  expect(plan.skipped).toBe(2);
});

test('dedupes duplicate beer_id verdicts: first wins, later ones skipped', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, issue_number: 228, review_note: 'first' }),
      v({ beer_id: 1, review_class: 'unidentifiable', review_note: 'second' }),
      v({ beer_id: 2, review_class: 'not_on_untappd' }),
    ],
    new_issues: [],
  };
  const plan = planTriageActions(a, [open(228)], rows(1, 2), noProbes, new Set());
  expect(plan.comments).toEqual([{ issueNumber: 228, verdicts: [a.verdicts[0]] }]);
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([2]);
  expect(plan.skipped).toBe(1);
});

// An actionable class with no reference is how a classified-but-unproven row is
// expressed (the job strips the attachment when a cause fails verification, and
// the prompt allows the model to decline one). It must be RECORDED, not skipped:
// skipping keeps review_class NULL, so the same unprovable hypothesis would be
// regenerated - and re-probed - every single day.
test('an actionable verdict without a reference is recorded quietly, not skipped', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, review_note: 'unverified: alias gap' })],
    new_issues: [],
  };
  const plan = planTriageActions(a, [open(228)], rows(1), noProbes, new Set());
  expect(plan.skipped).toBe(0);
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([1]);
  expect(plan.comments).toHaveLength(0);
  expect(plan.newIssues).toHaveLength(0);
});

// --- #408 guard 2: attachment must not contradict the issue's own scope ---------

// The measured misroute: six rows with candidates_count = 0 were filed against a
// brewery-GATE issue. The gate cannot run without candidates, so the two are mutually
// exclusive and a deterministic check catches every one of them.
test('a zero-candidate row cannot attach to an issue scoped candidates_count > 0', () => {
  const issues = [open(347, {
    scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '>', value: 0 }] },
  })];
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 347 })], new_issues: [] };
  const plan = planTriageActions(a, issues, [row(1, { candidates_count: 0 })], noProbes, new Set());
  expect(plan.comments).toHaveLength(0);
  // #509: a scope violation refuses the TARGET, not the class — the row is recorded
  // quietly (quietOffScope), not thrown away as skipped.
  expect(plan.skipped).toBe(0);
  expect(plan.quietOffScope).toBe(1);
  expect(plan.guardHits.scope_violation).toBe(1);
});

test('a row that satisfies the scope still attaches', () => {
  const issues = [open(347, {
    scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '>', value: 0 }] },
  })];
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 347 })], new_issues: [] };
  const plan = planTriageActions(a, issues, [row(1, { candidates_count: 5 })], noProbes, new Set());
  expect(plan.comments[0].verdicts).toHaveLength(1);
  expect(plan.guardHits.scope_violation).toBe(0);
});

// Every issue open today predates the scope block, so "unscoped accepts nothing" is
// what makes the one-time backfill load-bearing instead of cosmetic.
test('an unscoped issue accepts nothing', () => {
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 347 })], new_issues: [] };
  const plan = planTriageActions(a, [open(347, { scope: null })], rows(1), noProbes, new Set());
  expect(plan.comments).toHaveLength(0);
  expect(plan.guardHits.scope_violation).toBe(1);
});

// --- #408 guard 1: a proposed issue may not declare its whole class as scope -----

test('a proposed issue scoped only by review_class is dropped with its verdicts', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, new_issue_key: 'k1' })],
    new_issues: [{
      key: 'k1', title: 't', body: 'b', labels: [],
      scope: { beer_ids: [], where: [{ col: 'review_class', op: '=', value: 'matcher_bug' }] },
    }],
  };
  const plan = planTriageActions(a, [], rows(1), noProbes, new Set());
  expect(plan.newIssues).toHaveLength(0);
  expect(plan.skipped).toBe(1);
  expect(plan.guardHits.illegal_scope).toBe(1);
});

test('a proposed issue scoped by class AND another column survives', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, new_issue_key: 'k1' })],
    new_issues: [{
      key: 'k1', title: 't', body: 'b', labels: [],
      scope: { beer_ids: [], where: [
        { col: 'review_class', op: '=', value: 'matcher_bug' },
        { col: 'candidates_count', op: '=', value: 0 },
      ] },
    }],
  };
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 0 })], noProbes, new Set());
  expect(plan.newIssues).toHaveLength(1);
  expect(plan.newIssues[0].scope.where).toHaveLength(2);
  expect(plan.guardHits.illegal_scope).toBe(0);
});

// --- #431 saturation as a reported state ---

// #405 was opened carrying 15 enumerated rows — exactly the sort of number a lifetime
// count would trip over on day one. Only rows added AFTER creation count.
test('an issue born with a large cohort but no post-creation rows still accepts', () => {
  const issues = [open(405, {
    scope: { beer_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], where: [] },
    postCreationRows: 0,
  })];
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 405 })], new_issues: [] };
  const plan = planTriageActions(a, issues, rows(1), noProbes, new Set());
  expect(plan.comments[0].verdicts).toHaveLength(1);
  expect(computeSaturated(issues, attachedFrom(plan))).toEqual([]);
});

// A batch must not walk an issue past the limit three rows at a time: without counting
// what this run already accepted, each verdict would independently see 11 >= 12 as false.
test('rows accepted earlier in the same run count toward saturation', () => {
  const issues = [open(347, { postCreationRows: 11 })];
  const a: Analysis = {
    verdicts: [1, 2, 3].map((n) => v({ beer_id: n, issue_number: 347 })),
    new_issues: [],
  };
  const plan = planTriageActions(a, issues, rows(1, 2, 3), noProbes, new Set());
  expect(plan.comments[0].verdicts).toHaveLength(3);
  expect(computeSaturated(issues, attachedFrom(plan))).toEqual([{ issueNumber: 347, rows: 14 }]);
});

// Guard 2 must apply to a PROPOSED issue as well, or a model could file one whose scope
// its own founding row contradicts — born unable to accept the row that created it.
test('a verdict whose row contradicts its proposed issue scope is refused', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, new_issue_key: 'k1' })],
    new_issues: [{
      key: 'k1', title: 't', body: 'b', labels: [],
      scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '>', value: 0 }] },
    }],
  };
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 0 })], noProbes, new Set());
  expect(plan.newIssues).toHaveLength(0);
  // #509: refused, not skipped — the row is recorded with its class and no target.
  expect(plan.skipped).toBe(0);
  expect(plan.quietOffScope).toBe(1);
  expect(plan.guardHits.scope_violation).toBe(1);
});

// --- #408 guard 3: absence must be evidenced, not inferred -----------------------

// #377 measured this: of 14 weakly-evidenced not_on_untappd verdicts, 7 were beers that
// exist on Untappd under the same brewery with ABV matching to the decimal. The "no
// probe ran" cohort was wrong 3 of 3.
test('not_on_untappd survives when a probe ran and returned nothing', () => {
  const a: Analysis = { verdicts: [v({ beer_id: 1, review_class: 'not_on_untappd' })], new_issues: [] };
  const probes = new Map<number, TriageProbe>([[1, { brewery: '', name: '' }]]);
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 0 })], probes, new Set());
  expect(plan.quiet[0].review_class).toBe('not_on_untappd');
  expect(plan.guardHits.unprobed_absence).toBe(0);
});

test('not_on_untappd degrades to matcher_bug when no probe ran', () => {
  const a: Analysis = { verdicts: [v({ beer_id: 1, review_class: 'not_on_untappd' })], new_issues: [] };
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 5 })], noProbes, new Set());
  expect(plan.quiet[0].review_class).toBe('matcher_bug');
  expect(plan.quiet[0].review_note).toContain('no absence evidence');
  expect(plan.guardHits.unprobed_absence).toBe(1);
});

// `''` = the probe ran and found nothing. Hits from OTHER breweries are not evidence
// that this beer is absent — brewery-only probes are noisy (#377: "Mad Brew" returns
// Mad Elf / MadTree / Mad Tom), and reading that noise as absence is the actual bug.
test('a probe that returned hits is not absence evidence', () => {
  const a: Analysis = { verdicts: [v({ beer_id: 1, review_class: 'not_on_untappd' })], new_issues: [] };
  const probes = new Map<number, TriageProbe>([[1, { brewery: 'Mad Elf, MadTree', name: 'something' }]]);
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 0 })], probes, new Set());
  expect(plan.quiet[0].review_class).toBe('matcher_bug');
  expect(plan.guardHits.unprobed_absence).toBe(1);
});

// `unidentifiable` says we cannot tell WHICH beer is meant — a probe cannot settle
// that, so only the absence claim is gated here.
test('unidentifiable is untouched by the class gate', () => {
  const a: Analysis = { verdicts: [v({ beer_id: 1, review_class: 'unidentifiable' })], new_issues: [] };
  const plan = planTriageActions(a, [], rows(1), noProbes, new Set());
  expect(plan.quiet[0].review_class).toBe('unidentifiable');
  expect(plan.guardHits.unprobed_absence).toBe(0);
});

// An illegal proposal must not burn one of the three per-run slots either, or a model
// emitting one bad issue would starve two good ones.
test('an illegal proposal does not consume a new-issue cap slot', () => {
  const legal = (key: string) => ({
    key, title: key, body: 'b', labels: [], scope: { beer_ids: [1, 2, 3, 4], where: [] },
  });
  const a: Analysis = {
    verdicts: [1, 2, 3, 4].map((n) => v({ beer_id: n, new_issue_key: `k${n}` })),
    new_issues: [
      { key: 'k1', title: 'bad', body: 'b', labels: [],
        scope: { beer_ids: [], where: [{ col: 'review_class', op: '=', value: 'matcher_bug' }] } },
      legal('k2'), legal('k3'), legal('k4'),
    ],
  };
  const plan = planTriageActions(a, [], rows(1, 2, 3, 4), noProbes, new Set());
  expect(plan.newIssues.map((i) => i.key)).toEqual(['k2', 'k3', 'k4']);
  expect(plan.guardHits.illegal_scope).toBe(1);
});

// #377 part B: not_a_beer is actionable — it has a fix owner (the ingest filter: a
// T-shirt should never have reached `beers`), and it is the only irreversible class,
// so it must leave a scoped issue trail instead of being written silently into a
// column. Removing `not_a_beer` from CLASS_LABELS turns this red.
test('routes not_a_beer to GitHub instead of writing it quietly', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, review_class: 'not_a_beer', new_issue_key: 'merch',
                   review_note: 'mystery box SKU' })],
    new_issues: [issue('merch')],
  };
  const plan = planTriageActions(a, [], rows(1), noProbes, new Set());

  expect(plan.quiet).toHaveLength(0);
  expect(plan.newIssues).toHaveLength(1);
  expect(plan.newIssues[0].labels).toContain('not-a-beer');
  expect(plan.newIssues[0].verdicts.map((x) => x.beer_id)).toEqual([1]);
});

// #432 CRITICAL 1: not_a_beer with no target must NOT land in either quiet counter —
// it already owns outcome.notABeer / the "not_a_beer" digest part, incremented
// separately in orphan-triage.ts from plan.quiet. Counting it here too was the
// double-count bug (12 not_a_beer + 13 без цілі reading as 25 on a 13-row day).
test('a not_a_beer verdict with no target is recorded quietly but counts in neither quiet split', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, review_class: 'not_a_beer', review_note: 'unverified: mystery box' })],
    new_issues: [],
  };
  const plan = planTriageActions(a, [], rows(1), noProbes, new Set([a.verdicts[0]]));
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([1]);
  expect(plan.quietCauseStripped).toBe(0);
  expect(plan.quietNoTarget).toBe(0);
});

// The scope guard still binds not_a_beer: being actionable does not exempt it from
// having to match the issue it attaches to.
test('a not_a_beer verdict whose row contradicts the issue scope is refused', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 5, review_class: 'not_a_beer', issue_number: 228 })],
    new_issues: [],
  };
  const scope: ScopedIssue['scope'] = {
    beer_ids: [], where: [{ col: 'name', op: 'contains', value: 'Pack' }],
  };
  const plan = planTriageActions(a, [open(228, { scope })], [row(5, { name: 'Jasne Pelne' })], noProbes, new Set());

  expect(plan.comments).toEqual([]);
  expect(plan.guardHits.scope_violation).toBe(1);
  // #509 CRITICAL (final review): not_a_beer's write is IRREVERSIBLE —
  // orphanNotOnTapPredicate excludes it from both enrichment pools unconditionally, and
  // listOwnerlessRows only covers matcher_bug/parser_bug — so a refused not_a_beer must
  // not reach `quiet` at all. It falls back to the pre-#509 behaviour for this one class:
  // skipped, untouched, retried tomorrow under a fresh (possibly different) model call.
  expect(plan.quiet).toEqual([]);
  expect(plan.skipped).toBe(1);
  // quietOffScope stays 0 too — it was already excluded from the double-count (#432),
  // and now the row never reaches the branch that would increment it anyway.
  expect(plan.quietOffScope).toBe(0);
});

// --- #431: saturation reports, it does not refuse -------------------------------

test('#431: an in-scope row for a saturated issue is commented, not skipped', () => {
  const issues = [open(900, { postCreationRows: SATURATION_ALERT_ROWS + 5 })];
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 900 })], new_issues: [] };
  const plan = planTriageActions(a, issues, rows(1), noProbes, new Set());
  expect(plan.skipped).toBe(0);
  expect(plan.comments[0].verdicts).toHaveLength(1);
});

// The regression test for the deletion: guard 2 is now the ONLY check on this path.
test('#431 REGRESSION: scope still refuses, even far under the threshold', () => {
  const issues = [open(900, { scope: { beer_ids: [1, 2], where: [] }, postCreationRows: 1 })];
  const a: Analysis = { verdicts: [v({ beer_id: 3, issue_number: 900 })], new_issues: [] };
  const plan = planTriageActions(a, issues, rows(3), noProbes, new Set());
  expect(plan.comments).toHaveLength(0);
  expect(plan.guardHits.scope_violation).toBe(1);
  // #509: refused, not skipped.
  expect(plan.skipped).toBe(0);
  expect(plan.quietOffScope).toBe(1);
});

// not_a_beer needed a carve-out only while a gate existed. Pinned as behaviour so a
// future reader does not "restore" one.
test('#431: not_a_beer on a saturated issue gets its comment (no exception exists)', () => {
  const issues = [open(900, { postCreationRows: SATURATION_ALERT_ROWS })];
  const a: Analysis = {
    verdicts: [v({ beer_id: 2, review_class: 'not_a_beer', issue_number: 900 })],
    new_issues: [],
  };
  const plan = planTriageActions(a, issues, rows(2), noProbes, new Set());
  expect(plan.comments[0].verdicts[0].review_class).toBe('not_a_beer');
});

test('#431: saturated is a STATE — an issue this run never touched is listed', () => {
  const issues = [open(900, { postCreationRows: 21 }), open(901, { postCreationRows: 3 })];
  expect(computeSaturated(issues, new Map())).toEqual([{ issueNumber: 900, rows: 21 }]);
});

test('#431: ties break by issue number ascending, so output is deterministic', () => {
  const issues = [
    open(902, { postCreationRows: 12 }),
    open(900, { postCreationRows: 12 }),
    open(901, { postCreationRows: 30 }),
  ];
  expect(computeSaturated(issues, new Map()).map((s) => s.issueNumber)).toEqual([901, 900, 902]);
});

// --- #509: a refused route keeps its class -----------------------------------------

// The note keeps the model's own diagnosis after the machine reason: for a row whose
// whole remaining purpose is to sit ownerless until a human reads it, that sentence is
// the only statement of what the defect actually is.
test('a verdict refused by scope keeps its class, loses its target, and records the reason', () => {
  const scope = { beer_ids: [], where: [{ col: 'candidates_count', op: '=', value: 0 } as const] };
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, issue_number: 300, review_note: 'shop brand in brewery field' })],
    new_issues: [],
  };
  const plan = planTriageActions(
    a, [open(300, { scope })], [row(1, { candidates_count: 3 })], noProbes, new Set(),
  );
  expect(plan.comments).toEqual([]);
  expect(plan.skipped).toBe(0);
  expect(plan.guardHits.scope_violation).toBe(1);
  expect(plan.quietOffScope).toBe(1);
  expect(plan.quiet).toHaveLength(1);
  expect(plan.quiet[0].review_class).toBe('matcher_bug');
  expect(plan.quiet[0].issue_number).toBeNull();
  expect(plan.quiet[0].review_note).toBe('off-scope #300: candidates_count = 0 | shop brand in brewery field');
});

test('a founding verdict refused by its own proposed scope names the key, not a number', () => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, new_issue_key: 'cider-brand-line' })],
    new_issues: [{
      key: 'cider-brand-line', title: 't', body: 'b', labels: [],
      scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '=', value: 0 }] },
    }],
  };
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 3 })], noProbes, new Set());
  expect(plan.newIssues).toEqual([]);
  // v()'s default review_note is 'note'.
  expect(plan.quiet[0].review_note).toBe('off-scope cider-brand-line: candidates_count = 0 | note');
  expect(plan.quiet[0].new_issue_key).toBeNull();
});

// The cap must be driven by an input the model actually controls without a length limit
// on it: review_note itself is already capped at 500 by VerdictSchema, so feeding it a
// long string proves nothing (refuseRoute could drop the model's note entirely and this
// would stay green). new_issue_key (z.string().nullable(), no max) and a `contains`
// term's value (z.string().min(1), no max) both reach the note unbounded — this drives
// the length from new_issue_key, taking the proposed-issue site where target IS the key.
test('the off-scope note is capped at 500 characters', () => {
  const longKey = 'k'.repeat(600);
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, new_issue_key: longKey })],
    new_issues: [{
      key: longKey, title: 't', body: 'b', labels: [],
      scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '=', value: 0 }] },
    }],
  };
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 3 })], noProbes, new Set());
  expect(plan.quiet[0].review_note.length).toBeLessThanOrEqual(500);
});

// #509 review (finding 1): the 500-char cap test above proves only the LENGTH — it never
// proves the note stays PARSEABLE, and it wasn't: with the pre-review code, slicing the
// whole string to 500 truncated the ": <reason>" separator away entirely for a 600-char
// key (no `: ` survives the slice), so `groupOwnerless` could not recover the target and
// the row landed in `unrecognised` instead of grouped under the key that refused it. This
// test closes that gap by round-tripping the note through the real consumer.
test('a 600-character key still yields a note groupOwnerless parses into the right key and reason', () => {
  const longKey = 'k'.repeat(600);
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, new_issue_key: longKey, review_note: 'shop brand in brewery field' })],
    new_issues: [{
      key: longKey, title: 't', body: 'b', labels: [],
      scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '=', value: 0 }] },
    }],
  };
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 3 })], noProbes, new Set());
  const note = plan.quiet[0].review_note;
  const ownerless = { beer_id: 1, brewery: 'B', name: 'N', review_class: 'matcher_bug' as const, review_note: note };
  const [group] = groupOwnerless([ownerless]);
  expect(group.key).toBe('k'.repeat(60)); // truncated to MAX_TARGET_CHARS, not to 500 total
  expect(group.reason).toBe('candidates_count = 0');
});

// Coordinator's ruling: an issue with NO scope block at all must not be explained via
// explainScopeRejection, which would answer "outside the cohort" — a claim about cohort
// membership the row never made. A missing scope block is a different fact than a
// contradicted term, and the note must say so literally.
test('a refusal against an unscoped issue names the missing scope, not a cohort miss', () => {
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 300 })], new_issues: [] };
  const plan = planTriageActions(a, [open(300, { scope: null })], rows(1), noProbes, new Set());
  expect(plan.quietOffScope).toBe(1);
  expect(plan.quiet[0].review_class).toBe('matcher_bug');
  expect(plan.quiet[0].issue_number).toBeNull();
  // v()'s default review_note is 'note'.
  expect(plan.quiet[0].review_note).toBe('off-scope #300: no scope block | note');
});

// #509 review round 3 (finding A): `new_issue_key` carries no character restriction in
// VerdictSchema (z.string().nullable()), so a key like "cider: brand" used to split at
// the FIRST `: ` — the one INSIDE the key — leaving groupOwnerless with key "cider" and
// reason "brand: candidates_count = 0" instead of the whole key and the real reason. The
// fix sanitizes `: ` out of the target at the write site (refuseRoute's sanitizeTarget),
// not by widening OFF_SCOPE again. Driven through the real consumer, like the existing
// 600-character-key test above, rather than reimplementing the parse here.
test('a new_issue_key containing ": " round-trips through groupOwnerless into the intended key and reason', () => {
  const key = 'cider: brand';
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, new_issue_key: key, review_note: 'shop brand in brewery field' })],
    new_issues: [{
      key, title: 't', body: 'b', labels: [],
      scope: { beer_ids: [], where: [{ col: 'candidates_count', op: '=', value: 0 }] },
    }],
  };
  const plan = planTriageActions(a, [], [row(1, { candidates_count: 3 })], noProbes, new Set());
  const note = plan.quiet[0].review_note;
  const ownerless = { beer_id: 1, brewery: 'B', name: 'N', review_class: 'matcher_bug' as const, review_note: note };
  const [group] = groupOwnerless([ownerless]);
  // Sanitized, not truncated: the whole key survives, just with `: ` defanged to `; `.
  expect(group.key).toBe('cider; brand');
  expect(group.reason).toBe('candidates_count = 0');
});

// #509 review round 3 (finding B): a `contains` term's `value` carries no character
// restriction either (z.string().min(1), no max, no charset), so describeTerm can
// interpolate a ` | ` straight into the reason. OFF_SCOPE's reason group stops at the
// first ` | ` (it has to, to leave room for the model's own review_note tail), so a
// value of "foo | bar" used to truncate the reason to "source_url contains foo" and
// silently drop " bar | note". The fix sanitizes `|` out of the reason at the write site
// (refuseRoute's sanitizeReason), not by widening OFF_SCOPE again.
test('a contains value containing " | " round-trips with the reason intact', () => {
  const scope: ScopedIssue['scope'] = {
    beer_ids: [], where: [{ col: 'source_url', op: 'contains', value: 'foo | bar' }],
  };
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, issue_number: 300, review_note: 'shop brand in brewery field' })],
    new_issues: [],
  };
  // row(1)'s default source_url is '', which does not contain "foo | bar" — the term
  // contradicts the row, so refuseRoute fires with this term as the failing one.
  const plan = planTriageActions(a, [open(300, { scope })], rows(1), noProbes, new Set());
  const note = plan.quiet[0].review_note;
  const ownerless = { beer_id: 1, brewery: 'B', name: 'N', review_class: 'matcher_bug' as const, review_note: note };
  const [group] = groupOwnerless([ownerless]);
  expect(group.key).toBe('#300');
  // Sanitized, not truncated: the whole reason survives, just with `|` defanged to `/`.
  expect(group.reason).toBe('source_url contains foo / bar');
});

// #509 review round 4: three more findings, all newlines — one in each of the target,
// the reason, and the model's own review_note. The lesson generalizes past newlines: ANY
// whitespace run can either break OFF_SCOPE's `.` (which never spans `\n`) or hide a
// delimiter from a substitution that ran before the whitespace was collapsed. Rather
// than bolting on three more single-purpose tests like the two above, this is the one
// durable test the round-4 fix is FOR: table-driven, and any future finding of this
// shape should be answerable by adding one row here, not writing a new test.
//
// The property being pinned: a note this code writes is always parseable by the code
// that reads it. Every row proves that by round-tripping through the REAL
// groupOwnerless (imported at the top of this file from ./triage-inbox, never
// reimplemented) — the only way to prove the writer and the reader actually agree,
// rather than that each independently does what this file assumes the other does.
test.each([
  {
    name: 'a newline in the target (new_issue_key)',
    key: 'cider\nbrand', containsValue: 'baseline', reviewNote: 'note',
    expectedKey: 'cider brand', expectedReason: 'source_url contains baseline',
  },
  {
    name: 'a newline in the reason (a contains term value)',
    key: 'plain-key', containsValue: 'foo\nbar', reviewNote: 'note',
    expectedKey: 'plain-key', expectedReason: 'source_url contains foo bar',
  },
  {
    name: "a newline in the model's own review_note",
    key: 'plain-key-2', containsValue: 'baseline', reviewNote: 'shop brand\nin brewery field',
    expectedKey: 'plain-key-2', expectedReason: 'source_url contains baseline',
  },
  {
    name: '": " inside the target',
    key: 'cider: brand', containsValue: 'baseline', reviewNote: 'note',
    expectedKey: 'cider; brand', expectedReason: 'source_url contains baseline',
  },
  {
    name: '"|" inside the target',
    key: 'cider|brand', containsValue: 'baseline', reviewNote: 'note',
    expectedKey: 'cider/brand', expectedReason: 'source_url contains baseline',
  },
  {
    name: '"|" inside the reason (a contains term value)',
    key: 'plain-key-3', containsValue: 'foo | bar', reviewNote: 'note',
    expectedKey: 'plain-key-3', expectedReason: 'source_url contains foo / bar',
  },
  {
    name: 'a tab inside the target',
    key: 'cider\tbrand', containsValue: 'baseline', reviewNote: 'note',
    expectedKey: 'cider brand', expectedReason: 'source_url contains baseline',
  },
  {
    name: 'an over-long target (600 chars), truncated AFTER sanitizing',
    key: 'k'.repeat(600), containsValue: 'baseline', reviewNote: 'note',
    expectedKey: 'k'.repeat(60), expectedReason: 'source_url contains baseline',
  },
  {
    // The order-sensitive case named by the round-4 review directly: collapsing
    // whitespace BEFORE substituting delimiters is what turns "cider:\nbrand" into
    // "cider: brand" and gets it caught by the `: ` -> `; ` substitution below. Doing
    // the substitution first would test the RAW string for the literal two-character
    // sequence "`: `", find none (a `\n` sits between the colon and "brand", not a
    // space), leave it untouched, and only THEN collapse the untouched `:\n` down to
    // `: ` — reintroducing, after substitution, the very delimiter OFF_SCOPE splits on.
    name: 'combination: a colon immediately followed by a newline in the target',
    key: 'cider:\nbrand', containsValue: 'baseline', reviewNote: 'note',
    expectedKey: 'cider; brand', expectedReason: 'source_url contains baseline',
  },
  {
    name: 'combination: an over-long target with a tab, a tab in the reason, a newline+"|" in review_note',
    key: `${'k'.repeat(30)}\t${'z'.repeat(600)}`, containsValue: 'foo\tbar',
    reviewNote: 'alpha | beta\ngamma',
    expectedKey: `${'k'.repeat(30)} ${'z'.repeat(29)}`,
    expectedReason: 'source_url contains foo bar',
  },
  // #509 review round 5 (hole 1): a `contains` value long enough that "source_url
  // contains <value>" alone pushes the note's structured part right up to the 500-char
  // boundary — with the pre-fix code this is exactly the shape that lands the outer
  // `.slice(0, 500)` cut inside the ` | ` delimiter (a bare trailing " |", no space
  // after it), which the OLD regex still technically matched by letting the reason
  // group swallow the stray "|". MAX_REASON_CHARS bounds the reason to 200 chars BEFORE
  // assembly, so the full delimiter always survives and this round-trips cleanly.
  {
    name: 'a contains value (465 chars) long enough to push the delimiter onto the 500-char boundary',
    key: 'plain-key-4', containsValue: 'x'.repeat(465), reviewNote: 'note',
    expectedKey: 'plain-key-4', expectedReason: `source_url contains ${'x'.repeat(180)}`,
  },
  // The degenerate case named in the review: a reason so long it could consume the
  // ENTIRE 500-character budget by itself (10,000 chars, nowhere near boundary
  // arithmetic — this is not "almost 500", it dwarfs it). MAX_REASON_CHARS truncates it
  // to the same 200 characters regardless of how far past the cap it started, producing
  // a note with no tail (review_note dropped) rather than a note with a corrupted
  // delimiter.
  {
    name: 'a contains value (10,000 chars) long enough to consume the whole note budget by itself',
    key: 'plain-key-5', containsValue: 'y'.repeat(10000), reviewNote: 'note',
    expectedKey: 'plain-key-5', expectedReason: `source_url contains ${'y'.repeat(180)}`,
  },
  // #509 review round 5 (hole 2): `collapseWhitespace`'s `\s+` regex collapses an
  // INTERIOR run to one space but leaves a single LEADING/TRAILING space untouched
  // (collapsing a run of length 1 is a no-op) — the added `.trim()` closes that.
  {
    name: 'a target with leading and trailing whitespace',
    key: '  cider  ', containsValue: 'baseline', reviewNote: 'note',
    expectedKey: 'cider', expectedReason: 'source_url contains baseline',
  },
])('off-scope note round-trips through the real groupOwnerless: $name', ({
  key, containsValue, reviewNote, expectedKey, expectedReason,
}) => {
  const a: Analysis = {
    verdicts: [v({ beer_id: 1, new_issue_key: key, review_note: reviewNote })],
    new_issues: [{
      key, title: 't', body: 'b', labels: [],
      scope: { beer_ids: [], where: [{ col: 'source_url', op: 'contains', value: containsValue }] },
    }],
  };
  // row(1)'s default source_url is '', which never contains a non-empty containsValue —
  // the term always contradicts the row, so refuseRoute always fires.
  const plan = planTriageActions(a, [], rows(1), noProbes, new Set());
  const note = plan.quiet[0].review_note;
  const ownerless = { beer_id: 1, brewery: 'B', name: 'N', review_class: 'matcher_bug' as const, review_note: note };
  const [group] = groupOwnerless([ownerless]);
  expect(group.key).toBe(expectedKey);
  expect(group.reason).toBe(expectedReason);
});

// #509 review round 5 (hole 2, second half): trimming a single target proves the target
// itself comes out clean, but the actual failure mode was two rows that should share ONE
// inbox heading splitting into two — the whitespace was invisible, so nobody noticed two
// groups where there should have been one. This is a distinct shape from every row in the
// table above (which each check one note's round-trip) and doesn't fit that table's
// single-verdict per-row structure, so it stands alone: two verdicts, two model-authored
// targets differing only by surrounding whitespace, one combined call to the real
// groupOwnerless, asserting they land in the SAME group rather than checking either
// note in isolation.
test('two targets differing only by surrounding whitespace land in the same inbox group', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, new_issue_key: ' cider', review_note: 'note' }),
      v({ beer_id: 2, new_issue_key: 'cider ', review_note: 'note' }),
    ],
    new_issues: [
      {
        key: ' cider', title: 't1', body: 'b', labels: [],
        scope: { beer_ids: [], where: [{ col: 'source_url', op: 'contains', value: 'baseline' }] },
      },
      {
        key: 'cider ', title: 't2', body: 'b', labels: [],
        scope: { beer_ids: [], where: [{ col: 'source_url', op: 'contains', value: 'baseline' }] },
      },
    ],
  };
  // row(1) and row(2) both default to source_url: '', which never contains 'baseline' —
  // both proposed issues' scope contradicts their own founding row, so refuseRoute fires
  // for both (guard 2 applies to a proposed issue too, same as the rest of this file).
  const plan = planTriageActions(a, [], rows(1, 2), noProbes, new Set());
  expect(plan.quiet).toHaveLength(2);
  const ownerless = plan.quiet.map((q) => ({
    beer_id: q.beer_id, brewery: 'B', name: 'N', review_class: q.review_class, review_note: q.review_note,
  }));
  const groups = groupOwnerless(ownerless);
  expect(groups).toHaveLength(1);
  expect(groups[0].key).toBe('cider');
  expect(groups[0].rows.map((r) => r.beer_id).sort()).toEqual([1, 2]);
});
