import { resolveZoneId } from '../core/manifest.js'
import { type TeamOwnership, teamOwnership } from '../workspace/ownership.js'
import { loadConfig, loadProject } from '../workspace/project.js'

import { who } from './ownership.js'
import { type CommandResult, EXIT, result } from './result.js'
import { enqueue, notSynced, sync, type Target } from './sync.js'

/**
 * Grants: the owner of a zone (or of the project) lets one person change its logic — until a day
 * or for good. A grant is a shared entity of the server: only the owners may give it.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/

export interface GrantRequest {
  zone: string
  email: string
  until: string | undefined
  reason: string | undefined
  revoke: boolean
}

/** `beacon grant <зона> <почта> [--until ГГГГ-ММ-ДД] [--reason …]`, `beacon grant revoke …`. */
export async function grant(
  root: string,
  target: Target,
  configDir: string,
  request: GrantRequest
): Promise<CommandResult> {
  const prepared = prepare(root, target, request)
  if ('failure' in prepared) return prepared.failure
  const key = `${prepared.ownership.repository}:${prepared.zone}/${request.email.toLowerCase()}`
  enqueue(root, target, {
    kind: 'grant',
    key,
    data: request.revoke ? null : { until: request.until ?? null, reason: request.reason ?? '' },
  })
  const sent = await sync(root, target, configDir)
  const person = who(request.email.toLowerCase(), prepared.ownership.people)
  const what = request.revoke
    ? `✓ Грант на ${prepared.zone} для ${person} отозван`
    : `✓ ${person} может менять логику ${prepared.zone} ${request.until === undefined ? 'бессрочно' : `до ${request.until}`}`
  return result(EXIT.ok, [what, sent.text], { grant: key, sync: sent.json })
}

function prepare(
  root: string,
  target: Target,
  request: GrantRequest
): { zone: string; ownership: TeamOwnership } | { failure: CommandResult } {
  if (request.until !== undefined && !DAY.test(request.until)) {
    return { failure: usage('--until: дата в формате ГГГГ-ММ-ДД') }
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(request.email)) return { failure: usage('кому — почта участника') }
  const load = loadProject(root)
  const zone = load.kind === 'ok' ? resolveZoneId(load.project.manifest, request.zone) : undefined
  if (zone === undefined) return { failure: usage(`зоны "${request.zone}" нет в zones.yml`) }
  const ownership = ownershipOf(root, target)
  return 'failure' in ownership ? ownership : { zone, ownership: ownership.ownership }
}

/** `beacon grants [зона]`: grants of this repository's zones in force, as of the last sync. */
export function grants(root: string, target: Target, zone: string | undefined): CommandResult {
  const loaded = ownershipOf(root, target)
  if ('failure' in loaded) return loaded.failure
  const { ownership } = loaded
  const today = new Date().toLocaleDateString('sv-SE')
  const shown = ownership.grants.filter((entry) => zone === undefined || entry.zone === zone)
  if (shown.length === 0) return result(EXIT.ok, ['• Грантов нет'], { grants: [] })
  return result(
    EXIT.ok,
    shown.map((entry) => {
      const expired = entry.until !== undefined && entry.until < today
      const term = entry.until === undefined ? 'бессрочно' : `до ${entry.until}`
      return `${expired ? '○' : '✓'} ${entry.zone} → ${who(entry.grantee, ownership.people)} ${term}${expired ? ' (истёк)' : ''}${entry.grantedBy === undefined ? '' : `, выдал ${who(entry.grantedBy, ownership.people)}`}${entry.reason ? ` — ${entry.reason}` : ''}`
    }),
    { grants: shown }
  )
}

export function ownershipOf(
  root: string,
  target: Target
): { ownership: TeamOwnership } | { failure: CommandResult } {
  const config = loadConfig(root)
  const repository = config.ok ? config.config.server?.repository : undefined
  const load = teamOwnership(root, { ...target, repository })
  if (load.kind === 'not-synced') return { failure: notSynced() }
  if (load.kind === 'unknown-repository') {
    return {
      failure: result(
        EXIT.failed,
        [
          `✖ Не знаю, какой это репозиторий проекта: укажите server.repository (${load.names.join(', ')})`,
        ],
        { error: 'unknown-repository' }
      ),
    }
  }
  return { ownership: load.ownership }
}

function usage(message: string): CommandResult {
  return result(EXIT.usage, [`✖ ${message}`], { error: message })
}
