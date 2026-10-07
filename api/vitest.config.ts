import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // The integration suite talks to a real Postgres and takes far longer than the
    // pure unit tests, so it gets its own generous timeout rather than slowing
    // everything down to suit the slowest case.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ['tests/setup.ts'],
    // File-level parallelism is deliberately off: the integration suite truncates
    // tables between tests, and two files doing that at once would corrupt each
    // other's fixtures.
    fileParallelism: false,
  },
});