import { MANIFEST_PATH } from '../core/manifest.js'
import type { Problem } from '../core/problem.js'
import { type ManifestSource, type Project, loadProject } from '../workspace/project.js'

/** What a command hands back to the CLI: text for people, data for `--json`, an exit code. */
export interface CommandResult {
  code: number
  text: string
  json: unknown
}

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const

export function result(code: number, lines: readonly string[], json: unknown): CommandResult {
  return { code, text: lines.join('\n'), json }
}

export function formatProblem(problem: Problem): string {
  const mark = problem.severity === 'error' ? '✖' : '⚠'
  const location =
    problem.file === undefined
      ? ''
      : `${problem.file}${problem.line === undefined ? '' : `:${String(problem.line)}`}: `
  return `${mark} ${location}${problem.message}`
}

/** Loads the project or explains why there is nothing to work with. */
export function requireProject(
  root: string,
  source?: ManifestSource
): { project: Project } | { failure: CommandResult } {
  const load = loadProject(root, source)
  if (load.kind === 'ok') return { project: load.project }
  if (load.kind === 'missing') {
    return {
      failure: result(
        EXIT.failed,
        [`✖ Нет карты зон ${MANIFEST_PATH} — создайте её: beacon init`],
        {
          error: 'missing-manifest',
        }
      ),
    }
  }
  return {
    failure: result(
      EXIT.failed,
      [
        `✖ Карта зон ${MANIFEST_PATH} некорректна:`,
        ...load.problems.map((p) => `  ${formatProblem(p)}`),
      ],
      { error: 'invalid-manifest', problems: load.problems }
    ),
  }
}

export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}
