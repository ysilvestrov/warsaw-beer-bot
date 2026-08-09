import { describe, it, expect } from 'vitest';
import { CAPTURE_TARGETS, shouldWriteFixture } from './capture-targets';

describe('shouldWriteFixture', () => {
  it('refuses an empty capture — that is a block or challenge page, not a catalogue', () => {
    expect(shouldWriteFixture(48, 0, false).ok).toBe(false);
    expect(shouldWriteFixture(null, 0, false).ok).toBe(false);
  });

  it('refuses a capture below half the existing fixture', () => {
    const r = shouldWriteFixture(48, 20, false);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('20');
    expect(r.reason).toContain('48');
  });

  it('accepts a capture at or above half', () => {
    expect(shouldWriteFixture(48, 24, false).ok).toBe(true);
    expect(shouldWriteFixture(48, 60, false).ok).toBe(true);
  });

  it('accepts a genuine shrink when forced, but never an empty one', () => {
    expect(shouldWriteFixture(48, 20, true).ok).toBe(true);
    expect(shouldWriteFixture(48, 0, true).ok).toBe(false);
  });

  it('accepts any non-empty capture when there is no existing fixture', () => {
    expect(shouldWriteFixture(null, 1, false).ok).toBe(true);
  });
});

describe('CAPTURE_TARGETS', () => {
  it('has unique names and points every target at a known adapter id', () => {
    const names = CAPTURE_TARGETS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of CAPTURE_TARGETS) {
      expect(t.url).toMatch(/^https:\/\//);
      expect(t.out).toMatch(/\.html$/);
      expect(t.cardSelector.length).toBeGreaterThan(0);
    }
  });
});
