// @ts-check
/**
 * Enforces branch naming and blocks commits/pushes straight to protected branches.
 * Format: <type>/<kebab-case-description>, e.g. feat/user-profile, fix/login-redirect.
 */
import { execFileSync } from 'node:child_process'

const PROTECTED = new Set(['main', 'master', 'develop'])
const TYPES = [
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
  'release',
  'hotfix',
]
const PATTERN = new RegExp(`^(${TYPES.join('|')})/[a-z0-9]+(?:[-.][a-z0-9]+)*$`)

/** @param {string[]} args */
const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

let branch
try {
  branch = git(['symbolic-ref', '--short', 'HEAD'])
} catch {
  process.exit(0) // detached HEAD (rebase, CI checkout) — nothing to check
}

let hasCommits = true
try {
  git(['rev-parse', '--verify', 'HEAD'])
} catch {
  hasCommits = false
}

if (PROTECTED.has(branch)) {
  // The very first commit of a new repository is the only allowed direct commit.
  if (!hasCommits) process.exit(0)
  console.error(
    `✖ Direct commits to "${branch}" are not allowed.\n` +
      `  Create a branch: git switch -c feat/my-change\n` +
      `  Emergency bypass (needs a reason in the PR): HUSKY=0 git commit …`
  )
  process.exit(1)
}

if (!PATTERN.test(branch)) {
  console.error(
    `✖ Branch "${branch}" does not follow <type>/<kebab-case-name>.\n` +
      `  Allowed types: ${TYPES.join(', ')}\n` +
      `  Rename: git branch -m ${TYPES[0]}/short-description`
  )
  process.exit(1)
}
