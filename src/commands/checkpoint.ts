import { CHECKPOINTS_PATH } from '../core/checkpoints.js'
import { qaBlockers } from '../core/qa.js'
import { type NewDebt, closeCheckpoint, closeDebt, tickItem } from '../workspace/checkpoint-file.js'
import { authorEmail } from '../workspace/git.js'
import { loadConfig } from '../workspace/project.js'
import { readCache } from '../workspace/sync-cache.js'
import { projectTimeline } from '../workspace/timeline-builder.js'

import { type CommandResult, EXIT, result } from './result.js'

export interface CloseOptions {
  conditional?: boolean | undefined
  debtId?: string | undefined
  reason?: string | undefined
  owner?: string | undefined
  deadline?: string | undefined
  waitsFor?: string | undefined
  zones?: string | undefined
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** `beacon checkpoint tick|close …`: decisions on the plan, written into checkpoints.yml. */
export function checkpointCommand(
  root: string,
  args: readonly string[],
  options: CloseOptions
): CommandResult {
  const [action, id, item] = args
  const today = new Date().toLocaleDateString('sv-SE')
  const by = authorEmail(root) ?? 'unknown'
  if (action === 'tick' && id !== undefined && item !== undefined) {
    return outcome(
      tickItem(root, id, item, { date: today, by }),
      `✓ ${id}: пункт «${item}» отмечен`
    )
  }
  if (action === 'close' && id !== undefined) return close(root, id, options, { today, by })
  return fail(
    'beacon checkpoint tick <чекпоинт> <пункт> | close <чекпоинт> [--conditional …]',
    EXIT.usage
  )
}

/** `beacon debt close <checkpoint> <debt>`. */
export function debtCommand(root: string, args: readonly string[]): CommandResult {
  const [action, checkpoint, debt] = args
  if (action !== 'close' || checkpoint === undefined || debt === undefined) {
    return fail('beacon debt close <чекпоинт> <техдолг>', EXIT.usage)
  }
  const today = new Date().toLocaleDateString('sv-SE')
  return outcome(closeDebt(root, checkpoint, debt, today), `✓ техдолг ${debt} закрыт`)
}

function close(
  root: string,
  id: string,
  options: CloseOptions,
  { today, by }: { today: string; by: string }
): CommandResult {
  const built = projectTimeline([{ root }])
  if (!('timeline' in built))
    return fail(`Нет корректного ${CHECKPOINTS_PATH} — beacon checkpoints покажет ошибки`)
  const checkpoint = built.timeline.lines[0]?.checkpoints.find((entry) => entry.id === id)
  if (!checkpoint) return fail(`Чекпоинта "${id}" нет`)
  if (checkpoint.closed) return fail(`Чекпоинт "${id}" уже закрыт`)
  const pending = checkpoint.items.filter((entry) => !entry.done)
  if (!options.conditional) {
    if (pending.length > 0) {
      const names = pending
        .map((entry) => (entry.kind === 'zone' ? entry.zone : entry.id))
        .join(', ')
      return fail(
        `Не все пункты закрыты: ${names}. Закройте условно: --conditional --reason «…» --owner email --deadline ГГГГ-ММ-ДД`
      )
    }
    const testing = testingBlockers(root, checkpoint.ref)
    if (testing.length > 0) {
      return fail(
        `Тестировщики ещё не приняли ${checkpoint.ref}: ${testing.join('; ')}. Закройте условно: --conditional …`
      )
    }
    return outcome(closeCheckpoint(root, id, { date: today, by, debts: [] }), `● ${id} закрыт`)
  }
  const debt = newDebt(
    id,
    options,
    pending.flatMap((entry) => (entry.kind === 'zone' ? [entry.zone] : [])),
    by
  )
  if (typeof debt === 'string') return fail(debt)
  return outcome(
    closeCheckpoint(root, id, { date: today, by, debts: [debt] }),
    `◐ ${id} закрыт условно, техдолг ${debt.id}: ${debt.owner}, до ${debt.deadline}`
  )
}

/** The testers' state of the last `beacon sync`, when this repository syncs with a team server. */
function testingBlockers(root: string, ref: string): string[] {
  const config = loadConfig(root)
  const server = config.ok ? config.config.server : undefined
  if (!server) return []
  const cache = readCache(root, { server: server.url, project: server.project })
  return qaBlockers(cache.bundle?.qa, ref)
}

function newDebt(
  checkpoint: string,
  options: CloseOptions,
  pendingZones: string[],
  by: string
): NewDebt | string {
  if (!options.reason) return 'Условное закрытие требует причины: --reason «…»'
  if (!options.deadline || !DATE.test(options.deadline))
    return 'Условное закрытие требует дедлайна: --deadline ГГГГ-ММ-ДД'
  const zones =
    options.zones === undefined
      ? pendingZones
      : options.zones
          .split(',')
          .map((zone) => zone.trim())
          .filter(Boolean)
  return {
    id: options.debtId ?? `${checkpoint}-debt`,
    reason: options.reason,
    owner: (options.owner ?? by).toLowerCase(),
    deadline: options.deadline,
    waitsFor: options.waitsFor,
    zones,
  }
}

function outcome(failure: string | undefined, success: string): CommandResult {
  if (failure !== undefined) return fail(failure)
  return result(
    EXIT.ok,
    [success, `Закоммитьте ${CHECKPOINTS_PATH}, чтобы решение увидела команда`],
    { ok: true }
  )
}

function fail(message: string, code: number = EXIT.failed): CommandResult {
  return result(code, [`✖ ${message}`], { error: message })
}
