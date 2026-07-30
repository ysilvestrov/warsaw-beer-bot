import {
  EMPTY_USAGE,
  addUsage,
  costUsd,
  formatCostLine,
  formatTokens,
  parseUsage,
  PRICES,
  PRICES_CHECKED_ON,
} from './usage';

describe('parseUsage', () => {
  it('reads the OpenAI usage block including cached and reasoning details', () => {
    const u = parseUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 512 },
      completion_tokens_details: { reasoning_tokens: 150 },
    });
    expect(u).toEqual({
      calls: 1,
      promptTokens: 1000,
      cachedTokens: 512,
      completionTokens: 200,
      reasoningTokens: 150,
    });
  });

  it('counts the call even when the API sends no usage block at all', () => {
    expect(parseUsage(undefined)).toEqual({
      calls: 1,
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('ignores non-numeric junk instead of producing NaN totals', () => {
    const u = parseUsage({ prompt_tokens: 'lots', completion_tokens: 7 });
    expect(u.promptTokens).toBe(0);
    expect(u.completionTokens).toBe(7);
  });
});

describe('addUsage', () => {
  it('sums every field across stages', () => {
    const a = { calls: 1, promptTokens: 10, cachedTokens: 2, completionTokens: 3, reasoningTokens: 1 };
    const b = { calls: 2, promptTokens: 40, cachedTokens: 0, completionTokens: 5, reasoningTokens: 4 };
    expect(addUsage(a, b)).toEqual({
      calls: 3,
      promptTokens: 50,
      cachedTokens: 2,
      completionTokens: 8,
      reasoningTokens: 5,
    });
  });

  it('is the identity on EMPTY_USAGE', () => {
    const a = { calls: 1, promptTokens: 10, cachedTokens: 2, completionTokens: 3, reasoningTokens: 1 };
    expect(addUsage(EMPTY_USAGE, a)).toEqual(a);
  });
});

describe('costUsd', () => {
  it('bills uncached input, cached input and output at their own rates', () => {
    // gpt-5.5: $5/M input, $0.50/M cached input, $30/M output.
    const cost = costUsd('gpt-5.5', {
      calls: 1,
      promptTokens: 1_000_000,
      cachedTokens: 400_000,
      completionTokens: 100_000,
      reasoningTokens: 60_000,
    });
    // 600k uncached * $5/M = 3.00; 400k cached * $0.50/M = 0.20; 100k out * $30/M = 3.00
    expect(cost).toBeCloseTo(6.2, 6);
  });

  it('does not bill reasoning tokens twice — they are already inside completion_tokens', () => {
    const withReasoning = costUsd('gpt-5.5', {
      calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 1000, reasoningTokens: 900,
    });
    const without = costUsd('gpt-5.5', {
      calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 1000, reasoningTokens: 0,
    });
    expect(withReasoning).toBe(without);
  });

  it('returns null for a model with no verified price rather than a wrong number', () => {
    // Real usage, not EMPTY_USAGE: a stage that never called anything costs 0
    // at any model, so an empty one would pass this test without testing it.
    expect(
      costUsd('gpt-9-imaginary', {
        calls: 1, promptTokens: 1000, cachedTokens: 0, completionTokens: 100, reasoningTokens: 0,
      }),
    ).toBeNull();
  });

  it('carries the date its prices were last checked', () => {
    expect(PRICES['gpt-5.5']).toEqual({ input: 5, cachedInput: 0.5, output: 30 });
    expect(PRICES_CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatTokens', () => {
  it('abbreviates thousands to one decimal and leaves small counts alone', () => {
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(0)).toBe('0');
  });
});

describe('formatCostLine', () => {
  const find = { calls: 1, promptTokens: 12_300, cachedTokens: 0, completionTokens: 3100, reasoningTokens: 1900 };
  const verify = { calls: 2, promptTokens: 8000, cachedTokens: 0, completionTokens: 900, reasoningTokens: 0 };

  it('reports both stages, this run and the PR total', () => {
    const line = formatCostLine({ find, verify, runUsd: 0.07, totalUsd: 0.21, unpriced: 0 });
    expect(line).toBe(
      'find 1 call 12.3k→3.1k (1.9k reasoning) · verify 2 calls 8.0k→900 · this run $0.07 · PR total $0.21',
    );
  });

  it('says so plainly when the find pass was skipped', () => {
    const line = formatCostLine({ find: EMPTY_USAGE, verify, runUsd: 0.02, totalUsd: 0.23, unpriced: 0 });
    expect(line).toContain('find skipped');
  });

  it('marks the total as a lower bound when some runs could not be priced', () => {
    const line = formatCostLine({ find, verify, runUsd: null, totalUsd: 0.21, unpriced: 2 });
    expect(line).toContain('this run — (unpriced model)');
    expect(line).toContain('PR total $0.21+');
  });
});

describe('costUsd — a stage that made no calls', () => {
  it('costs nothing even at a model with no verified price', () => {
    // Zero tokens cost zero dollars whatever the rates are; returning null here
    // would mark a whole run unpriced because a skipped stage had no price.
    expect(costUsd('some-unpriced-model', EMPTY_USAGE)).toBe(0);
    expect(costUsd('gpt-5.5', EMPTY_USAGE)).toBe(0);
  });

  it('still refuses to price real usage at an unknown model', () => {
    expect(costUsd('some-unpriced-model', { ...EMPTY_USAGE, calls: 1, promptTokens: 10 })).toBeNull();
  });
});

describe('costUsd — the zero-cost shortcut means "nothing happened at all"', () => {
  it('still prices tokens that arrived without a call count', () => {
    // The guard exists for a stage that never ran; money lives in the token
    // fields, so an inconsistent usage must be priced, never silently zeroed.
    const usd = costUsd('gpt-5.5', {
      calls: 0, promptTokens: 1000, cachedTokens: 0, completionTokens: 100, reasoningTokens: 0,
    });
    expect(usd).toBeGreaterThan(0);
  });

  it('prices cached input tokens, which are billable on their own', () => {
    const usd = costUsd('gpt-5.5', {
      calls: 1, promptTokens: 0, cachedTokens: 1000, completionTokens: 0, reasoningTokens: 0,
    });
    expect(usd).toBeGreaterThan(0);
  });

  it('admits a call on an unpriced model even when the API sent no usage block', () => {
    // parseUsage(undefined) counts the call with zero tokens. The dollars are
    // unknown, not zero: reporting $0 would drop the `+` lower-bound marker and
    // claim a precision we do not have.
    expect(costUsd('some-unpriced-model', parseUsage(undefined))).toBeNull();
  });
});

describe('costUsd — a call whose usage block never arrived', () => {
  it('is unknown cost, not zero, even at a priced model', () => {
    // A completion always consumed tokens; if the API did not tell us how many,
    // printing $0.00 claims a precision we do not have. Unknown is admitted the
    // same way an unpriced model is: no dollars, and the PR total marked `+`.
    expect(costUsd('gpt-5.5', parseUsage(undefined))).toBeNull();
  });
});
