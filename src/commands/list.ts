import { selectZones, type ZoneFilter } from '../core/audit-pack.js'
import type { IndexedZone, ZoneState } from '../core/project-index.js'
import { scanProject } from '../workspace/project.js'

import { type CommandResult, EXIT, requireProject, result } from './result.js'

export const STATE_LABELS: Record<ZoneState, string> = {
  planned: 'запланирована',
  active: 'активна',
  completed: 'завершена',
}

/**
 * Zones with their files and region line ranges — what an AI auditor gets instead of
 * parsing the whole repository: `beacon list --tag security`.
 */
export function list(root: string, options: ZoneFilter): CommandResult {
  const loaded = requireProject(root)
  if ('failure' in loaded) return loaded.failure

  const zones = selectZones(scanProject(loaded.project), options)
  const lines =
    zones.length === 0 ? ['Подходящих зон нет'] : zones.flatMap((zone) => describe(zone))
  return result(EXIT.ok, lines, { zones })
}

function describe(zone: IndexedZone): string[] {
  const tags = zone.tags.length > 0 ? `  [${zone.tags.join(', ')}]` : ''
  return [
    `${zone.id}  ${zone.title}${tags}  — ${STATE_LABELS[zone.state]}`,
    ...zone.files.map((file) => `  ${file}`),
    ...zone.regions.map(
      (region) => `  ${region.file}:${String(region.start)}-${String(region.end)}`
    ),
  ]
}
