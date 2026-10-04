import { type Todo, todoFor } from '../core/timeline.js'
import { authorEmail } from '../workspace/git.js'
import { projectTimeline } from '../workspace/timeline-builder.js'

import { lineSources } from './checkpoints.js'
import { type CommandResult, EXIT, result } from './result.js'

/** A developer's list (`beacon` to-do): their debts, priority first, and unfinished items. */
export function todo(
  root: string,
  options: { owner?: string | undefined; with: readonly string[] }
): CommandResult {
  const owner = options.owner ?? authorEmail(root)
  if (owner === undefined)
    return result(EXIT.failed, ['✖ Не знаю, кто вы: задайте git config user.email или --owner'], {})
  const built = projectTimeline(lineSources(root, options.with))
  if (!('timeline' in built))
    return result(EXIT.ok, ['• Чекпоинтов нет — и задач тоже'], { owner, debts: [], items: [] })
  return describeTodo(todoFor(built.timeline, owner))
}

/** A developer's list as text, local or from the server's timeline. */
export function describeTodo(list: Todo): CommandResult {
  const { owner } = list
  const lines = [
    `Задачи ${owner}:`,
    ...list.debts.map((debt, index) => {
      const mark = debt.unblocked ? '★' : debt.overdue ? '⚑' : '•'
      const why = debt.unblocked
        ? ` — ПРИОРИТЕТ: ${debt.waitsFor ?? ''} готов, можно закрывать`
        : ''
      return `  ${String(index + 1)}. ${mark} техдолг ${debt.id} (${debt.checkpoint}): ${debt.reason}, до ${debt.effectiveDeadline}${why}`
    }),
    ...list.items.map(
      (item) =>
        `  • ${item.kind === 'zone' ? item.zone : item.id} (${item.checkpoint}): ${item.title}`
    ),
    ...list.stagnant.map(
      (entry) =>
        `  ⏸ ${entry.checkpoint}: ${String(entry.workingDays)} раб. дн. без коммитов в своих зонах — нужна помощь?`
    ),
  ]
  if (list.debts.length === 0 && list.items.length === 0) lines.push('  Ничего не висит')
  return result(EXIT.ok, lines, list)
}
