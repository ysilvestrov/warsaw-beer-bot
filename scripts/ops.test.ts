import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const pythonOptions = {
  cwd: resolve(__dirname, '..'),
  encoding: 'utf8',
  timeout: 90_000,
  killSignal: 'SIGKILL',
  maxBuffer: 4 * 1024 * 1024,
} as const;

it('checks monitor boundaries and real Linux test process lifetimes', () => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/ops', '-p', 'test_*.py', '-v'], pythonOptions);
  expect(result.error, result.stderr).toBe(undefined);
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 100_000);

it('kills a timed-out Python process even when it ignores SIGTERM', () => {
  const result = spawnSync('python3', ['-B', '-c',
    "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(2)",
  ], { ...pythonOptions, timeout: 1_000 });
  expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
  expect(result.signal).toBe('SIGKILL');
  expect(result.status).toBe(null);
  expect(result.stdout).toBe('ready\n');
});
