import { readFileSync } from 'node:fs'
import path from 'node:path'

import { type AuditOptions, renderAuditPack } from '../core/audit-pack.js'
import { isBinary, projectName } from '../workspace/git.js'
import { type Project, scanProject } from '../workspace/project.js'

import { type CommandResult, EXIT, requireProject, result } from './result.js'

/** `beacon audit --tag security`: one Markdown document with the code of the topic's zones. */
export function audit(root: string, options: AuditOptions): CommandResult {
  const loaded = requireProject(root)
  if ('failure' in loaded) return loaded.failure
  const markdown = auditMarkdown(loaded.project, options)
  return result(EXIT.ok, [markdown], { markdown })
}

/** Shared with `serve` and `mcp`. */
export function auditMarkdown(project: Project, options: AuditOptions): string {
  return renderAuditPack(
    {
      project: projectName(project.root),
      index: scanProject(project),
      read: (file) => readSource(project.root, file),
      // Local calendar date (sv-SE formats as YYYY-MM-DD), not UTC.
      date: new Date().toLocaleDateString('sv-SE'),
    },
    options
  )
}

function readSource(root: string, file: string): string | undefined {
  try {
    const content = readFileSync(path.join(root, file))
    return isBinary(content) ? undefined : content.toString('utf8')
  } catch {
    return undefined
  }
}
