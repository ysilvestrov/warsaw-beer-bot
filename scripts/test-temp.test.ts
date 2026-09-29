import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const vitestPackage = dirname(require.resolve('vitest/package.json'));
const vitestImport = pathToFileURL(join(vitestPackage, 'dist/index.js')).href;
const helper = pathToFileURL(resolve(__dirname, 'test-temp.ts')).href;
const runner = resolve(__dirname, 'test-temp-runner.ts');

describe('test temporary directories', () => {
  it.each([
    ['success', 0, '1 passed', [], [], 1, `it('passes', () => { makeTempDirectory('owned-'); });`],
    ['assertion failure', 1, 'expected 1 to be 2', [], [], 1, `it('fails', () => { makeTempDirectory('owned-'); expect(1).toBe(2); });`],
    ['beforeAll failure', 1, 'controlled setup failure', [], [], 1, `beforeAll(() => { makeTempDirectory('owned-'); throw new Error('controlled setup failure'); }); it('never runs', () => {});`],
    ['beforeEach failure', 1, 'controlled setup failure', [], [], 1, `beforeEach(() => { makeTempDirectory('owned-'); throw new Error('controlled setup failure'); }); it('never runs', () => {});`],
    ['collection failure', 1, 'controlled collection failure', [], [], 1, `makeTempDirectory('owned-'); throw new Error('controlled collection failure');`],
    ['invalid prefix', 0, '1 passed', [], [], 0, `it('rejects path prefixes', () => { expect(() => makeTempDirectory('../unsafe-')).toThrow('Test temporary directory prefix must be a nonempty filename prefix'); expect(() => makeTempDirectory('')).toThrow('Test temporary directory prefix must be a nonempty filename prefix'); expect(() => makeTempDirectory('.')).toThrow('Test temporary directory prefix must be a nonempty filename prefix'); expect(() => makeTempDirectory('..')).toThrow('Test temporary directory prefix must be a nonempty filename prefix'); expect(() => makeTempDirectory('unsafe\\\\nested-')).toThrow('Test temporary directory prefix must be a nonempty filename prefix'); });`],
    ['shared lifetime', 0, '2 passed', [], [], 2, `const shared = makeTempDirectory('shared-'); it('first', () => { expect(existsSync(shared)).toBe(true); makeTempDirectory('owned-'); }); it('second', () => { expect(existsSync(shared)).toBe(true); });`],
    ['cleanup failure', 1, 'Cannot remove test temporary directory:', [0], [0, 1, 0], 2, `
      vi.mock('node:fs', async (importOriginal) => {
        const fs = await importOriginal();
        return { ...fs, rmSync(directory, options) {
          fs.appendFileSync(process.env.PROBE_ATTEMPTS, JSON.stringify(directory) + '\\n');
          if (directory.includes('/blocked-')) throw new Error('controlled removal failure');
          return fs.rmSync(directory, options);
        } };
      });
      it('allocates', () => { makeTempDirectory('blocked-'); makeTempDirectory('owned-'); });
    `],
    ['transient cleanup failure', 1, 'Cannot remove test temporary directory:', [], [0, 1, 0], 2, `
      vi.mock('node:fs', async (importOriginal) => {
        const fs = await importOriginal();
        let blockedAttempts = 0;
        return { ...fs, rmSync(directory, options) {
          fs.appendFileSync(process.env.PROBE_ATTEMPTS, JSON.stringify(directory) + '\\n');
          if (directory.includes('/blocked-') && ++blockedAttempts === 1) throw new Error('controlled removal failure');
          return fs.rmSync(directory, options);
        } };
      });
      it('allocates', () => { makeTempDirectory('blocked-'); makeTempDirectory('owned-'); });
    `],
    ['reused worker collection failures', 1, 'controlled collection failure', [], [], 12, `makeTempDirectory('owned-'); throw new Error('controlled collection failure');`, 12, false],
  ])('cleans allocations after %s', (_label, status, marker, remaining, attempts, count, body, copies = 1, isolate = true) => {
    const scratch = mkdtempSync(join(tmpdir(), 'test-temp-probe-'));
    const resources = join(scratch, 'resources');
    const framework = join(scratch, 'framework');
    const sentinel = join(scratch, 'sentinel');
    try {
      mkdirSync(resources);
      mkdirSync(framework);
      writeFileSync(sentinel, 'preserve');
      writeFileSync(join(scratch, 'allocations'), '');
      writeFileSync(join(scratch, 'attempts'), '');
      const probe = `
        import { it, expect, beforeAll, beforeEach } from ${JSON.stringify(vitestImport)};
        import { appendFileSync, existsSync } from 'node:fs';
        import { dirname } from 'node:path';
        import { makeTempDirectory as allocate } from ${JSON.stringify(helper)};
        process.env.TMPDIR = ${JSON.stringify(resources)};
        process.env.TMP = ${JSON.stringify(resources)};
        process.env.TEMP = ${JSON.stringify(resources)};
        process.env.PROBE_ATTEMPTS = ${JSON.stringify(join(scratch, 'attempts'))};
        function makeTempDirectory(prefix) {
          const directory = allocate(prefix);
          expect(dirname(directory)).toBe(${JSON.stringify(resources)});
          expect(existsSync(directory)).toBe(true);
          appendFileSync(${JSON.stringify(join(scratch, 'allocations'))}, JSON.stringify(directory) + '\\n');
          return directory;
        }
        ${body}
      `;
      for (let index = 0; index < copies; index++) writeFileSync(join(scratch, `${index}.test.ts`), probe);
      writeFileSync(join(scratch, 'vitest.config.mjs'), `export default { test: { runner: ${JSON.stringify(runner)}, include: ['*.test.ts'], isolate: ${isolate}, globals: true, pool: 'forks', maxWorkers: 1 } };`);
      const result = spawnSync(process.execPath, [join(vitestPackage, 'vitest.mjs'), 'run', '--root', scratch, '--config', join(scratch, 'vitest.config.mjs')], {
        env: { ...process.env, TMPDIR: framework, TMP: framework, TEMP: framework },
        encoding: 'utf8', timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(status);
      expect(result.stdout + result.stderr).toContain(marker);
      const allocations: string[] = readFileSync(join(scratch, 'allocations'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      const removals: string[] = readFileSync(join(scratch, 'attempts'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(allocations.length).toBe(count);
      expect(result.stdout + result.stderr).not.toContain('MaxListenersExceededWarning');
      expect(readdirSync(resources)).toEqual(remaining.map(index => basename(allocations[index])));
      expect(removals).toEqual(attempts.map(index => allocations[index]));
      expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 25_000);
});
