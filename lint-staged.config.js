// @ts-check
/**
 * Runs on staged files only. The full check (`npm run verify`) runs on pre-push and in CI.
 * The hook uses `--concurrent false`: globs overlap, fixers must not run in parallel.
 * @type {import('lint-staged').Configuration}
 */
export default {
  '*': ['secretlint', 'prettier --write --ignore-unknown'],
  '*.{js,mjs,ts}': ['eslint --fix --max-warnings 0 --cache --no-warn-ignored'],
  // Type errors can appear in files that were not changed, so check the whole project.
  '*.ts': () => 'tsc --noEmit',
  'src/**/*.ts': ['vitest related --run --project unit --passWithNoTests'],
}
