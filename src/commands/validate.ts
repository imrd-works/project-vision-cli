import { CONFIG_PATH } from '../core/config.js'
import { type ValidationSnapshot, validateProject } from '../workspace/live-validation.js'
import type { ValidationRun } from '../workspace/validation-runner.js'

import { type CommandResult, EXIT, formatProblem, plural, result } from './result.js'

/** `beacon validate`: runs the project's architecture checks once; exit 1 on errors. */
export async function validate(root: string): Promise<CommandResult> {
  const outcome = await validateProject(root)
  const lines = describeValidation({ ...outcome, version: 0, running: false })
  const failed = outcome.problems.length > 0 || outcome.runs.some((run) => run.status !== 'passed')
  return result(failed ? EXIT.failed : EXIT.ok, lines, outcome)
}

export function describeValidation(snapshot: ValidationSnapshot): string[] {
  if (snapshot.problems.length > 0) {
    return [
      `✖ ${CONFIG_PATH} некорректен:`,
      ...snapshot.problems.map((p) => `  ${formatProblem(p)}`),
    ]
  }
  if (!snapshot.configured) {
    return [
      `• Проверки архитектуры не настроены — добавьте их в ${CONFIG_PATH}:`,
      '    validation:',
      '      - tool: eslint   # или steiger, dependency-cruiser',
    ]
  }
  return snapshot.runs.flatMap((run) => describeRun(run))
}

function describeRun(run: ValidationRun): string[] {
  if (run.status === 'error') return [`✖ ${run.name}: проверка не выполнилась — ${run.error ?? ''}`]
  const errors = run.violations.filter(
    (violation) => violation.severity === 'error' && violation.exception === undefined
  ).length
  const covered = run.violations.filter((violation) => violation.exception !== undefined).length
  const warnings = run.violations.length - errors - covered
  const notes = [
    warnings > 0 ? `предупреждений: ${String(warnings)}` : '',
    covered > 0 ? `по исключениям: ${String(covered)}` : '',
  ].filter(Boolean)
  const head =
    run.status === 'passed'
      ? `✓ ${run.name}: нарушений архитектуры нет${notes.length > 0 ? `, ${notes.join(', ')}` : ''}`
      : `✖ ${run.name}: ${String(errors)} ${plural(errors, 'нарушение', 'нарушения', 'нарушений')} архитектуры`
  return [
    head,
    ...run.violations.map((violation) => {
      const location = `${violation.file ?? ''}${violation.line === undefined ? '' : `:${String(violation.line)}`}`
      const zones = violation.zones.length > 0 ? `  [${violation.zones.join(', ')}]` : ''
      if (violation.exception !== undefined) {
        return `  ○ ${location}  ${violation.rule}: ${violation.message}${zones} — по исключению ${violation.exception}`
      }
      const mark = violation.severity === 'error' ? '✖' : '⚠'
      return `  ${mark} ${location}  ${violation.rule}: ${violation.message}${zones}`
    }),
  ]
}
