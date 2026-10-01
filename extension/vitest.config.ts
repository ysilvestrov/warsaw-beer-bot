import { defineConfig } from 'vitest/config';
import { join } from 'node:path';

const testTmp = process.env.WBB_TEST_TMPDIR;
if (!testTmp) {
  throw new Error('Vitest requires the test supervisor to clean temporary caches. Run npm test -- <arguments> (from the package directory), or wbb-test <arguments> on the operator host.');
}

export default defineConfig({
  cacheDir: join(testTmp, 'vite-cache'),
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    fsModuleCachePath: join(testTmp, 'vitest-module-cache'),
    // Heavy jsdom conformance re-render tests legitimately run ~5-6s each and,
    // under concurrent load, bump the 5s default. vitest 4 enforces the default
    // more strictly than vitest 2, so raise it to accommodate the slow tests.
    testTimeout: 20000,
  },
});
