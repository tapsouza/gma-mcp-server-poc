import { defineConfig } from 'vitest/config';

/**
 * The harness's own test config, separate from the root `vitest.config.ts` by
 * design (research.md R10).
 *
 * There is deliberately NO `coverage.thresholds` block here. The root config's
 * thresholds are CONSTITUTIONAL (v1.0.2, Development Workflow & Quality Gates) and
 * govern `src/`; adding a second, laxer set of thresholds for a development tool
 * would dilute the meaning of "the coverage gate passed". Two configs is the
 * mechanism that keeps `npm test` byte-for-byte what the constitution describes
 * (FR-026, SC-011).
 *
 * `include` is rooted at the repository, not at this directory, because
 * `npm run test:agent` runs from the repo root.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['agent/test/**/*.test.ts'],
    // Suite C spawns a real child process and completes an MCP handshake over real
    // pipes, which is slower than an in-memory transport.
    testTimeout: 30_000
  }
});
