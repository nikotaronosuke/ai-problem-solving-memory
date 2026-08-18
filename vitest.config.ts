import { fileURLToPath } from 'node:url';

import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/** Resolves a path in this repository, whatever the working directory is. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(({ mode }) => ({
  // Workspace packages resolve to their sources, matching the `paths` in
  // `tsconfig.json`. One `npm test` therefore runs the server's tests and the
  // packages' tests together, against source, with nothing built first —
  // rather than leaving a second command for somebody to remember.
  resolve: {
    alias: {
      '@ai-problem-solving-memory/api-client': here('./packages/memory-api-client/src/index.ts'),
      '@ai-problem-solving-memory/claude-code-adapter': here(
        './packages/claude-code-adapter/src/index.ts',
      ),
      '@ai-problem-solving-memory/claude-code-memory-plugin': here(
        './packages/claude-code-memory-plugin/src/server.ts',
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    // Load `.env` into the test process so integration tests can find a local
    // database. The empty prefix loads every variable, not just VITE_ ones.
    // Nothing here is committed: `.env` is git-ignored.
    env: loadEnv(mode, process.cwd(), ''),
  },
}));
