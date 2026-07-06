import { planTriageActions } from './triage-plan';
import type { Analysis, Verdict } from './triage-analysis';

const v = (over: Partial<Verdict>): Verdict => ({
  beer_id: 1, review_class: 'matcher_bug', review_note: 'note',
  issue_number: null, new_issue_key: null, ...over,
});
const issue = (key: string) => ({ key, title: `t-${key}`, body: 'b', labels: ['wrong'] });

test('routes verdicts: existing issue, new issue, quiet', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, issue_number: 228 }),
      v({ beer_id: 2, new_issue_key: 'k1', review_class: 'parser_bug' }),
      v({ beer_id: 3, review_class: 'not_on_untappd' }),
      v({ beer_id: 4, review_class: 'wontfix' }),
    ],
    new_issues: [issue('k1')],
  };
  const plan = planTriageActions(a, [228], [1, 2, 3, 4]);
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
  const plan = planTriageActions(a, [], [1, 2]);
  expect(plan.newIssues[0].labels.sort())
    .toEqual(['matcher-bug', 'orphan-triage', 'parser-bug']);
});

test('skips invalid verdicts: unknown issue, unknown key, both refs, actionable without ref', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, issue_number: 999 }),                       // not open
      v({ beer_id: 2, new_issue_key: 'ghost' }),                  // no such entry
      v({ beer_id: 3, issue_number: 228, new_issue_key: 'k1' }),  // both refs
      v({ beer_id: 4 }),                                          // actionable, no ref
      v({ beer_id: 5, review_class: 'not_on_untappd', issue_number: 228 }), // quiet class ignores refs
    ],
    new_issues: [issue('k1')],
  };
  const plan = planTriageActions(a, [228], [1, 2, 3, 4, 5]);
  expect(plan.skipped).toBe(4);
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([5]);
  expect(plan.newIssues).toHaveLength(0); // k1 unused → not created
  expect(plan.comments).toHaveLength(0);
});

test('dedupes duplicate new_issues keys: first occurrence wins, no wasted cap slots', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, new_issue_key: 'k1' }),
      v({ beer_id: 2, new_issue_key: 'k2' }),
      v({ beer_id: 3, new_issue_key: 'k3' }),
    ],
    // k1 appears 3 times — duplicates must not spawn duplicate issues nor
    // consume cap slots, so k2 and k3 still fit under MAX_NEW_ISSUES_PER_RUN.
    new_issues: [
      { key: 'k1', title: 'first', body: 'first-body', labels: [] },
      { key: 'k1', title: 'dup', body: 'dup-body', labels: [] },
      { key: 'k2', title: 't-k2', body: 'b', labels: [] },
      { key: 'k1', title: 'dup2', body: 'dup2-body', labels: [] },
      { key: 'k3', title: 't-k3', body: 'b', labels: [] },
    ],
  };
  const plan = planTriageActions(a, [], [1, 2, 3]);
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
  const plan = planTriageActions(a, [228, 231], [1, 2, 3]);
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
  const plan = planTriageActions(a, [], [1, 2, 3, 4]);
  expect(plan.newIssues.map((i) => i.key)).toEqual(['k1', 'k2', 'k3']);
  expect(plan.skipped).toBe(1);
});

test('drops verdicts whose beer_id is outside the current batch (actionable and quiet alike)', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, issue_number: 228 }),                          // in batch, fine
      v({ beer_id: 999, issue_number: 228 }),                        // actionable, foreign row
      v({ beer_id: 998, review_class: 'wontfix' }),                  // quiet, foreign row
    ],
    new_issues: [],
  };
  const plan = planTriageActions(a, [228], [1]);
  expect(plan.comments).toEqual([{ issueNumber: 228, verdicts: [a.verdicts[0]] }]);
  expect(plan.quiet).toEqual([]);
  expect(plan.skipped).toBe(2);
});

test('dedupes duplicate beer_id verdicts: first wins, later ones skipped', () => {
  const a: Analysis = {
    verdicts: [
      v({ beer_id: 1, issue_number: 228, review_note: 'first' }),
      v({ beer_id: 1, review_class: 'wontfix', review_note: 'second' }),
      v({ beer_id: 2, review_class: 'not_on_untappd' }),
    ],
    new_issues: [],
  };
  const plan = planTriageActions(a, [228], [1, 2]);
  expect(plan.comments).toEqual([{ issueNumber: 228, verdicts: [a.verdicts[0]] }]);
  expect(plan.quiet.map((x) => x.beer_id)).toEqual([2]);
  expect(plan.skipped).toBe(1);
});
