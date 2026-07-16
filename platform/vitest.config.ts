import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/**/src/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
    // Why: integration tests start a real PostgreSQL 16 container (testcontainers),
    // whose first cold pull/boot far exceeds Vitest's default 5s timeouts.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // Why: a single shared Docker daemon serializes container startup cleanly and
    // avoids port/resource thrash when several suites each need their own database.
    fileParallelism: false
  }
})
