import { median, workingDaysBetween } from './calendar.js'
import {
  type CheckpointReport,
  type DebtReport,
  isFinished,
  type ItemReport,
  type LineReport,
  type Stagnation,
} from './checkpoint-report.js'
import { type Problem, warning } from './problem.js'

/**
 * All lines side by side: links between checkpoints of different lines, stoppers (checkpoints
 * others wait for), debts whose blocker is gone (priority capture) and stuck developers.
 */

export interface Activity {
  /** Last commit date (YYYY-MM-DD) of `email` in any of `zones`; in any zone when `zones` is empty. */
  last: (email: string, zones: readonly string[]) => string | undefined
  /** Working days from a zone's first commit to its completion, for every completed zone. */
  durations: readonly number[]
}

export interface Timeline {
  lines: LineReport[]
  /** Working days without progress before a developer counts as stuck. */
  stagnationDays: number
  problems: Problem[]
}

/** With fewer completed zones the median says little; the configured threshold applies. */
const MIN_DURATION_SAMPLES = 5

export function buildTimeline(
  lines: readonly LineReport[],
  activity: Activity,
  options: { today: string; stagnationDays: number }
): Timeline {
  const all = lines.flatMap((line) => line.checkpoints)
  const byRef = new Map(all.map((checkpoint) => [checkpoint.ref, checkpoint]))
  const stagnationDays = stagnationThreshold(activity.durations, options.stagnationDays)
  const missing = new Set<string>()

  const resolve = (checkpoint: CheckpointReport): CheckpointReport => ({
    ...checkpoint,
    // A closed checkpoint waits for nothing any more, even when closed conditionally because of it.
    blockedBy: checkpoint.dependsOn.filter((ref) => {
      const target = byRef.get(ref)
      if (!target) missing.add(`${checkpoint.ref} → ${ref}`)
      return target !== undefined && !isFinished(target.state) && !isFinished(checkpoint.state)
    }),
    blocks: isFinished(checkpoint.state) ? [] : waitingFor(checkpoint.ref, all),
    debts: checkpoint.debts.map((debt) => ({
      ...debt,
      unblocked: debt.open && debt.waitsFor !== undefined && isDone(byRef.get(debt.waitsFor)),
    })),
    stagnant:
      checkpoint.state === 'closed'
        ? []
        : stuckOwners(checkpoint, activity, { ...options, stagnationDays }),
  })

  return {
    lines: lines.map((line) => ({
      ...line,
      checkpoints: line.checkpoints.map((checkpoint) => resolve(checkpoint)),
    })),
    stagnationDays,
    problems: [...missing].map((link) =>
      warning(
        `связь ${link}: такой линии или чекпоинта нет — подключите репозиторий линии (--with)`
      )
    ),
  }
}

export interface Todo {
  owner: string
  /** Priority first: unblocked debts, then overdue ones, then by deadline. */
  debts: (DebtReport & { checkpoint: string })[]
  items: (ItemReport & { checkpoint: string })[]
  stagnant: { checkpoint: string; since: string; workingDays: number }[]
}

/** One developer's list: their technical debt and unfinished items across all lines. */
export function todoFor(timeline: Timeline, owner: string): Todo {
  const checkpoints = timeline.lines.flatMap((line) => line.checkpoints)
  const mine = (who: string | undefined): boolean => who?.toLowerCase() === owner.toLowerCase()
  const debts = checkpoints
    .flatMap((checkpoint) =>
      checkpoint.debts
        .filter((debt) => debt.open && mine(debt.owner))
        .map((debt) => ({ ...debt, checkpoint: checkpoint.ref }))
    )
    .toSorted(
      (a, b) =>
        Number(b.unblocked) - Number(a.unblocked) ||
        Number(b.overdue) - Number(a.overdue) ||
        a.effectiveDeadline.localeCompare(b.effectiveDeadline)
    )
  const items = checkpoints
    .filter((checkpoint) => !isFinished(checkpoint.state))
    .flatMap((checkpoint) =>
      checkpoint.items
        .filter((item) => !item.done && mine(item.owner))
        .map((item) => ({ ...item, checkpoint: checkpoint.ref }))
    )
  const stagnant = checkpoints.flatMap((checkpoint) =>
    checkpoint.stagnant
      .filter((entry) => mine(entry.owner))
      .map((entry) => ({
        checkpoint: checkpoint.ref,
        since: entry.since,
        workingDays: entry.workingDays,
      }))
  )
  return { owner, debts, items, stagnant }
}

/** Twice the median time to complete a zone, but never below the configured days. */
function stagnationThreshold(durations: readonly number[], configured: number): number {
  if (durations.length < MIN_DURATION_SAMPLES) return configured
  return Math.max(configured, Math.round((median(durations) ?? 0) * 2))
}

function isDone(checkpoint: CheckpointReport | undefined): boolean {
  return checkpoint !== undefined && isFinished(checkpoint.state)
}

/** Who waits for `ref`: unfinished checkpoints that depend on it, and open debts of any checkpoint. */
function waitingFor(ref: string, all: readonly CheckpointReport[]): string[] {
  return all
    .filter(
      (other) =>
        (!isFinished(other.state) && other.dependsOn.includes(ref)) ||
        other.debts.some((debt) => debt.open && debt.waitsFor === ref)
    )
    .map((other) => other.ref)
}

/** Owners with unfinished parts and no commits in the related zones for too long. */
function stuckOwners(
  checkpoint: CheckpointReport,
  activity: Activity,
  { today, stagnationDays }: { today: string; stagnationDays: number }
): Stagnation[] {
  const zonesByOwner = new Map<string, Set<string>>()
  const add = (owner: string | undefined, zones: readonly string[]): void => {
    if (owner === undefined) return
    const key = owner.toLowerCase()
    zonesByOwner.set(key, new Set([...(zonesByOwner.get(key) ?? []), ...zones]))
  }
  for (const item of checkpoint.items) {
    if (!item.done) add(item.owner, item.kind === 'zone' ? [item.zone] : [])
  }
  for (const debt of checkpoint.debts) if (debt.open) add(debt.owner, debt.zones)

  return [...zonesByOwner].flatMap(([owner, zones]) => {
    const since = activity.last(owner, [...zones]) ?? activity.last(owner, [])
    if (since === undefined) return []
    const workingDays = workingDaysBetween(since, today)
    return workingDays > stagnationDays ? [{ owner, since, workingDays }] : []
  })
}
