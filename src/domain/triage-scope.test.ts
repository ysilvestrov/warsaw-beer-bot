import {
  isLegalScope, rowSatisfiesScope, renderScopeBlock, parseScopeBlock, stripScopeBlocks,
  type Scope,
} from './triage-scope';
import type { UntriagedFailure } from '../storage/enrich_failures';

const row = (over: Partial<UntriagedFailure> = {}): UntriagedFailure => ({
  beer_id: 1, brewery: 'Mad Brew', name: 'Bulgogi', search_url: 'https://x/?q=a',
  source_url: 'https://flasker.com.ua/p/1', candidates_count: 3, candidates_summary: '',
  fail_count: 1, last_at: '2026-08-14T00:00:00.000Z', abv: 4.2, style: 'IPA', ...over,
});

test('a where-scope of review_class alone is illegal', () => {
  const scope: Scope = { beer_ids: [], where: [{ col: 'review_class', op: '=', value: 'matcher_bug' }] };
  expect(isLegalScope(scope)).toBe(false);
});

test('review_class plus one other column is legal', () => {
  const scope: Scope = {
    beer_ids: [],
    where: [
      { col: 'review_class', op: '=', value: 'matcher_bug' },
      { col: 'candidates_count', op: '=', value: 0 },
    ],
  };
  expect(isLegalScope(scope)).toBe(true);
});

test('an enumerated cohort alone is legal', () => {
  expect(isLegalScope({ beer_ids: [34005, 11952], where: [] })).toBe(true);
});

// A cohort does not launder a whole-class `where`. rowSatisfiesScope ORs the two, so
// for every row OUTSIDE the cohort the `where` is what decides — and a review_class-only
// `where` matches every future row of that class, which is the dumping-ground shape
// wearing a cohort as a disguise.
test('a cohort does not make a review_class-only where legal', () => {
  expect(isLegalScope({
    beer_ids: [1],
    where: [{ col: 'review_class', op: '=', value: 'matcher_bug' }],
  })).toBe(false);
});

test('an empty scope is illegal', () => {
  expect(isLegalScope({ beer_ids: [], where: [] })).toBe(false);
});

test('a row in beer_ids satisfies the scope regardless of where', () => {
  const scope: Scope = { beer_ids: [1], where: [{ col: 'candidates_count', op: '=', value: 0 }] };
  expect(rowSatisfiesScope(row({ candidates_count: 9 }), 'matcher_bug', scope)).toBe(true);
});

test('a zero-candidate row does not satisfy a candidates_count > 0 scope', () => {
  const scope: Scope = { beer_ids: [], where: [{ col: 'candidates_count', op: '>', value: 0 }] };
  expect(rowSatisfiesScope(row({ candidates_count: 0 }), 'matcher_bug', scope)).toBe(false);
});

test('review_class is matched against the verdict class, not the row', () => {
  const scope: Scope = {
    beer_ids: [],
    where: [
      { col: 'review_class', op: '=', value: 'parser_bug' },
      { col: 'source_url', op: 'contains', value: 'flasker' },
    ],
  };
  expect(rowSatisfiesScope(row(), 'parser_bug', scope)).toBe(true);
  expect(rowSatisfiesScope(row(), 'matcher_bug', scope)).toBe(false);
});

test('an empty where never satisfies vacuously', () => {
  expect(rowSatisfiesScope(row(), 'matcher_bug', { beer_ids: [2], where: [] })).toBe(false);
});

test('string and null operators', () => {
  expect(rowSatisfiesScope(row({ brewery: '' }), 'matcher_bug',
    { beer_ids: [], where: [{ col: 'brewery', op: 'empty' }] })).toBe(true);
  expect(rowSatisfiesScope(row({ abv: null }), 'matcher_bug',
    { beer_ids: [], where: [{ col: 'abv', op: 'is_null' }] })).toBe(true);
  expect(rowSatisfiesScope(row({ style: 'IPA' }), 'matcher_bug',
    { beer_ids: [], where: [{ col: 'style', op: 'is_not_null' }] })).toBe(true);
});

test('render then parse round-trips a scope', () => {
  const scope: Scope = {
    beer_ids: [34005, 11952],
    where: [{ col: 'candidates_count', op: '=', value: 0 }],
  };
  const body = `Some prose about the pattern.\n\n${renderScopeBlock(scope)}\n\nMore prose.`;
  expect(parseScopeBlock(body)).toEqual(scope);
});

test('a body with no block is unscoped', () => {
  expect(parseScopeBlock("Scope: all orphans in this class — enrich_failures WHERE review_class='matcher_bug'."))
    .toBeNull();
});

test('a malformed or unknown-column block is unscoped, never a throw', () => {
  expect(parseScopeBlock('```triage-scope\n{not json\n```')).toBeNull();
  expect(parseScopeBlock('```triage-scope\n{"beer_ids":[],"where":[{"col":"secret","op":"=","value":1}]}\n```'))
    .toBeNull();
});

test('the rendered block carries a human-readable Scope line next to it', () => {
  const out = renderScopeBlock({ beer_ids: [7], where: [{ col: 'brewery', op: 'empty' }] });
  expect(out).toContain('```triage-scope');
  expect(out).toContain('Scope:');
  expect(out).toContain('brewery empty');
  expect(out).toContain('7');
});

test('a contains value holding a backtick fence still round-trips', () => {
  // A free-text `contains` value is not restricted from containing backticks. JSON
  // does not escape them, so an unescaped run of three backticks inside the payload
  // would read as the fence's own closing delimiter and truncate the capture.
  const scope: Scope = {
    beer_ids: [],
    where: [{ col: 'source_url', op: 'contains', value: 'a```b' }],
  };
  expect(parseScopeBlock(renderScopeBlock(scope))).toEqual(scope);
});

// The issue BODY is model-authored free text, and it is concatenated before our
// rendered block. A fence the model writes there would win the first-match race exactly
// like an unescaped prose value did — same defect, the other input.
test('stripScopeBlocks removes a model-authored fence so ours is the only one', () => {
  const hostile = 'prose\n\n```triage-scope\n{"beer_ids":[999],"where":[]}\n```\n\nmore prose';
  const cleaned = stripScopeBlocks(hostile);
  expect(cleaned).not.toContain('triage-scope');
  expect(cleaned).toContain('prose');
  expect(cleaned).toContain('more prose');

  const body = `${cleaned}\n\n${renderScopeBlock({ beer_ids: [1], where: [] })}`;
  expect(parseScopeBlock(body)).toEqual({ beer_ids: [1], where: [] });
});

test('stripScopeBlocks removes every fence, not just the first', () => {
  const hostile = 'a\n```triage-scope\n{"beer_ids":[1],"where":[]}\n```\nb\n'
    + '```triage-scope\n{"beer_ids":[2],"where":[]}\n```\nc';
  expect(stripScopeBlocks(hostile)).not.toContain('triage-scope');
});

test('stripScopeBlocks leaves ordinary fenced code alone', () => {
  const body = 'see:\n\n```sql\nSELECT 1;\n```\n';
  expect(stripScopeBlocks(body)).toBe(body);
});

// The `Scope:` prose line is rendered BEFORE the fenced block, and BLOCK_RE takes the
// FIRST match, so an unescaped fence inside a free-text `contains` value opens a
// spurious block ahead of the real one. The dangerous case is not a parse failure but
// a SILENT WRONG ANSWER: the payload below is itself valid JSON matching ScopeSchema,
// so without the fix parseScopeBlock returns {beer_ids:[999]} — a scope nobody wrote.
test('a contains value that looks like a scope block cannot hijack the parse', () => {
  const scope: Scope = {
    beer_ids: [],
    where: [{
      col: 'source_url',
      op: 'contains',
      value: '```triage-scope\n{"beer_ids":[999],"where":[]}\n```',
    }],
  };
  expect(parseScopeBlock(renderScopeBlock(scope))).toEqual(scope);
});
