import { defineConfig } from 'vitest/config';
import { join } from 'node:path';

const testTmp = process.env.WBB_TEST_TMPDIR;

export default defineConfig({
  cacheDir: testTmp ? join(testTmp, 'vite-cache') : undefined,
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    pool: 'forks',
    runner: './scripts/test-temp-runner.ts',
    fsModuleCachePath: testTmp ? join(testTmp, 'vitest-module-cache') : undefined,
  },
});
