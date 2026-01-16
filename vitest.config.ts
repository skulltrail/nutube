import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // NOTE: Source files have Chrome API dependencies that don't exist in Node.js
      // Tests re-implement the parsing logic for testability rather than importing directly.
      // Coverage tracks the test helper implementations, not the actual src files.
      include: ['tests/**/*.ts'],
      exclude: ['tests/setup.ts', 'tests/fixtures/**'],
    },
    setupFiles: ['./tests/setup.ts'],
  },
});
