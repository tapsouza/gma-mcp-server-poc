import { defineConfig } from 'vitest/config';

/**
 * Coverage thresholds are CONSTITUTIONAL (v1.0.2, Development Workflow & Quality Gates):
 * ≥90% line / ≥85% branch across src/, with src/core/** held to ≥95% line.
 * A shortfall must FAIL the run. Lowering a threshold requires a constitutional
 * amendment — it is never a fix for a failing build.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // Transport wiring and the process entrypoint are exercised by the manual
      // quickstart validations (stdio launch, fail-fast startup), not by the
      // offline suite; they contain no completeness, identity, or mapping logic.
      exclude: ['src/index.ts', 'src/server/stdio.ts'],
      all: true,
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
        'src/core/**': {
          lines: 95
        }
      }
    }
  }
});
