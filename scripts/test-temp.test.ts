import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const vitestPackage = dirname(require.resolve('vitest/package.json'));
const vitestImport = pathToFileURL(join(vitestPackage, 'dist/index.js')).href;
const helper = pathToFileURL(resolve(__dirname, 'test-temp.ts')).href;

describe('test temporary directories', () => {
  it.each([
    ['success', 0, '1 passed', `it('passes', () => { makeTempDirectory('owned-'); });`],
    ['assertion failure', 1, 'expected 1 to be 2', `it('fails', () => { makeTempDirectory('owned-'); expect(1).toBe(2); });`],
    ['beforeAll failure', 1, 'controlled setup failure', `beforeAll(() => { makeTempDirectory('owned-'); throw new Error('controlled setup failure'); }); it('never runs', () => {});`],
    ['beforeEach failure', 1, 'controlled setup failure', `beforeEach(() => { makeTempDirectory('owned-'); throw new Error('controlled setup failure'); }); it('never runs', () => {});`],
    ['invalid prefix', 0, '1 passed', `it('rejects path prefixes', () => { expect(() => makeTempDirectory('../unsafe-')).toThrow('Test temporary directory prefix must be a nonempty filename prefix'); expect(() => makeTempDirectory('')).toThrow('Test temporary directory prefix must be a nonempty filename prefix'); expect(() => makeTempDirectory('.')).toThrow('Test temporary directory prefix must be a nonempty filename prefix'); expect(() => makeTempDirectory('..')).toThrow('Test temporary directory prefix must be a nonempty filename prefix'); expect(() => makeTempDirectory('unsafe\\\\nested-')).toThrow('Test temporary directory prefix must be a nonempty filename prefix'); });`],
    ['shared lifetime', 0, '2 passed', `const shared = makeTempDirectory('shared-'); it('first', () => { expect(existsSync(shared)).toBe(true); makeTempDirectory('owned-'); }); it('second', () => { expect(existsSync(shared)).toBe(true); });`],
  ])('cleans allocations after %s', (_label, status, marker, body) => {
    const scratch = mkdtempSync(join(tmpdir(), 'test-temp-probe-'));
    const resources = join(scratch, 'resources');
    const framework = join(scratch, 'framework');
    const sentinel = join(scratch, 'sentinel');
    try {
      mkdirSync(resources);
      mkdirSync(framework);
      writeFileSync(sentinel, 'preserve');
      writeFileSync(join(scratch, 'probe.test.ts'), `
        import { it, expect, beforeAll, beforeEach } from ${JSON.stringify(vitestImport)};
        import { existsSync } from 'node:fs';
        import { makeTempDirectory } from ${JSON.stringify(helper)};
        process.env.TMPDIR = ${JSON.stringify(resources)};
        process.env.TMP = ${JSON.stringify(resources)};
        process.env.TEMP = ${JSON.stringify(resources)};
        ${body}
      `);
      writeFileSync(join(scratch, 'vitest.config.mjs'), `export default { test: { include: ['probe.test.ts'], pool: 'forks', maxWorkers: 1 } };`);
      const result = spawnSync(process.execPath, [join(vitestPackage, 'vitest.mjs'), 'run', '--root', scratch, '--config', join(scratch, 'vitest.config.mjs')], {
        env: { ...process.env, TMPDIR: framework, TMP: framework, TEMP: framework },
        encoding: 'utf8', timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(status);
      expect(result.stdout + result.stderr).toContain(marker);
      expect(readdirSync(resources)).toEqual([]);
      expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 25_000);
});
