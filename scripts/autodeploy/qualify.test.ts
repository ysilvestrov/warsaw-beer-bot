import { describe, it, expect } from 'vitest';
import { qualify, needsHoldCheck, HOLD_HOURS, type AuditReport } from './qualify';

const NOW = new Date('2026-08-16T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const report = (v: Record<string, 'low' | 'moderate' | 'high' | 'critical'>): AuditReport => ({
  vulnerabilities: Object.fromEntries(Object.entries(v).map(([k, s]) => [k, { severity: s }])),
});

describe('qualify', () => {
  it('refuses when the base has no production advisory at all', () => {
    const r = qualify({ base: report({}), head: report({}), publishedAt: hoursAgo(999), now: NOW });
    expect(r.verdict).toBe('manual');
    expect(r.reason).toMatch(/no high or critical/i);
  });

  it('refuses when the base is vulnerable only below the threshold', () => {
    const r = qualify({
      base: report({ postcss: 'moderate' }), head: report({}),
      publishedAt: hoursAgo(999), now: NOW,
    });
    expect(r.verdict).toBe('manual');
  });

  it('refuses when the head is still vulnerable', () => {
    const r = qualify({
      base: report({ undici: 'high' }), head: report({ undici: 'high' }),
      publishedAt: hoursAgo(999), now: NOW,
    });
    expect(r.verdict).toBe('manual');
    expect(r.reason).toMatch(/still/i);
  });

  it('deploys a critical immediately, with no hold', () => {
    const r = qualify({
      base: report({ undici: 'critical' }), head: report({}),
      publishedAt: hoursAgo(0), now: NOW,
    });
    expect(r.verdict).toBe('autodeploy');
  });

  it('holds a high whose fix is younger than the hold', () => {
    const r = qualify({
      base: report({ undici: 'high' }), head: report({}),
      publishedAt: hoursAgo(HOLD_HOURS - 1), now: NOW,
    });
    expect(r.verdict).toBe('hold');
    expect(r.reason).toMatch(/48/);
  });

  it('deploys a high whose fix has aged past the hold', () => {
    const r = qualify({
      base: report({ undici: 'high' }), head: report({}),
      publishedAt: hoursAgo(HOLD_HOURS + 1), now: NOW,
    });
    expect(r.verdict).toBe('autodeploy');
  });

  it('holds a high whose publish time is unparseable, never falling through to autodeploy', () => {
    // Guards the C3 fix: `!Number.isFinite(ageHours)` must force a hold. An
    // invalid Date's getTime() is NaN, which makes every `<` comparison false
    // — deleting the guard would let this fall through to the autodeploy
    // return at the bottom of qualify() while the suite stays green.
    const r = qualify({
      base: report({ undici: 'high' }), head: report({}),
      publishedAt: new Date('nonsense'), now: NOW,
    });
    expect(r.verdict).toBe('hold');
  });

  it('takes the highest base severity, so one critical lifts the hold off a mixed batch', () => {
    const r = qualify({
      base: report({ undici: 'high', hono: 'critical' }), head: report({}),
      publishedAt: hoursAgo(1), now: NOW,
    });
    expect(r.verdict).toBe('autodeploy');
  });
});

describe('needsHoldCheck — true only when the verdict actually depends on the fix\'s age', () => {
  // #435 amendment: qualify-cli.ts's main() used to call selectPublishedAt
  // (an npm registry lookup per changed package) unconditionally, before
  // qualify() ever ran. Once selectPublishedAt scans every changed package
  // rather than only base-audit-flagged ones, that meant a lookup per
  // changed package even for a PR whose base audit is clean and can only
  // ever be `manual` — e.g. a 13-package non-security bump, firing 13 wasted
  // registry requests on every hourly re-evaluation. needsHoldCheck lets the
  // caller skip that work exactly when qualify()'s own verdict cannot
  // possibly depend on it.

  it('is true for a cleared high — this is the one case that needs a publish time', () => {
    expect(needsHoldCheck(report({ undici: 'high' }), report({}))).toBe(true);
  });

  it('is false for a clean base — verdict is manual regardless of any age', () => {
    expect(needsHoldCheck(report({}), report({}))).toBe(false);
  });

  it('is false when the head is still vulnerable — verdict is manual regardless of any age', () => {
    expect(needsHoldCheck(report({ undici: 'high' }), report({ undici: 'high' }))).toBe(false);
  });

  it('is false for a cleared critical — it autodeploys with no hold, needing no publish time', () => {
    expect(needsHoldCheck(report({ undici: 'critical' }), report({}))).toBe(false);
  });
});

describe('qualify — the publishedAt=null guard', () => {
  it('THROWS when handed publishedAt: null on a path that needs a hold check', () => {
    // Constructed directly, the way the design requires: a cleared `high`
    // with a null publish time is exactly the shape needsHoldCheck(base,
    // head) would have said "true" for.
    const base = report({ undici: 'high' });
    const head = report({});
    expect(() => qualify({ base, head, publishedAt: null, now: NOW })).toThrow(
      /needsHoldCheck.*qualify.*disagree/is,
    );
  });

  it('does NOT throw for a cleared critical with publishedAt: null — it never reaches the age check', () => {
    const r = qualify({ base: report({ undici: 'critical' }), head: report({}), publishedAt: null, now: NOW });
    expect(r.verdict).toBe('autodeploy');
  });

  it('the exact needsHoldCheck → qualify pipeline main() uses: agreeing, it never throws', () => {
    // This chains the REAL needsHoldCheck into the REAL qualify(), exactly
    // as qualify-cli.ts's main() is wired: ask needsHoldCheck whether an age
    // check is needed, and only compute (here: supply) a publish time if so.
    // This is the MUTATION-PROOF vehicle: mutating needsHoldCheck to always
    // `return false` makes this test throw instead of returning 'autodeploy'
    // — the guard fires in a test rather than a wrong verdict being
    // returned. (Measured 2026-08-18: confirmed red with that mutation,
    // assertion message included in the #435 report; restored immediately
    // after.)
    const base = report({ undici: 'high' });
    const head = report({});
    const publishedAt = needsHoldCheck(base, head) ? hoursAgo(HOLD_HOURS + 1) : null;
    const r = qualify({ base, head, publishedAt, now: NOW });
    expect(r.verdict).toBe('autodeploy');
  });
});
