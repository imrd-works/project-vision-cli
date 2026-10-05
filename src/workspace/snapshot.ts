import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { AUDITS_DIR } from '../core/audit.js'
import { CHECKPOINTS_PATH } from '../core/checkpoints.js'
import { CONFIG_PATH } from '../core/config.js'
import { parseCommitLog } from '../core/history.js'
import { MANIFEST_PATH } from '../core/manifest.js'
import { EXCEPTIONS_PATH, RULES_PATH } from '../core/registry.js'
import type { RepositorySnapshot } from '../core/snapshot.js'

import { commitLog, listFiles, projectName } from './git.js'
import { loadProject, scanProject } from './project.js'

/**
 * The snapshot of a checked-out repository (its working tree and the history of HEAD): what a
 * server stores per branch to show the team's state without the repository at hand.
 */
export function collectSnapshot(root: string): RepositorySnapshot {
  const load = loadProject(root)
  const zones = readText(root, MANIFEST_PATH)
  const checkpoints = readText(root, CHECKPOINTS_PATH)
  const config = readText(root, CONFIG_PATH)
  const rules = readText(root, RULES_PATH)
  const exceptions = readText(root, EXCEPTIONS_PATH)
  return {
    format: 1,
    name: projectName(root),
    generatedAt: new Date().toISOString(),
    files: {
      ...(zones === undefined ? {} : { zones }),
      ...(checkpoints === undefined ? {} : { checkpoints }),
      ...(config === undefined ? {} : { config }),
      ...(rules === undefined ? {} : { rules }),
      ...(exceptions === undefined ? {} : { exceptions }),
    },
    ...(load.kind === 'ok' ? { index: scanProject(load.project) } : {}),
    commits: parseCommitLog(commitLog(root)),
    audits: auditFiles(root),
  }
}

/** The cross-audit files git sees, with their text. */
export function auditFiles(root: string): { path: string; text: string }[] {
  return listFiles(root)
    .filter((file) => file.startsWith(`${AUDITS_DIR}/`) && file.endsWith('.md'))
    .flatMap((file) => {
      const text = readText(root, file)
      return text === undefined ? [] : [{ path: file, text }]
    })
}

function readText(root: string, file: string): string | undefined {
  const absolute = path.join(root, file)
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined
}
