import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import moduleBoundaries from './eslint-rules/module-boundaries.js';

export default tseslint.config(
  {
    // Build artefacts, coverage, and dependencies are never linted.
    ignores: ['dist/**', 'dist-agent/**', 'coverage/**', 'node_modules/**', '.idea/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { boundaries: moduleBoundaries },
    rules: {
      // Constitution Principle III — a violation fails the build, it does not warn.
      'boundaries/no-cross-boundary-import': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always']
    }
  },
  {
    files: ['eslint-rules/**/*.js', '*.config.js', '*.config.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'off' }
  }
);
