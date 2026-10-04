import { audit } from '../commands/audit.js'
import {
  auditMerge,
  auditReport,
  auditStatus,
  findCheckpoint,
  zonesOf,
} from '../commands/cross-audit.js'
import type { CommandResult } from '../commands/result.js'
import { syncTarget } from '../commands/sync.js'
import { cachedAudit } from '../commands/team-audit.js'

import { type Context, usage } from './context.js'

const SUBCOMMANDS = ['report', 'merge', 'status'] as const

/**
 * `beacon audit`: a context pack (by tag, zone or checkpoint), or a step of a checkpoint's
 * cross-audit — `report`, `merge`, `status` (`start` talks to the server: see team.ts).
 */
export function auditCommand(args: readonly string[], context: Context): CommandResult {
  const [sub, checkpoint] = args
  if (sub === undefined) return contextPack(context)
  if (!(SUBCOMMANDS as readonly string[]).includes(sub) || checkpoint === undefined) {
    return usage('beacon audit report|merge|status <чекпоинт>, beacon audit start <чекпоинт>')
  }
  const target = { root: context.root, checkpoint, round: serverRound(context, checkpoint) }
  if (sub === 'report') return auditReport(target, { model: context.values.model })
  return sub === 'merge' ? auditMerge(target) : auditStatus(target)
}

function contextPack({ root, values }: Context): CommandResult {
  const base = {
    tag: values.tag,
    zone: values.zone,
    includeTests: values.tests === true,
    code: values.code !== false,
  }
  if (values.checkpoint === undefined) return audit(root, base)
  const found = findCheckpoint(root, values.checkpoint)
  if ('failure' in found) return found.failure
  const ref = `${found.line}:${found.checkpoint.id}`
  return audit(root, {
    ...base,
    zones: { ids: zonesOf(found.checkpoint), label: `чекпоинт ${ref}` },
  })
}

/** The round the team server opened, as of the last `beacon sync`; none without a server. */
function serverRound({ root, values }: Context, checkpoint: string): number | undefined {
  const target = syncTarget(root, values)
  if (!('server' in target)) return undefined
  const found = findCheckpoint(root, checkpoint)
  if ('failure' in found) return undefined
  return cachedAudit(root, target, `${found.line}:${found.checkpoint.id}`)?.round ?? undefined
}
