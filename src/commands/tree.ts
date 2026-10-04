import { renderArchitectureTree } from '../core/architecture-tree.js'
import { projectName } from '../workspace/git.js'
import { scanProject } from '../workspace/project.js'

import { type CommandResult, EXIT, requireProject, result } from './result.js'

/** `beacon tree`: the architecture tree — folders, file counts and their zones. */
export function tree(root: string, options: { depth?: number | undefined }): CommandResult {
  const loaded = requireProject(root)
  if ('failure' in loaded) return loaded.failure
  const { tree: dirs } = scanProject(loaded.project)
  return result(EXIT.ok, renderArchitectureTree(dirs, projectName(root), options.depth), {
    tree: dirs,
  })
}
