import { type ChangedFile, touchedZones } from '../core/commit-check.js'
import type { Grant, ZoneOwnerRecord } from '../core/ownership.js'
import {
  type ChangedBundle,
  type GrantData,
  grantDataSchema,
  type Person,
  type SyncEntity,
} from '../core/sync.js'

import { configValue } from './git.js'
import type { Project } from './project.js'
import { readCache } from './sync-cache.js'

/**
 * Ownership as of the last `beacon sync`: who owns the zones of this repository, who may change
 * them alongside, and the grants in force. Works offline, like every check of the hooks.
 */

export interface TeamOwnership {
  /** This repository's name in the project: zone references are `<repository>:<zone>`. */
  repository: string
  owners: Map<string, ZoneOwnerRecord>
  grants: Grant[]
  people: readonly Person[]
  syncedAt: string | undefined
}

export type OwnershipLoad =
  | { kind: 'ok'; ownership: TeamOwnership }
  | { kind: 'not-synced' }
  | { kind: 'unknown-repository'; names: string[] }

export function teamOwnership(
  root: string,
  target: { server: string; project: string; repository?: string | undefined }
): OwnershipLoad {
  const cache = readCache(root, target)
  const bundle = cache.bundle
  if (!bundle?.owners || !bundle.people) return { kind: 'not-synced' }
  const repository = repositoryOf(root, bundle, target.repository)
  if (repository === undefined) {
    return { kind: 'unknown-repository', names: (bundle.repositories ?? []).map((r) => r.name) }
  }
  const owners = new Map(
    bundle.owners
      .filter((zone) => zone.repository === repository)
      .map((zone) => [zone.zone, { zone: zone.zone, owner: zone.owner, proxies: zone.proxies }])
  )
  return {
    kind: 'ok',
    ownership: {
      repository,
      owners,
      grants: grantsOf(bundle.entities ?? [], repository),
      people: bundle.people,
      syncedAt: cache.syncedAt,
    },
  }
}

/**
 * The repository of this checkout among the project's: named in the config, else the one whose
 * address is the origin remote's, else the only one.
 */
export function repositoryOf(
  root: string,
  bundle: Pick<ChangedBundle, 'repositories'>,
  configured: string | undefined
): string | undefined {
  if (configured !== undefined) return configured
  const repositories = bundle.repositories ?? []
  const origin = configValue(root, 'remote.origin.url')
  const byUrl =
    origin === undefined
      ? undefined
      : repositories.find(
          (repository) => repository.url !== undefined && sameRemote(repository.url, origin)
        )
  if (byUrl) return byUrl.name
  return repositories.length === 1 ? repositories[0]?.name : undefined
}

/** `git@github.com:org/repo.git` and `https://github.com/org/repo` are one repository. */
export function sameRemote(a: string, b: string): boolean {
  return remoteKey(a) === remoteKey(b)
}

function remoteKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

/** Grants of this repository's zones (`<repository>:<zone>/<email>`); revoked ones are null. */
export function grantsOf(entities: readonly SyncEntity[], repository: string): Grant[] {
  return entities.flatMap((entity) => {
    if (entity.kind !== 'grant') return []
    const key = /^(?<repo>[^:]+):(?<zone>[^/]+)\/(?<grantee>.+)$/.exec(entity.key)?.groups
    const data = grantDataSchema.safeParse(entity.data)
    if (key?.['repo'] !== repository || !data.success) return []
    return [toGrant(key['zone'] ?? '', key['grantee'] ?? '', data.data, entity.updatedBy?.email)]
  })
}

function toGrant(
  zone: string,
  grantee: string,
  data: GrantData,
  grantedBy: string | undefined
): Grant {
  return {
    zone,
    grantee,
    ...(data.until === null ? {} : { until: data.until }),
    ...(grantedBy === undefined ? {} : { grantedBy }),
    reason: data.reason,
  }
}

/** Each changed file with the zones it touches: by path, by file beacons, by changed regions. */
export function zonesOfFiles(
  project: Project,
  files: readonly ChangedFile[]
): { file: ChangedFile; zones: string[] }[] {
  return files.map((file) => ({
    file,
    zones: touchedZones(project, [file]).zones.map((touch) => touch.zone),
  }))
}
