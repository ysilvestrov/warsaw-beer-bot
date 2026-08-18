import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditReport,
  publishedAt,
  resolvedVersions,
  selectPublishedAt,
  type LockPackages,
} from './qualify-cli';
import { qualify, type AuditReport, type Severity } from './qualify';

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

describe('publishedAt — the registry lookup behind selectPublishedAt', () => {
  // Stub fetchImpl only — never the real network.
  const stubFetch = (impl: (url: string) => { ok: boolean; json: () => Promise<unknown> }): typeof fetch =>
    ((url: string) => Promise.resolve(impl(url))) as unknown as typeof fetch;

  it('returns null on a non-ok response', async () => {
    const fetchImpl = stubFetch(() => ({ ok: false, json: async () => ({}) }));
    expect(await publishedAt('nanoid', '3.3.18', fetchImpl)).toBeNull();
  });

  it('returns null when the time map lacks the version', async () => {
    const fetchImpl = stubFetch(() => ({
      ok: true,
      json: async () => ({ time: { '3.3.7': '2024-01-01T00:00:00.000Z' } }),
    }));
    expect(await publishedAt('nanoid', '3.3.18', fetchImpl)).toBeNull();
  });

  it('returns null when the timestamp is unparseable', async () => {
    const fetchImpl = stubFetch(() => ({
      ok: true,
      json: async () => ({ time: { '3.3.18': 'not-a-date' } }),
    }));
    expect(await publishedAt('nanoid', '3.3.18', fetchImpl)).toBeNull();
  });

  it('returns the right Date on a good response', async () => {
    const fetchImpl = stubFetch(() => ({
      ok: true,
      json: async () => ({ time: { '3.3.18': '2026-08-01T12:00:00.000Z' } }),
    }));
    const when = await publishedAt('nanoid', '3.3.18', fetchImpl);
    expect(when).toEqual(new Date('2026-08-01T12:00:00.000Z'));
  });
});

describe('selectPublishedAt — the hold rests on what this PR INTRODUCES, not on the package that was vulnerable', () => {
  // #435 §4 amendment, measured 2026-08-18: the old scoping dated the
  // VULNERABLE package's new version, restricted to names the base audit
  // flagged as high/critical. That is wrong for the shape transitive fixes
  // normally take — bumping the PARENT makes the vulnerable CHILD vanish
  // from the head lockfile, there is no version of it to date, "unknown"
  // forced the hold, and the hourly re-evaluation recomputed "now" every
  // run: the pull request parked in `autodeploy-pending` permanently. The
  // function no longer takes an audit report at all — it scans every
  // package name in either lockfile and dates whatever version(s) this PR
  // actually introduces (head \ base).
  const RECENT = new Date('2026-08-16T00:00:00Z');
  const ANCIENT = new Date('2024-01-01T00:00:00Z');

  let asked: string[];
  beforeEach(() => {
    asked = [];
  });

  it('an untouched package is never asked about and cannot set the clock', async () => {
    // THE C2 REGRESSION, restated for the new scope: an untouched-but-old
    // package sitting next to the one this PR actually moved must not leak
    // its date in, whether or not it happens to be in an audit report.
    const when = await selectPublishedAt({
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

  it('takes the YOUNGEST across every package this PR moves — severity no longer scopes this function', async () => {
    // Both packages move; the old code would have IGNORED postcss here if it
    // were moderate severity or absent from the audit. This function reads
    // no audit at all now, so both count.
    const when = await selectPublishedAt({
      basePackages: lock({ 'node_modules/nanoid': '3.3.7', 'node_modules/postcss': '8.4.0' }),
      headPackages: lock({ 'node_modules/nanoid': '3.3.18', 'node_modules/postcss': '8.5.26' }),
      lookup: async (name, version) => {
        asked.push(`${name}@${version}`);
        return name === 'nanoid' ? ANCIENT : RECENT;
      },
    });

    expect(asked.sort()).toEqual(['nanoid@3.3.18', 'postcss@8.5.26']);
    expect(when).toEqual(RECENT);
  });

  it('forces the hold when an introduced version resolves to no timestamp', async () => {
    const before = Date.now();
    const when = await selectPublishedAt({
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
      basePackages: lock({ 'node_modules/nanoid': '3.3.7', 'node_modules/undici': '7.28.0' }),
      headPackages: lock({ 'node_modules/nanoid': '3.3.18', 'node_modules/undici': '7.29.0' }),
      lookup: async (name) => (name === 'nanoid' ? ANCIENT : null),
    });
    // One unresolved introduced version poisons the whole answer — it must
    // not fall back to the ancient date that did resolve.
    expect(when.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('the hold stands when nothing was introduced anywhere', async () => {
    const before = Date.now();
    const when = await selectPublishedAt({
      basePackages: lock({ 'node_modules/nanoid': '3.3.7' }),
      headPackages: lock({ 'node_modules/nanoid': '3.3.7' }),
      lookup: async () => ANCIENT,
    });
    expect(asked).toEqual([]);
    expect(when.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('a package that only DISAPPEARS contributes nothing — it must not force the hold', async () => {
    // THE CASE THIS RESCOPING EXISTS FOR. base audit reports undici high;
    // the fix bumps a PARENT package instead, so undici vanishes from the
    // head lockfile entirely. Under the OLD scoping this was "unknown" and
    // forced a hold that could never expire — the pull request parked in
    // autodeploy-pending permanently, since the hourly re-run always saw
    // "now". The parent's introduced version was published long ago, so the
    // correct outcome is autodeploy, not a permanent hold.
    const base = report({ undici: 'high' });
    const head = report({}); // clean after the parent bump

    const basePackages = lock({
      'node_modules/undici': '7.28.0',
      'node_modules/some-parent': '1.0.0',
    });
    const headPackages = lock({
      // undici is GONE — no entry anywhere in the head lockfile.
      'node_modules/some-parent': '2.0.0',
    });

    const publishedAtResult = await selectPublishedAt({
      basePackages,
      headPackages,
      lookup: async (name, version) => {
        asked.push(`${name}@${version}`);
        return name === 'some-parent' ? ANCIENT : null;
      },
    });

    // undici's disappearance must never even be asked about.
    expect(asked).toEqual(['some-parent@2.0.0']);
    expect(publishedAtResult).toEqual(ANCIENT);

    const verdict = qualify({ base, head, publishedAt: publishedAtResult, now: new Date() });
    expect(verdict.verdict).toBe('autodeploy');
  });
});
