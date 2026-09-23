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
});
