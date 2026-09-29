import { defineConfig } from 'vitest/config';
import { join } from 'node:path';

const testTmp = process.env.WBB_TEST_TMPDIR;

export default defineConfig({
  cacheDir: testTmp ? join(testTmp, 'vite-cache') : undefined,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    fsModuleCachePath: testTmp ? join(testTmp, 'vitest-module-cache') : undefined,
    // Heavy jsdom conformance re-render tests legitimately run ~5-6s each and,
    // under concurrent load, bump the 5s default. vitest 4 enforces the default
    // more strictly than vitest 2, so raise it to accommodate the slow tests.
    testTimeout: 20000,
  },
});
