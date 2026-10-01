import { defineConfig } from 'vitest/config';
import { join } from 'node:path';

const testTmp = process.env.WBB_TEST_TMPDIR;
if (!testTmp) {
  throw new Error('Vitest requires the test supervisor to clean temporary caches. Run npm test -- <arguments> (from the package directory), or wbb-test <arguments> on the operator host.');
}

export default defineConfig({
  cacheDir: join(testTmp, 'vite-cache'),
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    pool: 'forks',
    runner: './scripts/test-temp-runner.ts',
    fsModuleCachePath: join(testTmp, 'vitest-module-cache'),
  },
});
