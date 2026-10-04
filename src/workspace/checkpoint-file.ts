import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { isMap, isSeq, parseDocument } from 'yaml'

import { CHECKPOINTS_PATH, type PlanResult, parseCheckpoints } from '../core/checkpoints.js'
import type { Manifest } from '../core/manifest.js'

import { readRevision } from './git.js'

/** Reads `.beacons/checkpoints.yml`; undefined when the repository has no plan. */
export function loadPlan(
  root: string,
  manifest: Manifest,
  from: 'worktree' | 'index' = 'worktree'
): PlanResult | undefined {
  const text =
    from === 'index'
      ? (readRevision(root, '', CHECKPOINTS_PATH) ?? worktreeText(root))
      : worktreeText(root)
  return text === undefined ? undefined : parseCheckpoints(text, manifest)
}

function worktreeText(root: string): string | undefined {
  const file = path.join(root, CHECKPOINTS_PATH)
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

export interface NewDebt {
  id: string
  reason: string
  owner: string
  deadline: string
  waitsFor?: string | undefined
  zones: string[]
}

/**
 * Decisions edit the YAML document in place, so the architect's comments and layout survive.
 * Each function returns an error message, or undefined on success.
 */
export function tickItem(
  root: string,
  checkpoint: string,
  item: string,
  done: { date: string; by: string }
): string | undefined {
  return edit(root, (document) => {
    const items: unknown = document.getIn(['checkpoints', checkpoint, 'items'])
    if (!isSeq(items)) return `Чекпоинта "${checkpoint}" нет`
    const index = items.items.findIndex((entry) => isMap(entry) && entry.get('id') === item)
    if (index === -1)
      return `В чекпоинте "${checkpoint}" нет ручного пункта "${item}" — пункты-зоны закрываются сами`
    document.setIn(
      ['checkpoints', checkpoint, 'items', index, 'done'],
      document.createNode(done, { flow: true })
    )
    return undefined
  })
}

export function closeCheckpoint(
  root: string,
  checkpoint: string,
  closed: { date: string; by: string; debts: NewDebt[] }
): string | undefined {
  return edit(root, (document) => {
    if (!document.hasIn(['checkpoints', checkpoint])) return `Чекпоинта "${checkpoint}" нет`
    if (document.hasIn(['checkpoints', checkpoint, 'closed']))
      return `Чекпоинт "${checkpoint}" уже закрыт`
    const conditional = closed.debts.length > 0
    document.setIn(
      ['checkpoints', checkpoint, 'closed'],
      document.createNode({ date: closed.date, by: closed.by, conditional }, { flow: true })
    )
    const path = ['checkpoints', checkpoint, 'debts']
    for (const debt of closed.debts) {
      const { waitsFor, ...rest } = debt
      const node = document.createNode({
        ...rest,
        created: closed.date,
        ...(waitsFor === undefined ? {} : { waitsFor }),
      })
      // addIn on a missing key would create a map; debts are a list.
      if (isSeq(document.getIn(path))) document.addIn(path, node)
      else document.setIn(path, document.createNode([node]))
    }
    return undefined
  })
}

export function closeDebt(
  root: string,
  checkpoint: string,
  debt: string,
  date: string
): string | undefined {
  return edit(root, (document) => {
    const debts: unknown = document.getIn(['checkpoints', checkpoint, 'debts'])
    if (!isSeq(debts)) return `У чекпоинта "${checkpoint}" нет техдолга`
    const index = debts.items.findIndex((entry) => isMap(entry) && entry.get('id') === debt)
    if (index === -1) return `У чекпоинта "${checkpoint}" нет техдолга "${debt}"`
    if (document.hasIn(['checkpoints', checkpoint, 'debts', index, 'closed']))
      return `Техдолг "${debt}" уже закрыт`
    document.setIn(['checkpoints', checkpoint, 'debts', index, 'closed'], date)
    return undefined
  })
}

function edit(
  root: string,
  change: (document: ReturnType<typeof parseDocument>) => string | undefined
): string | undefined {
  const file = path.join(root, CHECKPOINTS_PATH)
  if (!existsSync(file)) return `Нет ${CHECKPOINTS_PATH}`
  const document = parseDocument(readFileSync(file, 'utf8'))
  const failure = change(document)
  if (failure === undefined) writeFileSync(file, document.toString({ lineWidth: 0 }))
  return failure
}
