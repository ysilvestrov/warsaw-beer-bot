import { describe, it, expect } from 'vitest';
import { manifestScope } from './manifest-scope';

const deps = (d: Record<string, string>) => d;

describe('manifestScope', () => {
  it('accepts a bump that moves only the numbers under a caret', () => {
    const r = manifestScope({
      changedPaths: ['package.json', 'package-lock.json'],
      base: deps({ undici: '^7.28.0' }),
      head: deps({ undici: '^7.29.0' }),
    });
    expect(r).toEqual({ ok: true, violations: [] });
  });

  it('rejects a changed range operator even when the version moved forward', () => {
    const r = manifestScope({
      changedPaths: ['package.json', 'package-lock.json'],
      base: deps({ undici: '^7.28.0' }),
      head: deps({ undici: '~7.29.0' }),
    });
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toMatch(/undici.*\^.*~/);
  });

  it('rejects a pin that drops the range operator entirely', () => {
    const r = manifestScope({
      changedPaths: ['package.json', 'package-lock.json'],
      base: deps({ undici: '^7.28.0' }),
      head: deps({ undici: '7.29.0' }),
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a path outside the two allowed files', () => {
    const r = manifestScope({
      changedPaths: ['package.json', 'package-lock.json', 'src/index.ts'],
      base: deps({ undici: '^7.28.0' }),
      head: deps({ undici: '^7.29.0' }),
    });
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toMatch(/src\/index\.ts/);
  });

  it('rejects an extension lockfile, which is not deployed to the server', () => {
    const r = manifestScope({
      changedPaths: ['extension/package-lock.json'],
      base: deps({}),
      head: deps({}),
    });
    expect(r.ok).toBe(false);
  });

  it('rejects an added or removed direct dependency', () => {
    const added = manifestScope({
      changedPaths: ['package.json'],
      base: deps({ undici: '^7.28.0' }),
      head: deps({ undici: '^7.29.0', 'left-pad': '^1.0.0' }),
    });
    expect(added.ok).toBe(false);
    expect(added.violations.join(' ')).toMatch(/left-pad/);

    const removed = manifestScope({
      changedPaths: ['package.json'],
      base: deps({ undici: '^7.28.0', hono: '^4.12.26' }),
      head: deps({ undici: '^7.29.0' }),
    });
    expect(removed.ok).toBe(false);
    expect(removed.violations.join(' ')).toMatch(/hono/);
  });
});
