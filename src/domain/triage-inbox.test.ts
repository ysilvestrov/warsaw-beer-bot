import {
  groupOwnerless, buildInboxBody, MAX_INBOX_ROWS_PER_GROUP, MAX_INBOX_GROUPS,
} from './triage-inbox';
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

// #509 fix round 2: groupOwnerless itself no longer slices to MAX_INBOX_GROUPS — the cap
// moved into buildInboxBody, which is the one place that can keep the header's `groupable`
// count and the dropped-groups remainder line honest with each other. Before this fix, an
// 11th-and-beyond group was cut silently and its rows vanished into the header's #508
// remainder — machine-grouped, actionable rows misreported as free model prose.
test('groups beyond MAX_INBOX_GROUPS are not silently dropped: the header counts them and the body names them', () => {
  const totalGroups = MAX_INBOX_GROUPS + 2;
  const many = Array.from({ length: totalGroups }, (_, i) => r(i + 1, `off-scope #${300 + i}: outside the cohort`));
  const groups = groupOwnerless(many);
  // groupOwnerless returns every group, unsliced.
  expect(groups).toHaveLength(totalGroups);

  const body = buildInboxBody(groups, 250, '2026-08-27');
  // groupable counts ALL groups (one row each here), not just the MAX_INBOX_GROUPS shown.
  expect(body).toContain(`(з них ${totalGroups} з машинною причиною`);
  // and the body says what got cut, instead of staying silent about it.
  expect(body).toContain('Ще 2 груп (2 рядків) не показано');
});

// #509 fix round 3: `unverified:` (the #358 verification gate's own prefix) must not
// collapse into the `no absence evidence:` bucket — the two are different mechanisms
// (a stripped cause vs. an unprobed absence claim) and a human grinding the inbox needs
// to know which one they are looking at.
test('an unverified cause gets its own group, distinct from an unprobed absence', () => {
  const groups = groupOwnerless([
    r(1, 'unverified: brewery alias gap'),
    r(2, 'no absence evidence: looks absent'),
  ]);
  const unverified = groups.find((g) => g.key === 'cause unverified');
  expect(unverified?.reason).toBe("the model's proposed query did not reproduce the target");
  expect(unverified?.rows.map((x) => x.beer_id)).toEqual([1]);
  const absence = groups.find((g) => g.key === 'absence not probed');
  expect(absence?.reason).toBe('absence was never probed');
  expect(absence?.rows.map((x) => x.beer_id)).toEqual([2]);
});

// #509 fix round 3 (MINOR 7): OFF_SCOPE's `.` excludes newlines, and review_note is free
// text that can contain one (the model's own tail, or retireEnrichFailure's ` | `-joined
// fragments). Before this fix a note that failed to parse for ANY reason was assumed to be
// an absence note — a newline-bearing off-scope note would then be displayed with the
// reason "absence was never probed", which is simply false for a row that was never about
// absence at all.
test('a note that fails to parse (e.g. a newline inside an off-scope note) reads as unrecognised, not as an absence note', () => {
  const groups = groupOwnerless([
    r(1, 'off-scope #300: candidates_count = 0\nextra line the regex cannot span'),
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].key).toBe('unrecognised');
  expect(groups[0].reason).toBe('note format not recognised');
});
