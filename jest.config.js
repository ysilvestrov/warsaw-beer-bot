module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests', '<rootDir>/scripts'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
};
