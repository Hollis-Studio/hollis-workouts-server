import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// =============================================================================
// WORKOUTS SERVER ESLINT CONFIGURATION (flat config, ESM)
// =============================================================================
//
// CONSOLE BAN
// -----------
// console.* is banned in production code. All logging MUST go through the
// structured pino logger (src/utils/logger.ts) so log lines are machine-
// readable JSON in CloudWatch / structured sinks.
//
// TYPE SAFETY
// -----------
// - no-explicit-any: use `unknown` + narrowing, or define a real type
// - no-floating-promises / no-misused-promises: every Promise must be awaited
//   or returned; async callbacks in Express must be error-handled
// - explicit-module-boundary-types: all exported functions need return types
//
// TYPE-AWARE RULES (opt-in via SERVER_LINT_TYPECHECK=1)
// The unsafe-* rules require the full TS program and slow the lint pass.
// They are gated behind the env flag so regular `npm run lint` stays fast.
// CI should set SERVER_LINT_TYPECHECK=1 in the dedicated lint:types job.
//
// TEST-FILE RELAXATIONS
// Tests may use `any`, `console`, and non-null assertions freely.
// =============================================================================

const typeAwareLintEnabled =
  process.env.SERVER_LINT_TYPECHECK === '1' ||
  process.env.SERVER_LINT_TYPECHECK === 'true';

/** Files that participate in the type-aware (project-linked) pass. */
const typeAwareFiles = [
  'src/app.ts',
  'src/index.ts',
  'src/lib/**/*.ts',
  'src/middleware/**/*.ts',
  'src/routes/**/*.ts',
  'src/services/**/*.ts',
  'src/utils/**/*.ts',
  'src/validation/**/*.ts',
  'src/types/**/*.ts',
];

export default tseslint.config(
  // ── Base recommended sets ────────────────────────────────────────────────
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── Production source rules ──────────────────────────────────────────────
  {
    files: ['src/**/*.ts'],
    rules: {
      // ------------------------------------------------------------------
      // LOGGING: ban console.* — use pino logger (src/utils/logger.ts)
      // ------------------------------------------------------------------
      'no-console': 'error',

      // ------------------------------------------------------------------
      // TYPE SAFETY
      // ------------------------------------------------------------------
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // ------------------------------------------------------------------
      // SECURITY: ban dangerous eval-like constructs
      // ------------------------------------------------------------------
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // ------------------------------------------------------------------
      // CODE QUALITY
      // ------------------------------------------------------------------
      'complexity': ['warn', 25],
      'max-params': ['warn', 6],
    },
  },

  // ── Type-aware rules (opt-in via SERVER_LINT_TYPECHECK=1) ────────────────
  ...(typeAwareLintEnabled
    ? [
        {
          files: typeAwareFiles,
          languageOptions: {
            parserOptions: {
              project: './tsconfig.json',
              tsconfigRootDir: import.meta.dirname,
            },
          },
          rules: {
            '@typescript-eslint/no-unsafe-assignment': 'error',
            '@typescript-eslint/no-unsafe-member-access': 'error',
            '@typescript-eslint/no-unsafe-call': 'error',
            '@typescript-eslint/no-unsafe-argument': 'error',
            '@typescript-eslint/no-unsafe-return': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/require-await': 'warn',
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
            '@typescript-eslint/prefer-readonly': 'error',
          },
        },
      ]
    : []),

  // ── Test / spec files — relaxed rules ───────────────────────────────────
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'off',
      '@typescript-eslint/prefer-readonly': 'off',
    },
  },

  // ── Global ignores ───────────────────────────────────────────────────────
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
      'prisma/generated/**',
      'infrastructure/**',
    ],
  },
);
