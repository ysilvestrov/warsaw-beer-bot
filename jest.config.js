module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests', '<rootDir>/scripts'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  // Transpile-only: skip ts-jest's per-file type-checking (the slow part). Type
  // safety is still enforced by `npm run build` (tsc --noEmit equivalent), so the
  // check isn't lost — just not duplicated on every test run.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }],
  },
};
