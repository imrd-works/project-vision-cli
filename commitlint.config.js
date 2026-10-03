// @ts-check
import { RuleConfigSeverity } from '@commitlint/types'

const { Error } = RuleConfigSeverity

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      Error,
      'always',
      [
        'feat',
        'fix',
        'refactor',
        'perf',
        'style',
        'docs',
        'test',
        'chore',
        'build',
        'ci',
        'revert',
      ],
    ],
    'scope-empty': [Error, 'never'],
    'scope-case': [Error, 'always', 'kebab-case'],
    'subject-empty': [Error, 'never'],
    'subject-case': [Error, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'subject-full-stop': [Error, 'never', '.'],
    'header-max-length': [Error, 'always', 100],
    'body-max-line-length': [Error, 'always', 100],
  },
}
