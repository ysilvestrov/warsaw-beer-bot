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

  it('keeps provenance counts separate', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [[outcome({ id: 'a', provenance: 'harvested', correct: true }),
               outcome({ id: 'b', provenance: 'constructed', expected: 'refuted', actual: 'confirmed', correct: false })]],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/harvested/);
    expect(text).toMatch(/constructed/);
    // Provenances must not be merged into one figure.
    expect(text).not.toMatch(/all sources\D+1\/2/);
  });

  it('counts errors in their own column', () => {
    const text = formatReport({
      model: 'gpt-5.5',
      draws: [[outcome({ id: 'a', actual: 'error', correct: false })]],
      usage,
      costUsd: null,
    });
    expect(text).toMatch(/error\D+1/);
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

  it('names the cost as unpriced rather than zero when the model has no price', () => {
    const text = formatReport({ model: 'mystery-1', draws: [[outcome({})]], usage, costUsd: null });
    expect(text).toMatch(/unpriced/);
    expect(text).not.toMatch(/\$0\.00/);
  });
});

describe('resolveArgs', () => {
  it('reads the model and the draw count', () => {
    expect(resolveArgs(['--model', 'gpt-5.5', '--draws', '3'])).toEqual({
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
});
