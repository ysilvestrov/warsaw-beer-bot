import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('checks monitor boundaries and real Linux test process lifetimes', () => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/ops', '-p', 'test_*.py', '-v'], {
    cwd: resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBe(undefined);
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 100_000);
