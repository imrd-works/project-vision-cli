import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { configValue, gitPath } from './git.js'

export const HOOK_NAMES = ['prepare-commit-msg', 'commit-msg', 'pre-push'] as const
export type HookName = (typeof HOOK_NAMES)[number]

export interface HookInstall {
  mode: 'husky' | 'git'
  installed: HookName[]
  alreadyInstalled: HookName[]
  /** Existing foreign hooks we did not touch, with the line to add by hand. */
  manual: { hook: HookName; file: string; line: string }[]
}

/** The project's own `beacon` wins over a global one. Git runs hooks from the repository root. */
export function hookLine(hook: HookName): string {
  return `beacon_bin=node_modules/.bin/beacon; [ -x "$beacon_bin" ] || beacon_bin=beacon; "$beacon_bin" hook ${hook} "$@"`
}

export function installHooks(root: string): HookInstall {
  const huskyDir = path.join(root, '.husky')
  const hooksPath = configValue(root, 'core.hooksPath')
  const husky = existsSync(huskyDir) || /(?:^|\/)\.husky(?:\/_)?\/?$/.test(hooksPath ?? '')
  const result: HookInstall = {
    mode: husky ? 'husky' : 'git',
    installed: [],
    alreadyInstalled: [],
    manual: [],
  }
  const dir = husky ? huskyDir : hooksDirectory(root, hooksPath)
  mkdirSync(dir, { recursive: true })

  for (const hook of HOOK_NAMES) installHook(path.join(dir, hook), hook, husky, result)
  return result
}

function installHook(file: string, hook: HookName, husky: boolean, result: HookInstall): void {
  const line = hookLine(hook)
  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  if (current === undefined) {
    writeFileSync(file, husky ? `${line}\n` : `#!/bin/sh\n${line}\n`)
    chmodSync(file, 0o755)
    result.installed.push(hook)
  } else if (current.includes(`hook ${hook}`) && current.includes('beacon')) {
    result.alreadyInstalled.push(hook)
  } else if (husky) {
    // Husky hook files are plain command lists: appending is safe.
    writeFileSync(file, `${current.replace(/\n*$/, '\n')}${line}\n`)
    result.installed.push(hook)
  } else {
    result.manual.push({ hook, file, line })
  }
}

function hooksDirectory(root: string, hooksPath: string | undefined): string {
  return hooksPath ? path.resolve(root, hooksPath) : gitPath(root, 'hooks')
}
