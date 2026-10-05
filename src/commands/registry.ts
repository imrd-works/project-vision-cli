import { type Manifest, resolveZoneId } from '../core/manifest.js'
import { type ArchException, exceptionsOfZone, type Registry } from '../core/registry.js'
import type { ApprovalData } from '../core/sync.js'
import { authorEmail } from '../workspace/git.js'
import { approvalsOf } from '../workspace/ownership.js'
import { loadProject } from '../workspace/project.js'
import { appendException, loadRegistry } from '../workspace/registry.js'
import { readCache } from '../workspace/sync-cache.js'

import { ownershipOf } from './grants.js'
import { type CommandResult, EXIT, formatProblem, result } from './result.js'
import { enqueue, planRefusal, sync, syncTarget, type Target } from './sync.js'

/**
 * The architect's registry from the command line: the rules, the deliberate deviations from
 * them, and the owners' decisions on those deviations (kept on the team server).
 */

type Approval = ApprovalData & { by?: string | undefined; at: string }

/** `beacon rules`: the required conditions and how many deviations each has. */
export function rules(root: string): CommandResult {
  const registry = registryOf(root)
  if (registry.rules.length === 0) {
    return result(
      EXIT.ok,
      ['• Правил нет: архитектор описывает их в .beacons/rules.yml', ...problems(registry)],
      {
        rules: [],
      }
    )
  }
  const lines = registry.rules.map((rule) => {
    const count = registry.exceptions.filter((exception) => exception.rule === rule.id).length
    const scope = rule.zones.length === 0 ? 'весь репозиторий' : rule.zones.join(', ')
    return `${rule.id}  ${rule.title} [${rule.kind}] — ${scope}${count > 0 ? ` · исключений: ${String(count)}` : ''}`
  })
  return result(EXIT.ok, [...lines, ...problems(registry)], { rules: registry.rules })
}

/** `beacon exceptions [--zone z]`: deviations with the owners' decisions as of the last sync. */
export function exceptions(root: string, zone: string | undefined): CommandResult {
  const registry = registryOf(root)
  const shown =
    zone === undefined ? registry.exceptions : exceptionsOfZone(registry.exceptions, zone)
  if (shown.length === 0)
    return result(EXIT.ok, ['• Исключений нет', ...problems(registry)], { exceptions: [] })
  const approvals = approvalsHere(root)
  const lines = shown.flatMap((exception) => [
    `${mark(approvals?.get(exception.id))} ${exception.id} — правило ${exception.rule} (${[...exception.zones, ...exception.paths].join(', ')})`,
    `    ${exception.reason}`,
    `    ${exception.author}, ${exception.date}${exception.raw === undefined ? ' · текст не редактировался' : ''}`,
  ])
  return result(EXIT.ok, [...lines, ...problems(registry)], {
    exceptions: shown.map((exception) => ({
      ...exception,
      approval: approvals?.get(exception.id) ?? null,
    })),
  })
}

export interface NewException {
  id: string | undefined
  rule: string
  zones: string[]
  paths: string[]
  reason: string
  /** The developer's own words when an assistant rewrote them into `reason`. */
  raw: string | undefined
  checkpoint: string | undefined
}

/** `beacon exception add`: a named record of a deliberate deviation, in git beside the code. */
export function addException(root: string, input: NewException): CommandResult {
  const load = loadProject(root)
  const manifest = load.kind === 'ok' ? load.project.manifest : undefined
  const registry = registryOf(root)
  const author = authorEmail(root)
  const invalid = checkNew(input, registry, author) ?? unknownZones(input.zones, manifest)
  if (invalid !== undefined) return result(EXIT.usage, [`✖ ${invalid}`], { error: invalid })
  const zones = input.zones.map(
    (zone) => (manifest ? resolveZoneId(manifest, zone) : undefined) ?? zone
  )
  const exception = buildException(input, { registry, zones, author: author ?? '' })
  const error = appendException(root, exception)
  if (error !== undefined) return result(EXIT.failed, [`✖ ${error}`], { error })
  return result(
    EXIT.ok,
    [
      `✓ Исключение ${exception.id} записано в .beacons/exceptions.yml`,
      `  Закоммитьте файл; одобряет владелец зоны или проекта: beacon exception approve ${exception.id}`,
    ],
    { exception }
  )
}

function buildException(
  input: NewException,
  { registry, zones, author }: { registry: Registry; zones: string[]; author: string }
): ArchException {
  const raw = input.raw?.trim()
  const reason = input.reason.trim()
  return {
    id: input.id ?? uniqueId(registry, `${input.rule}-${zones[0]?.replaceAll('.', '-') ?? 'path'}`),
    rule: input.rule,
    zones,
    paths: input.paths,
    reason,
    ...(raw === undefined || raw === reason ? {} : { raw }),
    author,
    date: new Date().toLocaleDateString('sv-SE'),
    ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
  }
}

function unknownZones(
  zones: readonly string[],
  manifest: Manifest | undefined
): string | undefined {
  const unknown = manifest
    ? zones.filter((zone) => resolveZoneId(manifest, zone) === undefined)
    : []
  return unknown.length > 0 ? `зон ${unknown.join(', ')} нет в zones.yml` : undefined
}

function checkNew(
  input: NewException,
  registry: Registry,
  author: string | undefined
): string | undefined {
  if (author === undefined) return 'не задана почта автора: git config user.email'
  if (registry.rules.every((rule) => rule.id !== input.rule)) {
    return `правила "${input.rule}" нет в .beacons/rules.yml`
  }
  if (input.zones.length === 0 && input.paths.length === 0) return 'укажите --zones или --paths'
  if (input.reason.trim() === '') return 'объясните отклонение: --reason "…"'
  if (
    input.id !== undefined &&
    registry.exceptions.some((exception) => exception.id === input.id)
  ) {
    return `исключение ${input.id} уже есть`
  }
  return undefined
}

/** `beacon exception approve <id> [--reject] [--comment …]`: the owners' decision. */
export async function decideException(
  root: string,
  target: Target,
  configDir: string,
  input: { id: string; reject: boolean; comment: string | undefined }
): Promise<CommandResult> {
  const registry = registryOf(root)
  if (registry.exceptions.every((exception) => exception.id !== input.id)) {
    return result(EXIT.usage, [`✖ исключения ${input.id} нет в .beacons/exceptions.yml`], {
      error: 'unknown-exception',
    })
  }
  const refused = planRefusal(root, target, 'exception-registry')
  if (refused) return refused
  const loaded = ownershipOf(root, target)
  if ('failure' in loaded) return loaded.failure
  const key = `${loaded.ownership.repository}:${input.id}`
  enqueue(root, target, {
    kind: 'exception-approval',
    key,
    data: {
      decision: input.reject ? 'rejected' : 'approved',
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    },
  })
  const sent = await sync(root, target, configDir)
  return result(
    EXIT.ok,
    [`✓ Исключение ${input.id} ${input.reject ? 'отклонено' : 'одобрено'}`, sent.text],
    { exception: key, sync: sent.json }
  )
}

function registryOf(root: string): Registry {
  const load = loadProject(root)
  return loadRegistry(root, load.kind === 'ok' ? load.project.manifest : undefined)
}

/** Decisions of the team server, when this repository syncs with one. */
function approvalsHere(root: string): Map<string, Approval> | undefined {
  const target = syncTarget(root, {})
  if (!('server' in target)) return undefined
  const loaded = ownershipOf(root, target)
  if ('failure' in loaded) return undefined
  return approvalsOf(readCache(root, target).bundle?.entities ?? [], loaded.ownership.repository)
}

function mark(approval: Approval | undefined): string {
  if (!approval) return '⏳'
  return approval.decision === 'approved'
    ? `✓ одобрил ${approval.by ?? '?'}`
    : `✖ отклонил ${approval.by ?? '?'}`
}

function uniqueId(registry: Registry, base: string): string {
  const taken = new Set(registry.exceptions.map((exception) => exception.id))
  const slug = base.replaceAll(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '') || 'exception'
  let id = slug
  for (let index = 2; taken.has(id); index++) id = `${slug}-${String(index)}`
  return id
}

function problems(registry: Registry): string[] {
  return registry.problems.map((problem) => formatProblem(problem))
}
