import type {
  CheckpointReport,
  CheckpointState,
  DebtReport,
  ItemReport,
  LineReport,
} from '../core/checkpoint-report.js'
import { CHECKPOINTS_PATH } from '../core/checkpoints.js'
import { findRepoRoot } from '../workspace/git.js'
import { type LineSource, projectTimeline } from '../workspace/timeline-builder.js'

import { type CommandResult, EXIT, formatProblem, result } from './result.js'

const STATE_MARKS: Record<CheckpointState, string> = {
  open: '○',
  ready: '◎',
  closed: '●',
  conditional: '◐',
}
export const STATE_LABELS: Record<CheckpointState, string> = {
  open: 'открыт',
  ready: 'готов к аудиту',
  closed: 'закрыт',
  conditional: 'закрыт условно',
}

export function lineSources(root: string, others: readonly string[]): LineSource[] {
  return [{ root }, ...others.map((dir) => ({ root: findRepoRoot(dir) ?? dir }))]
}

/** `beacon checkpoints [--with ../frontend]`: the lines of checkpoints, their state and debt. */
export function checkpoints(root: string, options: { with: readonly string[] }): CommandResult {
  const built = projectTimeline(lineSources(root, options.with))
  if ('missing' in built) {
    return result(
      EXIT.ok,
      [`• Чекпоинтов нет — опишите их в ${CHECKPOINTS_PATH} (формат: docs/beacon-format.md)`],
      {
        missing: true,
      }
    )
  }
  if ('problems' in built) {
    return result(
      EXIT.failed,
      [`✖ ${CHECKPOINTS_PATH} некорректен:`, ...built.problems.map((p) => `  ${formatProblem(p)}`)],
      { problems: built.problems }
    )
  }
  const { timeline } = built
  return result(
    EXIT.ok,
    [
      ...timeline.lines.flatMap((line) => describeLine(line)),
      ...timeline.problems.map((problem) => formatProblem(problem)),
    ],
    timeline
  )
}

function describeLine(line: LineReport): string[] {
  const { done, total } = line.progress
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return [
    `${line.title} (${line.line}) — пунктов ${String(done)} из ${String(total)}, ${String(percent)}%`,
    ...line.checkpoints.flatMap((checkpoint) => describeCheckpoint(checkpoint)),
  ]
}

function describeCheckpoint(checkpoint: CheckpointReport): string[] {
  const { done, total } = checkpoint.progress
  const deadline = checkpoint.deadline
    ? `, срок ${checkpoint.deadline}${checkpoint.late ? ' — просрочен' : ''}`
    : ''
  return [
    `  ${STATE_MARKS[checkpoint.state]} ${checkpoint.id}  ${checkpoint.title} — ${STATE_LABELS[checkpoint.state]}, ${String(done)}/${String(total)}${deadline}`,
    ...checkpoint.items.map((item) => `      ${describeItem(item)}`),
    ...(checkpoint.blockedBy.length > 0
      ? [`      ⧗ ждёт: ${checkpoint.blockedBy.join(', ')}`]
      : []),
    ...(checkpoint.blocks.length > 0
      ? [`      ⛔ стопер — его ждут: ${checkpoint.blocks.join(', ')}`]
      : []),
    ...checkpoint.debts.map((debt) => `      ${describeDebt(debt)}`),
    ...checkpoint.stagnant.map(
      (entry) =>
        `      ⏸ застой: ${entry.owner} — ${String(entry.workingDays)} раб. дн. без коммитов в своих зонах (с ${entry.since})`
    ),
  ]
}

function describeItem(item: ItemReport): string {
  const owner = item.owner ? ` — ${item.owner}` : ''
  if (item.kind === 'check') {
    const done = item.doneDate ? ` (${item.doneDate}${item.by ? `, ${item.by}` : ''})` : ''
    return `${item.done ? '✓' : '○'} ${item.id}  ${item.title}${owner}${done}`
  }
  const errors =
    item.architectureErrors > 0
      ? ` · нарушений архитектуры: ${String(item.architectureErrors)}`
      : ''
  return `${item.done ? '✓' : '○'} ${item.zone}  ${item.title}${owner}${errors}`
}

function describeDebt(debt: DebtReport): string {
  if (!debt.open) return `✓ техдолг ${debt.id} закрыт ${debt.closed ?? ''}`
  const overdue = debt.overdue ? ` (просрочен, продлён ×${String(debt.extensions)})` : ''
  const unblocked = debt.unblocked ? ` · можно закрывать — ${debt.waitsFor ?? ''} готов` : ''
  const waits = !debt.unblocked && debt.waitsFor ? ` · ждёт ${debt.waitsFor}` : ''
  return `⚑ техдолг ${debt.id}: ${debt.reason} — ${debt.owner}, до ${debt.effectiveDeadline}${overdue}${unblocked}${waits}`
}
