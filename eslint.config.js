// @ts-check
import js from '@eslint/js'
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs'
import vitest from '@vitest/eslint-plugin'
import { defineConfig, globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import boundariesModule from 'eslint-plugin-boundaries'
import checkFile from 'eslint-plugin-check-file'
import importX from 'eslint-plugin-import-x'
import unicorn from 'eslint-plugin-unicorn'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Layers, top → bottom. A layer may import only layers below it.
 *   cli        argument parsing, output, exit codes
 *   commands   one use case per command (init, check, list, hook…)
 *   workspace  side effects: git, file system
 *   core       pure logic: zones, beacons, regions, commit rules
 */
const LAYERS = ['cli', 'commands', 'workspace', 'core']

// The package's .d.ts says `export default`, but the CommonJS module exports the plugin itself.
const boundaries = /** @type {import('eslint').ESLint.Plugin} */ (
  /** @type {unknown} */ (boundariesModule)
)

export default defineConfig([
  globalIgnores(['dist', 'coverage', '**/*.d.ts', 'test/fixtures']),

  // ─── Base: every JS/TS file ──────────────────────────────────────────────
  {
    name: 'base',
    files: ['**/*.{js,mjs,ts}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      unicorn.configs.unopinionated,
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
      comments.recommended,
    ],
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
    },
    rules: {
      // Code quality budgets
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-nested-callbacks': ['error', 4],
      'no-console': 'error',
      'no-param-reassign': ['error', { props: true }],
      'no-implicit-coercion': 'error',
      'prefer-template': 'error',
      'object-shorthand': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],

      // TypeScript
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // Imports
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
      'import-x/no-default-export': 'error',
      'import-x/no-named-as-default-member': 'off',
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', ['sibling', 'index']],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      // Unicorn: opinionated rules that do not fit this codebase
      'unicorn/no-null': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/filename-case': 'off', // handled by check-file
      'unicorn/no-array-reduce': 'off',
      'unicorn/prefer-ternary': 'off',
      'unicorn/no-useless-undefined': 'off',
      'unicorn/no-top-level-side-effects': 'off',
      'unicorn/no-process-exit': 'off', // the CLI exits with a status code

      // Every eslint-disable must explain why
      '@eslint-community/eslint-comments/require-description': 'error',
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      '@eslint-community/eslint-comments/disable-enable-pair': ['error', { allowWholeFile: true }],
    },
  },

  // ─── Pure core: no I/O ───────────────────────────────────────────────────
  {
    name: 'core-is-pure',
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:fs', 'node:fs/*', 'node:child_process', 'node:process'],
              message: 'core is pure: do I/O in src/workspace and pass data in.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', { name: 'process', message: 'core is pure: no process.' }],
    },
  },
  {
    name: 'output-only-in-cli',
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // ─── Naming ──────────────────────────────────────────────────────────────
  {
    name: 'naming',
    files: ['src/**/*.ts', 'test/**/*.ts'],
    plugins: { 'check-file': checkFile },
    rules: {
      'check-file/folder-naming-convention': ['error', { '{src,test}/**/': 'KEBAB_CASE' }],
      'check-file/filename-naming-convention': [
        'error',
        { '{src,test}/**/*.ts': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
    },
  },

  // ─── Architecture: layers ────────────────────────────────────────────────
  {
    name: 'architecture',
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': LAYERS.map((layer) => ({
        type: layer,
        pattern: `src/${layer}`,
        partialMatch: false,
      })),
      'boundaries/files': [{ category: 'test', pattern: '**/*.test.ts' }],
      // boundaries reads the legacy resolver setting.
      'import/resolver': { typescript: { alwaysTryTypes: true } },
    },
    rules: {
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message:
            '{{from.element.type}} must not import {{to.element.type}} ({{to.fileInternalPath}}): layers are cli → commands → workspace → core',
          policies: [
            { allow: { to: { module: { origin: 'external' } } } },
            { allow: { to: { module: { origin: 'core' } } } },
            ...LAYERS.map((layer, index) => ({
              from: { element: { type: layer } },
              allow: { to: { element: { types: { anyOf: LAYERS.slice(index) } } } },
            })),
          ],
        },
      ],
    },
  },

  // ─── Tests ───────────────────────────────────────────────────────────────
  {
    name: 'tests',
    files: ['src/**/*.test.ts', 'test/**/*.ts'],
    extends: [vitest.configs.recommended],
    rules: {
      'vitest/consistent-test-it': ['error', { fn: 'it' }],
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/prefer-hooks-on-top': 'error',
      'vitest/require-top-level-describe': 'error',
      'max-lines': 'off',
      'max-nested-callbacks': 'off',
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // ─── Config files and scripts ────────────────────────────────────────────
  {
    name: 'tooling',
    files: ['*.config.{js,ts}', 'scripts/**'],
    rules: {
      'import-x/no-default-export': 'off',
      'import-x/default': 'off',
      'import-x/no-named-as-default': 'off',
      'max-lines': 'off',
      'no-console': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  // Must stay last: disables stylistic rules that conflict with Prettier.
  prettier,
])
