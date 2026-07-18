import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Heavy jsdom conformance re-render tests legitimately run ~5-6s each and,
    // under concurrent load, bump the 5s default. vitest 4 enforces the default
    // more strictly than vitest 2, so raise it to accommodate the slow tests.
    testTimeout: 20000,
  },
});
