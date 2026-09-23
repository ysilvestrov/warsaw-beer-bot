import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE } from './usage';
import { formatReport } from './verify-corpus-report';
import { resolveArgs } from './verify-corpus-cli';
import type { EntryOutcome } from './verify-corpus-run';

const outcome = (over: Partial<EntryOutcome>): EntryOutcome => ({
  id: 'a',
  expected: 'confirmed',
  actual: 'confirmed',
  correct: true,
  evidence: 'e',
  provenance: 'harvested',
  ...over,
});

const usage = { ...EMPTY_USAGE, calls: 1, promptTokens: 100, completionTokens: 10 };

describe('formatReport', () => {
  // Global constraint: the corpus is skewed (6 confirmed vs 13 refuted when
  // complete), so a judge answering `refuted` to everything scores 68%. A single
  // percentage would hide exactly that, so the report must not print one.
  it('reports counts per expected verdict, not one overall percentage', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [[outcome({ id: 'a', expected: 'confirmed', actual: 'confirmed', correct: true }),
               outcome({ id: 'b', expected: 'refuted', actual: 'confirmed', correct: false })]],
      usage,
      costUsd: 0.01,
    });
    expect(text).toMatch(/confirmed\D+1\/1/);
    expect(text).toMatch(/refuted\D+0\/1/);
    expect(text).not.toMatch(/\b50%/);
  });

  // I4 (final review): asserting only the presence of the words 'harvested' and
  // 'constructed', plus the absence of a string the report can never print,
  // stays green even if both tallies were replaced by the merged total —
  // mutation-proven below. Pin the actual counts from this seed instead.
  it('keeps provenance counts separate', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [[outcome({ id: 'a', provenance: 'harvested', correct: true }),
               outcome({ id: 'b', provenance: 'constructed', expected: 'refuted', actual: 'confirmed', correct: false })]],
      usage,
      costUsd: null,
    });
    // Anchored to the per-draw line specifically: the union/consensus lines
    // compute their own provenance split independently, so a mutation that only
    // breaks the per-draw tally would otherwise still leave an unanchored regex
    // passing against those.
    expect(text).toMatch(/draw 1:.*harvested 1\/1/);
    expect(text).toMatch(/draw 1:.*constructed 0\/1/);
    // Provenances must not be merged into one figure.
    expect(text).not.toMatch(/all sources\D+1\/2/);
  });

  // I4 (final review): `\D` matches newlines, so `/error\D+1/` was satisfied by
  // unrelated text two lines apart (the drill-down heading plus the cost line's
  // "1 call(s)") — deleting the error column entirely left this passing.
  // Mutation-proven below. Anchor to the rendered draw line instead.
  // PR #698 review, P1: an `error` is a harness failure that reached no judgement,
  // so charging it to the model reproduces #691 at the level of the scoreboard —
  // a judge that answered every readable entry perfectly would print
  // `confirmed 5/6`, indistinguishable from one that got an answer wrong.
  it('excludes an errored entry from the scored ratio rather than counting it wrong', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [[
        outcome({ id: 'a', expected: 'confirmed', actual: 'confirmed', correct: true }),
        outcome({ id: 'b', expected: 'confirmed', actual: 'error', correct: false }),
      ]],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/draw 1: confirmed 1\/1 /);
    expect(text).not.toMatch(/confirmed 1\/2/);
  });

  // The exclusion must never be silent: a shrinking denominator has to be visible
  // beside the ratio, or a corpus half of which failed to load reads as a clean run.
  it('names entries that no draw could score', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [
        [outcome({ id: 'a', actual: 'error', correct: false })],
        [outcome({ id: 'a', actual: 'error', correct: false })],
      ],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/union .*· not scored 1/);
    expect(text).toMatch(/consensus .*· not scored 1/);
  });

  // An entry that errored in one draw and was judged in another is scored on the
  // draw that produced a verdict — it is not thrown away, and not marked unscored.
  it('scores an entry on the draws that produced a verdict', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [
        [outcome({ id: 'a', expected: 'confirmed', actual: 'error', correct: false })],
        [outcome({ id: 'a', expected: 'confirmed', actual: 'confirmed', correct: true })],
      ],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/consensus .*confirmed 1\/1/);
    expect(text).not.toMatch(/not scored/);
  });

  it('counts errors in their own column', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [[outcome({ id: 'a', actual: 'error', correct: false })]],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/draw 1:.*· error 1$/m);
  });

  it('prints a union line across draws', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [
        [outcome({ id: 'a', correct: false, actual: 'refuted' })],
        [outcome({ id: 'a', correct: true, actual: 'confirmed' })],
      ],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/union/i);
  });

  // I3 + M4 (final review): verdicts are binary, so a coin-flipper is right at
  // least once per entry with p ≈ 1 - 0.5^N over N draws (≈0.875 at N=3) — its
  // union row reads identical to a perfect judge's. Consensus (correct in EVERY
  // draw) is the number that cannot be faked this way, so it must show the
  // shortfall a chance-level run leaves in the union, and the drill-down (keyed
  // off "wrong in any draw") must be non-empty even though the union is full.
  it('separates consensus from union: the union alone cannot catch a coin-flipper', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [
        [outcome({ id: 'a', expected: 'confirmed', actual: 'refuted', correct: false })],
        [outcome({ id: 'a', expected: 'confirmed', actual: 'confirmed', correct: true })],
      ],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/union \(correct in any of 2 draws\):.*confirmed 1\/1/);
    expect(text).toMatch(/consensus \(correct in all 2 draws\):.*confirmed 0\/1/);
    // The union is full (1/1), so the old union-keyed drill-down would be blank
    // here — exactly when a flip-flop most needs to be shown.
    expect(text).toMatch(/a: expected confirmed — draw 1 refuted, draw 2 confirmed/);
  });

  it('gives the consensus line the provenance split too', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [
        [outcome({ id: 'a', provenance: 'harvested', correct: true }),
         outcome({ id: 'b', provenance: 'constructed', expected: 'refuted', actual: 'confirmed', correct: false })],
      ],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/consensus \(correct in all 1 draws\):.*harvested 1\/1.*constructed 0\/1/);
  });

  it('names the cost as unpriced rather than zero when the model has no price', () => {
    const text = formatReport({ model: 'mystery-1', draws: [[outcome({})]], usage, costUsd: null });
    expect(text).toMatch(/unpriced/);
    expect(text).not.toMatch(/\$0\.00/);
  });

  // M5 (final review): a filtered run must never be indistinguishable from a
  // full one — the header is the only place a reader who pastes the report
  // elsewhere will see the filter.
  it('echoes the active --only filter in the header', () => {
    const text = formatReport({ model: 'gpt-5.5', draws: [[outcome({})]], usage, costUsd: null, only: '0726' });
    expect(text).toMatch(/FILTERED by --only 0726/);
  });

  it('omits the filter marker when no --only was given', () => {
    const text = formatReport({ model: 'gpt-5.5', draws: [[outcome({})]], usage, costUsd: null });
    expect(text).not.toMatch(/FILTERED/);
  });
});

describe('resolveArgs', () => {
  it('reads the model and the draw count', () => {
    expect(resolveArgs(['--model', 'gpt-5.5', '--draws', '3'])).toEqual({
      check: false,
      model: 'gpt-5.5',
      draws: 3,
      only: undefined,
    });
  });

  it('defaults to one draw', () => {
    expect(resolveArgs(['--model', 'gpt-5.5']).draws).toBe(1);
  });

  it('requires a model', () => {
    expect(() => resolveArgs([])).toThrow(/--model/);
  });

  // A typo must stop the run, not silently measure something else — the same rule
  // the replay CLI follows for unrecognised tokens.
  it('rejects an unrecognised argument', () => {
    expect(() => resolveArgs(['--modle', 'gpt-5.5'])).toThrow(/unrecognised/);
  });

  it('rejects a non-positive draw count', () => {
    expect(() => resolveArgs(['--model', 'm', '--draws', '0'])).toThrow(/--draws/);
  });

  // M5 (final review): the old parser let `--only` as the last token silently
  // become `undefined`, which reads as "no filter" and quietly runs the whole
  // corpus instead of stopping.
  it('rejects a valueless --only', () => {
    expect(() => resolveArgs(['--model', 'm', '--only'])).toThrow(/--only/);
  });

  // PR #698 review, P1: the M5 fix only guarded `undefined`. An EMPTY value —
  // the shape an unexpanded shell variable produces — still read as "no filter"
  // downstream (`only ? filter : all`), so the operator asked for a subset and
  // silently paid for the whole corpus, with no FILTERED marker to show it.
  it('rejects an empty --only value', () => {
    expect(() => resolveArgs(['--model', 'm', '--only', ''])).toThrow(/--only/);
  });

  it('rejects a whitespace-only --only value', () => {
    expect(() => resolveArgs(['--model', 'm', '--only', '   '])).toThrow(/--only/);
  });

  // PR #698 review, P2: `--check` used to return before the draw-count check, so
  // `--draws 0` and even a valueless `--draws` were accepted and then ignored.
  // The fix that actually closes it is rejecting the combination outright —
  // `--check` never calls a model, so a draw count there is a misunderstanding
  // worth naming rather than discarding. Asserting the specific message keeps
  // this test honest about WHICH guard fires: a bare `/--draws/` would also be
  // satisfied by the positive-integer error and prove less than it appears to.
  it('rejects --draws combined with --check, whatever the value', () => {
    for (const argv of [['--check', '--draws', '3'], ['--check', '--draws', '0'], ['--check', '--draws']]) {
      expect(() => resolveArgs(argv)).toThrow(/--draws is meaningless with --check/);
    }
  });
});
