import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { parseMarkup } from '../core/markup.js'
import { buildIndex } from '../core/project-index.js'

import { type CommandResult, EXIT, formatProblem, requireProject, result } from './result.js'

/** Zones of one file and of the regions inside it. `file` is relative to the repository root. */
export function which(root: string, file: string): CommandResult {
  const loaded = requireProject(root)
  if ('failure' in loaded) return loaded.failure
  const { project } = loaded

  const absolute = path.join(root, file)
  if (!existsSync(absolute))
    return result(EXIT.failed, [`✖ Файл не найден: ${file}`], { error: 'not-found' })

  const markup = parseMarkup(readFileSync(absolute, 'utf8'), file)
  const index = buildIndex(
    project.manifest,
    [{ path: file, pathZone: project.resolver(file), markup }],
    new Set()
  )
  const indexed = index.files[0] ?? { path: file, zones: [], regions: [] }
  const title = (id: string): string => project.manifest.zones.get(id)?.title ?? ''

  const lines = [
    ...indexed.zones.map((id) => `${id}  ${title(id)}`),
    ...indexed.regions.map(
      (region) => `${region.zones.join(' ')}  строки ${String(region.start)}-${String(region.end)}`
    ),
    ...index.problems.map((problem) => formatProblem(problem)),
  ]
  return result(EXIT.ok, lines.length > 0 ? lines : [`${file}: вне зон`], {
    file,
    zones: indexed.zones.map((id) => ({
      id,
      title: title(id),
      tags: project.manifest.zones.get(id)?.tags ?? [],
    })),
    regions: indexed.regions,
    problems: index.problems,
  })
}
