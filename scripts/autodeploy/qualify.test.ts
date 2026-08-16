import { describe, it, expect } from 'vitest';
import { qualify, HOLD_HOURS, type AuditReport } from './qualify';

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

  it('takes the highest base severity, so one critical lifts the hold off a mixed batch', () => {
    const r = qualify({
      base: report({ undici: 'high', hono: 'critical' }), head: report({}),
      publishedAt: hoursAgo(1), now: NOW,
    });
    expect(r.verdict).toBe('autodeploy');
  });
});
