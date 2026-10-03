import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { byText } from '../core/text.js'

/** Thin wrapper over the git CLI. Every function takes the repository root explicitly. */

const MAX_BUFFER = 256 * 1024 * 1024

/** `-c core.quotePath=false`: non-ASCII paths come back as UTF-8, not octal escapes. */
export function git(root: string, args: readonly string[], input?: string): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
  })
}

export function tryGit(root: string, args: readonly string[]): string | undefined {
  try {
    return git(root, args)
  } catch {
    return undefined
  }
}

export function findRepoRoot(cwd: string): string | undefined {
  const root = tryGit(cwd, ['rev-parse', '--show-toplevel'])?.trim()
  return root ? path.resolve(root) : undefined
}

/** Tracked files plus untracked ones that are not ignored. */
export function listFiles(root: string): string[] {
  const output = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return [...new Set(output.split('\0').filter(Boolean))].toSorted(byText)
}

/**
 * A file's content at a revision: `''` for the index (staged version), a commit SHA otherwise.
 * Undefined when the file does not exist there or is binary.
 */
export function readRevision(root: string, revision: string, file: string): string | undefined {
  try {
    const content = execFileSync('git', ['show', `${revision}:${file}`], {
      cwd: root,
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return isBinary(content) ? undefined : content.toString('utf8')
  } catch {
    return undefined
  }
}

export function isBinary(content: Uint8Array): boolean {
  return content.subarray(0, 8000).includes(0)
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '-M']
const PATCH_FLAGS = ['-U0', '--src-prefix=a/', '--dst-prefix=b/']

/** Name-status and patch of the staged changes. */
export function stagedDiff(root: string): { nameStatus: string; patch: string } {
  return {
    nameStatus: git(root, ['diff', '--cached', '--name-status', '-z', ...DIFF_FLAGS]),
    patch: git(root, ['diff', '--cached', ...DIFF_FLAGS, ...PATCH_FLAGS]),
  }
}

/** Name-status and patch of a commit against its first parent (or the empty tree). */
export function commitDiff(root: string, sha: string): { nameStatus: string; patch: string } {
  const base = ['show', '--format=', '--first-parent', ...DIFF_FLAGS]
  return {
    nameStatus: git(root, [...base, '--name-status', '-z', sha]),
    patch: git(root, [...base, ...PATCH_FLAGS, sha]),
  }
}

export function commitMessage(root: string, sha: string): string {
  return git(root, ['log', '-1', '--format=%B', sha])
}

export function commitSubject(root: string, sha: string): string {
  return git(root, ['log', '-1', '--format=%s', sha]).trim()
}

/** Non-merge commits in `revisions` (`git rev-list` syntax), oldest first. */
export function listCommits(root: string, revisions: readonly string[]): string[] {
  return git(root, ['rev-list', '--reverse', '--no-merges', ...revisions])
    .split('\n')
    .filter(Boolean)
}

export function gitPath(root: string, name: string): string {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', name]).trim())
}

/** Bodies of commits on the current branch that contain a `completed` beacon. */
export function completionMessages(root: string): string[] {
  const output = tryGit(root, [
    'log',
    '-E',
    String.raw`--grep=\[BEACON:[^]]*completed`,
    '--format=%B%x00',
  ])
  return (output ?? '').split('\0').filter((message) => message.trim() !== '')
}

export function configValue(root: string, key: string): string | undefined {
  const value = tryGit(root, ['config', '--get', key])?.trim()
  return value === '' ? undefined : value
}
