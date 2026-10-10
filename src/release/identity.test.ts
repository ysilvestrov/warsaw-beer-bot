import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readReleaseIdentity, type ReleaseHost } from './identity';

const SHA = 'a'.repeat(40);
const HOST: ReleaseHost = { os: 'linux', arch: 'x64', libc: 'glibc', nodeVersion: '24.3.0' };
const ROOT = '/srv/wbb/releases/x';

// The shape deploy/release/package_runtime.py release_info writes.
function release(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    repo: 'ysilvestrov/warsaw-beer-bot',
    sourceSha: SHA,
    workflow: 'release',
    runId: 7,
    runAttempt: 1,
    node: { version: '24.3.0', major: 24, modules: '137' },
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', glibcVersion: '2.39' },
    packageLockSha256: 'b'.repeat(64),
    ...over,
  };
}

function reader(text: string) {
  const paths: string[] = [];
  return { paths, readFile: (p: string) => { paths.push(p); return text; } };
}

function missing(): (p: string) => string {
  return () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
}

const INVALID: Array<[string, string, string]> = [
  ['broken JSON', '{"formatVersion":', 'not valid JSON'],
  ['another formatVersion', JSON.stringify(release({ formatVersion: 2 })), 'formatVersion 2 is not 1'],
  ['a short sourceSha', JSON.stringify(release({ sourceSha: 'a'.repeat(39) })),
    `sourceSha ${JSON.stringify('a'.repeat(39))} is not 40 lowercase hex`],
  ['an uppercase sourceSha', JSON.stringify(release({ sourceSha: 'A'.repeat(40) })),
    `sourceSha ${JSON.stringify('A'.repeat(40))} is not 40 lowercase hex`],
  ['a foreign arch', JSON.stringify(release({ platform: { os: 'linux', arch: 'arm64', libc: 'glibc' } })), 'platform.arch "arm64" does not match this host (x64)'],
  ['a foreign os', JSON.stringify(release({ platform: { os: 'darwin', arch: 'x64', libc: 'glibc' } })), 'platform.os "darwin" does not match this host (linux)'],
  ['a foreign libc', JSON.stringify(release({ platform: { os: 'linux', arch: 'x64', libc: 'musl' } })), 'platform.libc "musl" does not match this host (glibc)'],
  ['another Node major', JSON.stringify(release({ node: { version: '22.1.0', major: 22, modules: '127' } })), 'node.major 22 does not match this Node (24.3.0)'],
  ['a JSON array', '[]', 'formatVersion undefined is not 1'],
  ['no platform', JSON.stringify(release({ platform: undefined })), 'platform.os undefined does not match this host (linux)'],
];

describe('readReleaseIdentity', () => {
  it('reads sourceSha from release.json at the given root', () => {
    const r = reader(JSON.stringify(release()));
    expect(readReleaseIdentity({ root: ROOT, required: true, readFile: r.readFile, host: HOST }))
      .toEqual({ releaseSha: SHA, problem: null });
    expect(r.paths).toEqual([`${ROOT}/release.json`]);
  });

  it('a missing file is null without a problem when not required', () => {
    expect(readReleaseIdentity({ root: ROOT, required: false, readFile: missing(), host: HOST }))
      .toEqual({ releaseSha: null, problem: null });
  });

  it('a missing file fails startup with the path when required', () => {
    expect(() => readReleaseIdentity({ root: ROOT, required: true, readFile: missing(), host: HOST }))
      .toThrow(`release identity required: ${ROOT}/release.json does not exist`);
  });

  it('an unreadable file is a problem, not absence', () => {
    const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    expect(readReleaseIdentity({ root: ROOT, required: false, readFile: denied, host: HOST }))
      .toEqual({ releaseSha: null, problem: `${ROOT}/release.json: unreadable (EACCES)` });
    expect(() => readReleaseIdentity({ root: ROOT, required: true, readFile: denied, host: HOST }))
      .toThrow(`release identity required: ${ROOT}/release.json: unreadable (EACCES)`);
  });

  it.each(INVALID)('%s: not required ⇒ null and the reason as a problem', (_name, text, reason) => {
    const got = readReleaseIdentity({ root: ROOT, required: false, readFile: reader(text).readFile, host: HOST });
    expect(got).toEqual({ releaseSha: null, problem: `${ROOT}/release.json: ${reason}` });
  });

  it.each(INVALID)('%s: required ⇒ startup fails with the reason', (_name, text, reason) => {
    expect(() => readReleaseIdentity({ root: ROOT, required: true, readFile: reader(text).readFile, host: HOST }))
      .toThrow(reason);
  });

  it('the default reader reads the real file and treats its absence as ENOENT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbb-release-identity-'));
    try {
      expect(readReleaseIdentity({ root: dir, required: false, host: HOST })).toEqual({ releaseSha: null, problem: null });
      writeFileSync(join(dir, 'release.json'), JSON.stringify(release()));
      expect(readReleaseIdentity({ root: dir, required: true, host: HOST })).toEqual({ releaseSha: SHA, problem: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
