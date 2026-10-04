import { addDays, daysBetween } from './calendar.js'
import {
  type CheckpointPlan,
  type Debt,
  isZoneItem,
  type PlannedCheckpoint,
  type PlanItem,
} from './checkpoints.js'
import type { ZoneState } from './project-index.js'

/**
 * The state of one line computed from its plan and the live facts about zones: which items are
 * done, where each checkpoint stands, how its technical debt is doing.
 */

export interface ZoneFacts {
  title: string
  state: ZoneState
  /** Architecture violations (errors) in the zone's files from the last check. */
  architectureErrors: number
}

export type ItemReport =
  | {
      kind: 'zone'
      zone: string
      title: string
      owner?: string
      state: ZoneState | 'unknown'
      architectureErrors: number
      /** The zone is completed and its architecture is clean. */
      done: boolean
    }
  | {
      kind: 'check'
      id: string
      title: string
      owner?: string
      done: boolean
      doneDate?: string
      by?: string
    }

export interface DebtReport {
  id: string
  reason: string
  owner: string
  created: string
  deadline: string
  /** The deadline after automatic extensions: an overdue debt moves on instead of hanging. */
  effectiveDeadline: string
  overdue: boolean
  extensions: number
  waitsFor?: string
  zones: string[]
  closed?: string
  open: boolean
  /** What it waited for is done: the debt is its owner's first priority. Set by the timeline. */
  unblocked: boolean
}

/** open → ready (every item done, waits for the cross-audit) → closed; or closed conditionally with debt. */
export type CheckpointState = 'open' | 'ready' | 'closed' | 'conditional'

export interface Stagnation {
  owner: string
  /** Last commit of the owner in the related zones. */
  since: string
  workingDays: number
}

export interface CheckpointReport {
  id: string
  line: string
  /** `line:id`: how other lines refer to it. */
  ref: string
  title: string
  description?: string
  deadline?: string
  /** The deadline passed and the checkpoint is not closed. */
  late: boolean
  state: CheckpointState
  progress: { done: number; total: number }
  items: ItemReport[]
  debts: DebtReport[]
  after: string[]
  /** Normalized to `line:id`. */
  dependsOn: string[]
  closed?: { date: string; by?: string | undefined; conditional: boolean }
  /** Unfinished checkpoints it waits for. Set by the timeline. */
  blockedBy: string[]
  /** Unfinished checkpoints that wait for it: non-empty makes it a stopper. Set by the timeline. */
  blocks: string[]
  /** Owners who have not moved on their part for too long. Set by the timeline. */
  stagnant: Stagnation[]
  /** Who signs its cross-audit: the plan's auditors, else the owners of its items. */
  audit: { auditors: string[]; consolidator?: string }
}

export interface LineReport {
  line: string
  title: string
  checkpoints: CheckpointReport[]
  progress: { done: number; total: number }
}

export interface ReportOptions {
  today: string
  extendDays: number
}

export function reportLine(
  plan: CheckpointPlan,
  facts: (zone: string) => ZoneFacts | undefined,
  options: ReportOptions
): LineReport {
  const checkpoints = plan.checkpoints.map((checkpoint) =>
    reportCheckpoint(plan.line, checkpoint, facts, options)
  )
  return {
    line: plan.line,
    title: plan.title,
    checkpoints,
    progress: sum(checkpoints.map((checkpoint) => checkpoint.progress)),
  }
}

export function normalizeRef(ref: string, line: string): string {
  return ref.includes(':') ? ref : `${line}:${ref}`
}

export function isFinished(state: CheckpointState): boolean {
  return state === 'closed' || state === 'conditional'
}

function reportCheckpoint(
  line: string,
  checkpoint: PlannedCheckpoint,
  facts: (zone: string) => ZoneFacts | undefined,
  options: ReportOptions
): CheckpointReport {
  const items = checkpoint.items.map((item) => reportItem(item, facts))
  const debts = checkpoint.debts.map((debt) => reportDebt(debt, line, options))
  const done = items.filter((item) => item.done).length
  const state = stateOf(checkpoint, items, debts)
  return {
    id: checkpoint.id,
    line,
    ref: `${line}:${checkpoint.id}`,
    title: checkpoint.title,
    ...(checkpoint.description === undefined ? {} : { description: checkpoint.description }),
    ...(checkpoint.deadline === undefined ? {} : { deadline: checkpoint.deadline }),
    late:
      checkpoint.deadline !== undefined &&
      !isFinished(state) &&
      options.today > checkpoint.deadline,
    state,
    progress: { done, total: items.length },
    items,
    debts,
    after: checkpoint.after,
    dependsOn: checkpoint.dependsOn.map((ref) => normalizeRef(ref, line)),
    ...(checkpoint.closed === undefined ? {} : { closed: checkpoint.closed }),
    blockedBy: [],
    blocks: [],
    stagnant: [],
    audit: auditorsOf(checkpoint),
  }
}

function auditorsOf(checkpoint: PlannedCheckpoint): { auditors: string[]; consolidator?: string } {
  const owners = checkpoint.items.flatMap((item) => (item.owner === undefined ? [] : [item.owner]))
  const auditors = [...new Set((checkpoint.audit?.auditors ?? owners).map((e) => e.toLowerCase()))]
  const consolidator = checkpoint.audit?.consolidator?.toLowerCase()
  return consolidator === undefined ? { auditors } : { auditors, consolidator }
}

function reportItem(item: PlanItem, facts: (zone: string) => ZoneFacts | undefined): ItemReport {
  return isZoneItem(item) ? reportZoneItem(item, facts(item.zone)) : reportCheckItem(item)
}

function reportCheckItem(item: Exclude<PlanItem, { zone: string }>): ItemReport {
  return {
    kind: 'check',
    id: item.id,
    title: item.check,
    ...(item.owner === undefined ? {} : { owner: item.owner }),
    done: item.done !== undefined,
    ...(item.done === undefined ? {} : { doneDate: item.done.date }),
    ...(item.done?.by === undefined ? {} : { by: item.done.by }),
  }
}

function reportZoneItem(
  item: Extract<PlanItem, { zone: string }>,
  zone: ZoneFacts | undefined
): ItemReport {
  const architectureErrors = zone?.architectureErrors ?? 0
  return {
    kind: 'zone',
    zone: item.zone,
    title: zone?.title ?? item.zone,
    ...(item.owner === undefined ? {} : { owner: item.owner }),
    state: zone?.state ?? 'unknown',
    architectureErrors,
    done: zone?.state === 'completed' && architectureErrors === 0,
  }
}

function reportDebt(debt: Debt, line: string, { today, extendDays }: ReportOptions): DebtReport {
  const open = debt.closed === undefined
  const late = open && today > debt.deadline
  const extensions = late ? Math.ceil(daysBetween(debt.deadline, today) / extendDays) : 0
  return {
    id: debt.id,
    reason: debt.reason,
    owner: debt.owner,
    created: debt.created,
    deadline: debt.deadline,
    effectiveDeadline: addDays(debt.deadline, extensions * extendDays),
    overdue: late,
    extensions,
    ...(debt.waitsFor === undefined ? {} : { waitsFor: normalizeRef(debt.waitsFor, line) }),
    zones: debt.zones,
    ...(debt.closed === undefined ? {} : { closed: debt.closed }),
    open,
    unblocked: false,
  }
}

function stateOf(
  checkpoint: PlannedCheckpoint,
  items: readonly ItemReport[],
  debts: readonly DebtReport[]
): CheckpointState {
  if (checkpoint.closed) {
    return checkpoint.closed.conditional && debts.some((debt) => debt.open)
      ? 'conditional'
      : 'closed'
  }
  return items.every((item) => item.done) ? 'ready' : 'open'
}

function sum(parts: readonly { done: number; total: number }[]): { done: number; total: number } {
  return parts.reduce(
    (acc, part) => ({ done: acc.done + part.done, total: acc.total + part.total }),
    {
      done: 0,
      total: 0,
    }
  )
}
