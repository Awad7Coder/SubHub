/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '\\.integration\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',
  maxWorkers: 1,
  testTimeout: 30000,

  /**
   * WHY transformIgnorePatterns?
   *
   * uuid v9+ ships as ESM (export/import syntax).
   * Jest runs in CommonJS mode by default — it can't parse 'export'.
   * This tells Jest: DO transform uuid (and other ESM packages) through
   * ts-jest instead of skipping them like normal node_modules.
   *
   * The pattern says: transform everything EXCEPT node_modules,
   * but make exceptions for uuid and any other ESM-only packages.
   */
  transformIgnorePatterns: [
    'node_modules/(?!(uuid)/)',
  ],

  /**
   * WHY moduleNameMapper?
   * Your spec file imports from 'src/...' (absolute path):
   *   import { Subscription } from 'src/modules/subscriptions/...'
   * Jest doesn't know what 'src' means without this mapping.
   * This tells Jest: resolve 'src/X' as '<rootDir>/src/X'
   */
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
};