/**
 * Jest runs the `*.spec.ts` security suites; Vitest runs `*.test.ts`.
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
};
