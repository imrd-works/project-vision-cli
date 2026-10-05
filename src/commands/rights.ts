import { personOf } from '../core/identity.js'
import { permission } from '../core/ownership.js'
import type { Person } from '../core/sync.js'

import { FREE_EDITS, prepareGate, today, who } from './ownership.js'
import { type CommandResult, EXIT, result } from './result.js'

/**
 * `beacon rights`: every zone of this repository with whether I may change its logic, and who to
 * ask otherwise — what an editor plugin needs to dim others' zones and show their owners.
 */
export function rights(root: string, configDir: string): CommandResult {
  const prepared = prepareGate(root, configDir)
  if ('failure' in prepared) return prepared.failure
  const { project, ownership, person } = prepared
  const zones = [...project.manifest.zones.keys()].map((zone) => {
    const right = permission({
      zone,
      owners: ownership.owners,
      grants: ownership.grants,
      person,
      today: today(),
    })
    const owner = 'owner' in right ? right.owner : undefined
    return {
      zone,
      allowed: right.allowed,
      via: right.allowed ? right.via : null,
      owner: owner ? contact(owner.owner, ownership.people) : null,
      proxies: (owner?.proxies ?? []).map((email) => contact(email, ownership.people)),
    }
  })
  const foreign = zones.filter((zone) => !zone.allowed)
  return result(
    EXIT.ok,
    [
      `Вы: ${person?.name ?? 'не участник проекта'} · репозиторий ${ownership.repository}`,
      ...foreign.map(
        (zone) => `✖ ${zone.zone} — владелец ${who(zone.owner?.email ?? null, ownership.people)}`
      ),
      foreign.length === 0 ? '✓ Чужих зон нет' : FREE_EDITS,
    ],
    {
      repository: ownership.repository,
      person: person ? { name: person.name, emails: person.emails } : null,
      zones,
      freeEdits: FREE_EDITS,
    }
  )
}

function contact(
  email: string | null,
  people: readonly Person[]
): { email: string; name: string; contacts: Person['contacts'] | null } | null {
  if (email === null) return null
  const person = personOf(people, email)
  return { email, name: person?.name ?? email, contacts: person?.contacts ?? null }
}
