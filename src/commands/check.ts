import { hasErrors, type Problem, warning } from '../core/problem.js'
import { findRepoRoot } from '../workspace/git.js'
import { loadProject, type Project, scanProject } from '../workspace/project.js'

import {
  type CommandResult,
  EXIT,
  formatProblem,
  plural,
  requireProject,
  result,
} from './result.js'

/** Validates the zone map and all beacon markup; `--with` compares zone IDs with other repos. */
export function check(root: string, options: { with: readonly string[] }): CommandResult {
  const loaded = requireProject(root)
  if ('failure' in loaded) return loaded.failure
  const { project } = loaded

  const index = scanProject(project)
  const problems = [...index.problems, ...options.with.flatMap((other) => compare(project, other))]
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.length - errors
  const zoned = index.files.length

  const summary = hasErrors(problems)
    ? `✖ ${String(errors)} ${plural(errors, 'ошибка', 'ошибки', 'ошибок')} разметки`
    : `✓ Карта зон и разметка в порядке: ${String(index.zones.length)} ${plural(index.zones.length, 'зона', 'зоны', 'зон')}, ${String(zoned)} ${plural(zoned, 'файл', 'файла', 'файлов')} в зонах`
  const tail =
    warnings > 0
      ? [
          `⚠ ${String(warnings)} ${plural(warnings, 'предупреждение', 'предупреждения', 'предупреждений')}`,
        ]
      : []

  return result(
    hasErrors(problems) ? EXIT.failed : EXIT.ok,
    [...problems.map((p) => formatProblem(p)), summary, ...tail],
    { ok: !hasErrors(problems), zones: index.zones.length, zonedFiles: zoned, problems }
  )
}

/** Zones that exist only on one side: IDs are project-wide and must match across repos. */
function compare(project: Project, other: string): Problem[] {
  const otherRoot = findRepoRoot(other) ?? other
  const load = loadProject(otherRoot)
  if (load.kind !== 'ok') {
    return [warning(`--with ${other}: карта зон не найдена или некорректна`)]
  }
  const here = new Set(project.manifest.zones.keys())
  const there = new Set(load.project.manifest.zones.keys())
  const onlyHere = [...here].filter((id) => !there.has(id))
  const onlyThere = [...there].filter((id) => !here.has(id))
  return [
    ...onlyHere.map((id) => warning(`зона "${id}" есть только здесь, в ${other} её нет`)),
    ...onlyThere.map((id) => warning(`зона "${id}" есть только в ${other}`)),
  ]
}
