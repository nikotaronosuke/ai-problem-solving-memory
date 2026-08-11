import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Load `.env` into the test process so integration tests can find a local
    // database. The empty prefix loads every variable, not just VITE_ ones.
    // Nothing here is committed: `.env` is git-ignored.
    env: loadEnv(mode, process.cwd(), ''),
  },
}));
