// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'drizzle/**', 'coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      '@typescript-eslint/require-await': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.test.ts', 'scripts/**/*.ts', 'src/db/seed.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
  /**
   * `eslint .` — what `pnpm lint` and CI run — lints this file too, and it is
   * the only JS file in the package. The type-aware preset above asks the
   * TypeScript project service for a program containing it and there is none:
   * `tsconfig.json` does not set `allowJs`, so a `.js` path in `include` is
   * dropped from the program silently. The result was a hard
   * `Parsing error: ... was not found by the project service`.
   *
   * It hid because every local gate ran `npx eslint src` while CI ran
   * `eslint .`. `infra/scripts/verify-ci.sh` now runs the CI command, so
   * the two cannot diverge again.
   *
   * Type-aware rules on a flat config file buy nothing, so drop them for JS
   * rather than widen the tsconfig to pull a build tool's config into the
   * program. This block must stay AFTER the one that sets `projectService`:
   * flat config is last-match-wins, and an earlier reset would be overwritten.
   */
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
  prettier,
);
