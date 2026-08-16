import { planTriageActions, type ScopedIssue } from './triage-plan';
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

test('splits quiet actionable verdicts into cause-stripped and no-target', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, review_note: 'unverified: cause the gate stripped' }),
      v({ beer_id: 2, review_note: 'unverified: looks stripped but is not' }),
    ],
    new_issues: [],
  };
  const plan = planTriageActions(a, [], rows(1, 2), noProbes, new Set([1]));
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([1, 2]);
  expect(plan.quietCauseStripped).toBe(1);
  expect(plan.quietNoTarget).toBe(1);
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
  expect(plan.skipped).toBe(1);
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

// --- #408 guard 4: a saturated issue stops accepting rows ------------------------

test('a saturated issue refuses further attachment', () => {
  const issues = [open(347, { postCreationRows: 12 })];
  const a: Analysis = { verdicts: [v({ beer_id: 1, issue_number: 347 })], new_issues: [] };
  const plan = planTriageActions(a, issues, rows(1), noProbes, new Set());
  expect(plan.comments).toHaveLength(0);
  expect(plan.skipped).toBe(1);
  expect(plan.guardHits.saturated).toBe(1);
});

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
  expect(plan.guardHits.saturated).toBe(0);
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
  expect(plan.comments[0].verdicts).toHaveLength(1);
  expect(plan.guardHits.saturated).toBe(2);
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
  expect(plan.skipped).toBe(1);
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
  const plan = planTriageActions(a, [], rows(1), noProbes, new Set([1]));
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
});
