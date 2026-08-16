import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditReport,
  resolvedVersions,
  selectPublishedAt,
  type LockPackages,
} from './qualify-cli';
import type { AuditReport, Severity } from './qualify';

/**
 * #435 — the I/O bridge.
 *
 * Every one of the three fail-open defects the review found lived in exactly
 * the two functions that no test and no smoke run had ever executed: the
 * lockfile lookup and the publish-time selection. The unit tests covered the
 * pure functions, and the smoke test ran against a repo whose production audit
 * is clean — so the loop body never entered even once. These tests exist to
 * make that impossible again.
 */

function dirWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-qualify-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const report = (v: Record<string, Severity>): AuditReport => ({
  vulnerabilities: Object.fromEntries(Object.entries(v).map(([k, s]) => [k, { severity: s }])),
});

const lock = (entries: Record<string, string>): LockPackages =>
  Object.fromEntries(Object.entries(entries).map(([path, version]) => [path, { version }]));

describe('auditReport — an absent report must be an error, never a pass', () => {
  it('reads a well-formed report', () => {
    const dir = dirWith({ 'audit.json': { vulnerabilities: { undici: { severity: 'high' } } } });
    expect(auditReport(dir).vulnerabilities.undici.severity).toBe('high');
  });

  it('accepts a genuinely clean report', () => {
    const dir = dirWith({ 'audit.json': { vulnerabilities: {} } });
    expect(auditReport(dir).vulnerabilities).toEqual({});
  });

  it('THROWS on an npm audit that failed to run (ENOLOCK shape)', () => {
    // The exact failure shape: an `error` key and no `vulnerabilities` at all.
    // Read as "clean" this is the qualifying pattern on the head directory —
    // base vulnerable, head clean — i.e. a network blip would autodeploy.
    const dir = dirWith({ 'audit.json': { error: { code: 'ENOLOCK', summary: 'no lockfile' } } });
    expect(() => auditReport(dir)).toThrow(/reports an error/);
  });

  it('THROWS on a report with no vulnerabilities field', () => {
    const dir = dirWith({ 'audit.json': { auditReportVersion: 2 } });
    expect(() => auditReport(dir)).toThrow(/well-formed/);
  });

  it('THROWS on an empty file', () => {
    const dir = dirWith({ 'audit.json': '' });
    expect(() => auditReport(dir)).toThrow(/did not produce a report/);
  });
});

describe('resolvedVersions — the lockfile lookup must see nested entries', () => {
  it('finds a top-level package', () => {
    expect(resolvedVersions(lock({ 'node_modules/nanoid': '3.3.7' }), 'nanoid')).toEqual(
      new Set(['3.3.7']),
    );
  });

  it('finds a package hoisted under a parent', () => {
    // The normal shape when a transitive advisory is fixed by bumping its
    // parent — which is the case this whole design exists for.
    expect(resolvedVersions(lock({ 'node_modules/vite/node_modules/nanoid': '3.3.7' }), 'nanoid'))
      .toEqual(new Set(['3.3.7']));
  });

  it('does not confuse a package whose name merely ends with the target', () => {
    expect(resolvedVersions(lock({ 'node_modules/not-nanoid': '1.0.0' }), 'nanoid')).toEqual(
      new Set(),
    );
  });

  it('returns an empty set when the package is absent', () => {
    expect(resolvedVersions(lock({ 'node_modules/hono': '4.0.0' }), 'nanoid')).toEqual(new Set());
  });
});

describe('selectPublishedAt — only the package this PR actually fixed sets the clock', () => {
  const RECENT = new Date('2026-08-16T00:00:00Z');
  const ANCIENT = new Date('2024-01-01T00:00:00Z');

  let asked: string[];
  beforeEach(() => {
    asked = [];
  });

  it('ignores an untouched, older base-vulnerable package', async () => {
    // THE C2 REGRESSION. base holds two advisories; the PR moves only nanoid.
    // postcss is untouched and two years old. The old implementation walked
    // every base vulnerability at every severity and took the max, so the
    // ancient postcss date won whenever nanoid dropped out — bypassing the
    // hold entirely, which is the one thing the hold exists to prevent.
    const when = await selectPublishedAt({
      base: report({ nanoid: 'high', postcss: 'high' }),
      basePackages: lock({ 'node_modules/nanoid': '3.3.7', 'node_modules/postcss': '8.4.0' }),
      headPackages: lock({ 'node_modules/nanoid': '3.3.18', 'node_modules/postcss': '8.4.0' }),
      lookup: async (name, version) => {
        asked.push(`${name}@${version}`);
        return name === 'nanoid' ? RECENT : ANCIENT;
      },
    });

    expect(asked).toEqual(['nanoid@3.3.18']);
    expect(when).toEqual(RECENT);
  });

  it('ignores a moderate-severity package even when this PR moved it', async () => {
    const when = await selectPublishedAt({
      base: report({ nanoid: 'high', postcss: 'moderate' }),
      basePackages: lock({ 'node_modules/nanoid': '3.3.7', 'node_modules/postcss': '8.4.0' }),
      headPackages: lock({ 'node_modules/nanoid': '3.3.18', 'node_modules/postcss': '8.5.26' }),
      lookup: async (name, version) => {
        asked.push(`${name}@${version}`);
        return name === 'nanoid' ? RECENT : ANCIENT;
      },
    });

    expect(asked).toEqual(['nanoid@3.3.18']);
    expect(when).toEqual(RECENT);
  });

  it('takes the YOUNGEST when several actionable packages moved', async () => {
    const when = await selectPublishedAt({
      base: report({ nanoid: 'high', undici: 'high' }),
      basePackages: lock({ 'node_modules/nanoid': '3.3.7', 'node_modules/undici': '7.28.0' }),
      headPackages: lock({ 'node_modules/nanoid': '3.3.18', 'node_modules/undici': '7.29.0' }),
      lookup: async (name) => (name === 'nanoid' ? ANCIENT : RECENT),
    });
    expect(when).toEqual(RECENT);
  });

  it('forces the hold when an actionable package resolves to no timestamp', async () => {
    const before = Date.now();
    const when = await selectPublishedAt({
      base: report({ nanoid: 'high' }),
      basePackages: lock({ 'node_modules/nanoid': '3.3.7' }),
      headPackages: lock({ 'node_modules/nanoid': '3.3.18' }),
      lookup: async () => null,
    });
    // "Unknown" must read as just-published, never as old enough to deploy.
    expect(when.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('forces the hold when a known-good timestamp coexists with an unresolvable one', async () => {
    const before = Date.now();
    const when = await selectPublishedAt({
      base: report({ nanoid: 'high', undici: 'high' }),
      basePackages: lock({ 'node_modules/nanoid': '3.3.7', 'node_modules/undici': '7.28.0' }),
      headPackages: lock({ 'node_modules/nanoid': '3.3.18', 'node_modules/undici': '7.29.0' }),
      lookup: async (name) => (name === 'nanoid' ? ANCIENT : null),
    });
    // One unresolved actionable package poisons the whole answer — it must not
    // fall back to the ancient date that did resolve.
    expect(when.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('forces the hold when an actionable package matches no lockfile entry at all', async () => {
    const before = Date.now();
    const when = await selectPublishedAt({
      base: report({ nanoid: 'high' }),
      basePackages: lock({ 'node_modules/hono': '4.0.0' }),
      headPackages: lock({ 'node_modules/hono': '4.0.1' }),
      lookup: async () => ANCIENT,
    });
    expect(when.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('forces the hold when nothing actionable moved', async () => {
    const before = Date.now();
    const when = await selectPublishedAt({
      base: report({ nanoid: 'high' }),
      basePackages: lock({ 'node_modules/nanoid': '3.3.7' }),
      headPackages: lock({ 'node_modules/nanoid': '3.3.7' }),
      lookup: async () => ANCIENT,
    });
    expect(when.getTime()).toBeGreaterThanOrEqual(before);
  });
});
