import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const pythonOptions = {
  cwd: resolve(__dirname, '..'),
  encoding: 'utf8',
  timeout: 90_000,
  killSignal: 'SIGKILL',
  maxBuffer: 4 * 1024 * 1024,
} as const;

describe.skipIf(process.platform !== 'linux')('Linux operational commands', () => {
  it('checks monitor boundaries and real Linux test process lifetimes', () => {
    const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/ops', '-p', 'test_*.py', '-v'], pythonOptions);
    expect(result.error, result.stderr).toBe(undefined);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 100_000);

  it.each([
    ['SIGTERM ignored', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(10)'],
    ['slow initialization', 'import signal,time; time.sleep(2); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(10)'],
  ])('uses SIGKILL for a timed-out Python subprocess (%s)', (_scenario, code) => {
    const result = spawnSync('python3', ['-B', '-c', code], { ...pythonOptions, timeout: 1_000 });
    expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(result.signal).toBe('SIGKILL');
    expect(result.status).toBe(null);
  });
});
