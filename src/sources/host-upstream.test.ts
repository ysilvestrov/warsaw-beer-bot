import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLitestreamLatest, parseNodeEnd, parseNodeSecurity } from './host-upstream';

/** #469 stage 2 — fixtures captured 2026-10-08 (tests/fixtures/host-upstream/README.md). */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures/host-upstream', name), 'utf8'));

describe('parseNodeSecurity', () => {
  it('picks the newest v24 security release, not v26 or v22', () => {
    expect(parseNodeSecurity(fixture('node-index.json'))).toEqual({ version: '24.18.1', date: '2026-07-28' });
  });
  it('orders by version, not by array position', () => {
    expect(parseNodeSecurity([
      { version: 'v24.17.0', date: '2026-06-17', security: true },
      { version: 'v24.18.1', date: '2026-07-28', security: true },
    ])).toEqual({ version: '24.18.1', date: '2026-07-28' });
  });
  it('is null when the 24.x line has no security release', () => {
    expect(parseNodeSecurity([{ version: 'v24.21.0', date: '2026-09-07', security: false }])).toBe(null);
  });
  it.each([
    ['not an array', {}],
    ['no 24.x release at all', [{ version: 'v26.11.1', date: '2026-10-01', security: true }]],
    ['a malformed security version', [{ version: 'v24.18', date: '2026-07-28', security: true }]],
    ['a malformed date', [{ version: 'v24.18.1', date: '28.07.2026', security: true }]],
    // A missing or non-boolean flag is "unknown", never "no security release" (cross-review).
    ['a missing security flag', [{ version: 'v24.22.0', date: '2026-10-01' }]],
    ['a non-boolean security flag', [{ version: 'v24.22.0', date: '2026-10-01', security: 'true' }]],
    // AI review on #805: regex-valid but impossible dates, and a v24 record that is not a version.
    ['an impossible security date', [{ version: 'v24.22.0', date: '2026-02-30', security: true }]],
    ['a v24 record that is not a version', [{ version: 'v24.garbage', date: 'bad', security: false }]],
  ])('throws on %s', (_what, json) => {
    expect(() => parseNodeSecurity(json)).toThrow();
  });
});

describe('parseNodeEnd', () => {
  it('reads v24.end', () => {
    expect(parseNodeEnd(fixture('node-schedule.json'))).toBe('2028-04-30');
  });
  it.each([
    ['no v24 key', { v26: { end: '2029-04-30' } }],
    ['a malformed end', { v24: { end: 'April 2028' } }],
    ['an impossible end date', { v24: { end: '2028-02-30' } }],
    ['not an object', []],
  ])('throws on %s', (_what, json) => {
    expect(() => parseNodeEnd(json)).toThrow();
  });
});

describe('parseLitestreamLatest', () => {
  it('reads the tag without its v and the publish instant', () => {
    expect(parseLitestreamLatest(fixture('litestream-latest.json')))
      .toEqual({ version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' });
  });
  it.each([
    ['a prerelease', { tag_name: 'v0.6.0-rc1', published_at: '2026-09-01T00:00:00Z', prerelease: true, draft: false }],
    ['a draft', { tag_name: 'v0.6.0', published_at: '2026-09-01T00:00:00Z', prerelease: false, draft: true }],
    ['a non-semver tag', { tag_name: 'nightly', published_at: '2026-09-01T00:00:00Z', prerelease: false, draft: false }],
    ['a bad instant', { tag_name: 'v0.6.0', published_at: 'yesterday', prerelease: false, draft: false }],
  ])('throws on %s', (_what, json) => {
    expect(() => parseLitestreamLatest(json)).toThrow();
  });
});
