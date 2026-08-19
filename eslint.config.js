import eslint from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output anywhere, including each workspace package's own, and the
    // one generated artifact that is deliberately committed: the plugin's
    // distribution bundle, which is verified by rebuilding it rather than by
    // being read as hand-authored source.
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'packages/claude-code-memory-plugin/bundle/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Config files and build scripts are plain JS and are not part of a
    // TypeScript program, so the type-aware rules have nothing to work from.
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
      // Node's own globals. Declared rather than pulled from a package: two
      // names are not worth a dependency.
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  // Keep formatting concerns in Prettier only.
  prettierConfig,
);
