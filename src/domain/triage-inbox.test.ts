import { groupOwnerless, buildInboxBody, MAX_INBOX_ROWS_PER_GROUP } from './triage-inbox';
import type { OwnerlessRow } from '../storage/enrich_failures';

const r = (id: number, note: string): OwnerlessRow =>
  ({ beer_id: id, brewery: `B${id}`, name: `N${id}`, review_class: 'matcher_bug', review_note: note });

test('groups by the refused target, because that is the mechanism the model named', () => {
  const groups = groupOwnerless([
    r(1, 'off-scope #485: outside the cohort'),
    r(2, 'off-scope #485: outside the cohort'),
    r(3, 'off-scope cider-brand-line: candidates_count = 0'),
    r(4, 'no absence evidence: looks absent'),
  ]);
  expect(groups.map((g) => [g.key, g.rows.length])).toEqual([
    ['#485', 2], ['cider-brand-line', 1], ['absence not probed', 1],
  ]);
  expect(groups[0].reason).toBe('outside the cohort');
});

// #509 override: the note format grew a ` | <the model's original review_note>` tail.
// The reason must stop at the first separator — swallowing the model's free prose into
// the displayed reason would defeat the whole point of grouping on a machine-readable key.
test('a composite note keeps the target as key and stops the reason at the separator', () => {
  const groups = groupOwnerless([
    r(1, 'off-scope #300: candidates_count = 0 | shop brand in brewery field'),
  ]);
  expect(groups.map((g) => [g.key, g.reason])).toEqual([['#300', 'candidates_count = 0']]);
});

// The "no scope predicate at all" case still has no ` | ` tail here — a target with no
// scope block is a routing refusal, not a rewritten model note — so it must group and
// display exactly like any other off-scope reason.
test('a "no scope block" note groups and displays like any other off-scope reason', () => {
  const groups = groupOwnerless([r(1, 'off-scope #300: no scope block')]);
  expect(groups.map((g) => [g.key, g.reason])).toEqual([['#300', 'no scope block']]);
});

test('a group lists at most MAX_INBOX_ROWS_PER_GROUP rows and reports the remainder', () => {
  const many = Array.from({ length: MAX_INBOX_ROWS_PER_GROUP + 4 },
    (_, i) => r(i + 1, 'off-scope #485: outside the cohort'));
  const body = buildInboxBody(groupOwnerless(many), 250, '2026-08-27');
  expect(body).toContain(`ще 4`);
  expect(body.match(/^ {2}\d+ /gm)!.length).toBe(MAX_INBOX_ROWS_PER_GROUP);
});

test('the header reports the whole ownerless pile, not just the groupable part', () => {
  const body = buildInboxBody(groupOwnerless([r(1, 'off-scope #485: outside the cohort')]), 250, '2026-08-27');
  expect(body).toContain('250');
});
