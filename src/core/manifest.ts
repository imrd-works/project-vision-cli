import { parseDocument } from 'yaml'
import { z } from 'zod'

import { error, type Problem } from './problem.js'
import { byText } from './text.js'
import { ancestorsOf, validateZoneId } from './zone-id.js'

/** Repository-relative location of the zone map. */
export const MANIFEST_PATH = '.beacons/zones.yml'

export interface Zone {
  id: string
  title: string
  description?: string
  /** Glob patterns relative to the repository root. */
  paths: string[]
  /** Tags declared on the zone itself. */
  ownTags: string[]
  /** Own tags plus tags of every declared ancestor, sorted. */
  tags: string[]
  /** Former IDs: commits that still carry them count for this zone. */
  formerly: string[]
}

export interface Manifest {
  zones: ReadonlyMap<string, Zone>
  /** Former ID → current ID. */
  aliases: ReadonlyMap<string, string>
}

const TAG = /^[a-z][a-z0-9-]*$/

const zoneSchema = z.strictObject({
  title: z.string().trim().min(1),
  description: z.string().optional(),
  paths: z.array(z.string().trim().min(1)).default([]),
  tags: z.array(z.string().regex(TAG, 'тег: латиница в нижнем регистре, цифры, дефис')).default([]),
  formerly: z.array(z.string()).default([]),
})

const manifestSchema = z.strictObject({
  version: z.literal(1),
  zones: z
    .record(z.string(), zoneSchema)
    .nullish()
    .transform((zones) => zones ?? {}),
})

type RawZones = z.infer<typeof manifestSchema>['zones']

export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; problems: Problem[] }

export function parseManifest(text: string): ManifestResult {
  const document = parseDocument(text, { prettyErrors: false })
  if (document.errors.length > 0) {
    return { ok: false, problems: document.errors.map((e) => at(`YAML: ${e.message}`)) }
  }
  const parsed = manifestSchema.safeParse(document.toJS())
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) =>
        at(`${issue.path.join('.') || 'корень'}: ${issue.message}`)
      ),
    }
  }
  const problems = validateIds(parsed.data.zones)
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, manifest: buildManifest(parsed.data.zones) }
}

/** Current zone ID for a beacon ID: itself, or the zone that lists it in `formerly`. */
export function resolveZoneId(manifest: Manifest, id: string): string | undefined {
  if (manifest.zones.has(id)) return id
  return manifest.aliases.get(id)
}

const ID_ERRORS = {
  format: 'сегменты через точку, каждый — латиница в нижнем регистре, цифры, дефис',
  reserved: 'зарезервированное слово',
} as const

function validateIds(zones: RawZones): Problem[] {
  const problems: Problem[] = []
  const formerOwners = new Map<string, string>()
  for (const [id, zone] of Object.entries(zones)) {
    const idError = validateZoneId(id)
    if (idError) problems.push(at(`зона "${id}": некорректный ID (${ID_ERRORS[idError]})`))
    for (const former of zone.formerly) {
      const formerError = validateZoneId(former)
      if (formerError) {
        problems.push(at(`зона "${id}": formerly "${former}" (${ID_ERRORS[formerError]})`))
      } else if (former in zones) {
        problems.push(at(`зона "${id}": formerly "${former}" совпадает с действующей зоной`))
      } else if (formerOwners.has(former)) {
        problems.push(
          at(
            `formerly "${former}" указан у двух зон: "${formerOwners.get(former) ?? ''}" и "${id}"`
          )
        )
      }
      formerOwners.set(former, id)
    }
  }
  return problems
}

function buildManifest(rawZones: RawZones): Manifest {
  const zones = new Map<string, Zone>()
  const aliases = new Map<string, string>()
  for (const [id, raw] of Object.entries(rawZones)) {
    const inherited = ancestorsOf(id).flatMap((ancestor) => rawZones[ancestor]?.tags ?? [])
    zones.set(id, {
      id,
      title: raw.title,
      ...(raw.description === undefined ? {} : { description: raw.description }),
      paths: raw.paths,
      ownTags: raw.tags,
      tags: [...new Set([...raw.tags, ...inherited])].toSorted(byText),
      formerly: raw.formerly,
    })
    for (const former of raw.formerly) aliases.set(former, id)
  }
  return { zones, aliases }
}

function at(message: string): Problem {
  return error(message, { file: MANIFEST_PATH })
}
