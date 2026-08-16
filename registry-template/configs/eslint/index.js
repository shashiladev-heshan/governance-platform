import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

/**
 * Distributed as a versioned npm package rather than through .governance/, because
 * ESLint must be able to resolve it without knowing anything about govctl. CI runs
 * `npm ci` before linting, so a locally patched node_modules never affects the gate.
 *
 * Rules here are the mechanical half of the policy. The semantic half lives in the
 * governed skills and is judged by the validator agent.
 */
export default [
  {
    // Governed content is linted and formatted by the registry. A project's own
    // tooling rewriting it would break the content hashes, so it is ignored here
    // rather than left to each project to remember.
    ignores: ['.governance/**', 'dist/**', 'build/**', 'coverage/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,

      // policy: no-swallowed-errors — the mechanical part linters can see
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-floating-promises': 'off', // needs type info; enabled in projects with a tsconfig service
      'no-throw-literal': 'error',

      // policy: dto-validation — `any` on a boundary is how validation gets skipped
      '@typescript-eslint/no-explicit-any': 'error',

      // general hygiene
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  prettier,
];
