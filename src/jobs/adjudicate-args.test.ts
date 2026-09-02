import { parseAdjudicateArgs } from './adjudicate-args';

describe('parseAdjudicateArgs', () => {
  it('parses a bare --issue as a probe with no limit', () => {
    expect(parseAdjudicateArgs(['--issue', '558'])).toEqual({ mode: 'probe', issue: 558 });
  });

  it('parses --issue with --limit as a probe with a limit', () => {
    expect(parseAdjudicateArgs(['--issue', '558', '--limit', '2'])).toEqual({
      mode: 'probe', issue: 558, limit: 2,
    });
  });

  it('accepts the flags in either order', () => {
    expect(parseAdjudicateArgs(['--limit', '3', '--issue', '558'])).toEqual({
      mode: 'probe', issue: 558, limit: 3,
    });
  });

  it('parses --apply as an apply, force defaulting to false', () => {
    expect(parseAdjudicateArgs(['--apply', '/tmp/x.json'])).toEqual({
      mode: 'apply', path: '/tmp/x.json', force: false,
    });
  });

  it('parses --apply with --force', () => {
    expect(parseAdjudicateArgs(['--apply', '/tmp/x.json', '--force'])).toEqual({
      mode: 'apply', path: '/tmp/x.json', force: true,
    });
  });

  it('rejects no arguments at all', () => {
    expect(parseAdjudicateArgs([])).toEqual({ mode: 'usage', reason: expect.any(String) });
  });

  // I2: `--issue abc` used to become `NaN`, silently slicing the row list to `[]` — a rejected
  // argument that looked exactly like "this issue has no rows left".
  it('rejects a non-numeric --issue', () => {
    const out = parseAdjudicateArgs(['--issue', 'abc']);
    expect(out.mode).toBe('usage');
    expect((out as { reason: string }).reason).toMatch(/--issue must be a plain integer/);
  });

  // I2: `parseInt('558x', 10)` is `558` — a typo silently coerced into a different, valid issue.
  it('rejects a trailing-garbage --issue', () => {
    const out = parseAdjudicateArgs(['--issue', '558x']);
    expect(out.mode).toBe('usage');
  });

  it('rejects a decimal --issue', () => {
    expect(parseAdjudicateArgs(['--issue', '5.5']).mode).toBe('usage');
  });

  it('rejects a negative --issue', () => {
    expect(parseAdjudicateArgs(['--issue', '-5']).mode).toBe('usage');
  });

  // I2: the `=` form (`--issue=558`) is not read by `argv.indexOf('--issue')` at all — it must
  // be REJECTED, not silently treated as "flag absent".
  it('rejects the --issue=n equals form', () => {
    const out = parseAdjudicateArgs(['--issue=558']);
    expect(out.mode).toBe('usage');
    expect((out as { reason: string }).reason).toMatch(/--flag=value/);
  });

  it('rejects the --limit=n equals form even with a valid --issue', () => {
    const out = parseAdjudicateArgs(['--issue', '558', '--limit=2']);
    expect(out.mode).toBe('usage');
  });

  // I2: `--limit=2` used to be silently ignored (indexOf found nothing), turning a requested
  // 2-row trial into an unbounded full pass over the issue.
  it('rejects --limit 0', () => {
    const out = parseAdjudicateArgs(['--issue', '558', '--limit', '0']);
    expect(out.mode).toBe('usage');
    expect((out as { reason: string }).reason).toMatch(/--limit must be an integer >= 1/);
  });

  it('rejects a negative --limit', () => {
    expect(parseAdjudicateArgs(['--issue', '558', '--limit', '-1']).mode).toBe('usage');
  });

  it('rejects a non-numeric --limit', () => {
    expect(parseAdjudicateArgs(['--issue', '558', '--limit', 'abc']).mode).toBe('usage');
  });

  it('rejects an unknown flag', () => {
    const out = parseAdjudicateArgs(['--issue', '558', '--bogus', 'x']);
    expect(out.mode).toBe('usage');
    expect((out as { reason: string }).reason).toMatch(/unknown flag/);
  });

  // I2: today `--apply` silently wins over `--issue` when both are given — a mistyped command
  // line runs the wrong mode without any complaint.
  it('rejects --apply and --issue given together', () => {
    const out = parseAdjudicateArgs(['--apply', '/tmp/x.json', '--issue', '558']);
    expect(out.mode).toBe('usage');
    expect((out as { reason: string }).reason).toMatch(/mutually exclusive/);
  });

  it('rejects --apply with no path', () => {
    expect(parseAdjudicateArgs(['--apply']).mode).toBe('usage');
  });
});
