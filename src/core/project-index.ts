import { buildArchitectureTree, type DirNode } from './architecture-tree.js'
import { commentStyleFor } from './comment-style.js'
import { type Manifest, resolveZoneId } from './manifest.js'
import type { FileMarkup } from './markup.js'
import { error, type Problem } from './problem.js'
import { byText } from './text.js'
import type { PathZone } from './zone-resolver.js'

/** A file as the scanner saw it. `markup` is absent for binary or oversized files. */
export interface ScannedFile {
  path: string
  pathZone: PathZone
  markup?: FileMarkup
}

export type ZoneState = 'planned' | 'active' | 'completed'

export interface IndexedRegion {
  file: string
  start: number
  end: number
}

export interface IndexedZone {
  id: string
  title: string
  description?: string
  tags: string[]
  paths: string[]
  state: ZoneState
  /** Files that belong to the zone entirely: by `paths` or by a file beacon. */
  files: string[]
  regions: IndexedRegion[]
}

export interface IndexedFile {
  path: string
  zones: string[]
  regions: { zones: string[]; start: number; end: number }[]
}

export interface ProjectIndex {
  version: 1
  zones: IndexedZone[]
  /** Files with at least one zone (entirely or by a region). */
  files: IndexedFile[]
  coverage: { sourceFiles: number; zonedSourceFiles: number }
  /** Topmost folders with source files and no zones at all. */
  unzonedDirs: string[]
  /** Folders with file counts and zones: the architecture tree. */
  tree: DirNode
  problems: Problem[]
}

const NOT_SOURCE = /\.(?:md|mdx|ya?ml|toml|env)$/

export function isSourceFile(path: string): boolean {
  return commentStyleFor(path) !== undefined && !NOT_SOURCE.test(path) && !path.startsWith('.')
}

export function buildIndex(
  manifest: Manifest,
  scanned: readonly ScannedFile[],
  completed: ReadonlySet<string>
): ProjectIndex {
  const problems: Problem[] = []
  const files = scanned
    .map((file) => indexFile(manifest, file, problems))
    .filter((file) => file.zones.length > 0 || file.regions.length > 0)

  const zones = [...manifest.zones.values()].map((zone): IndexedZone => {
    const zoneFiles = files.filter((file) => file.zones.includes(zone.id)).map((file) => file.path)
    const regions = files.flatMap((file) =>
      file.regions
        .filter((region) => region.zones.includes(zone.id))
        .map((region) => ({ file: file.path, start: region.start, end: region.end }))
    )
    const active = zoneFiles.length > 0 || regions.length > 0
    return {
      id: zone.id,
      title: zone.title,
      ...(zone.description === undefined ? {} : { description: zone.description }),
      tags: zone.tags,
      paths: zone.paths,
      state: completed.has(zone.id) ? 'completed' : active ? 'active' : 'planned',
      files: zoneFiles,
      regions,
    }
  })

  const zoned = new Set(files.map((file) => file.path))
  const zonesByFile = new Map(
    files.map((file) => [
      file.path,
      [...new Set([...file.zones, ...file.regions.flatMap((region) => region.zones)])],
    ])
  )
  const sources = scanned.map((file) => file.path).filter((path) => isSourceFile(path))
  return {
    version: 1,
    zones: zones.toSorted((a, b) => a.id.localeCompare(b.id)),
    files,
    coverage: {
      sourceFiles: sources.length,
      zonedSourceFiles: sources.filter((path) => zoned.has(path)).length,
    },
    unzonedDirs: unzonedDirs(sources, zoned),
    tree: buildArchitectureTree(
      scanned.map((file) => ({ path: file.path, zones: zonesByFile.get(file.path) ?? [] }))
    ),
    problems,
  }
}

function indexFile(manifest: Manifest, file: ScannedFile, problems: Problem[]): IndexedFile {
  const zones = new Set<string>()
  if (file.pathZone.kind === 'zone') zones.add(file.pathZone.zone)
  if (file.pathZone.kind === 'conflict') {
    problems.push(
      error(`файл попадает в несвязанные зоны ${file.pathZone.zones.join(', ')}`, {
        file: file.path,
      })
    )
  }
  const markup = file.markup
  if (!markup) return { path: file.path, zones: [...zones], regions: [] }

  problems.push(...markup.problems)
  const resolve = (id: string, line: number): string[] => {
    const zone = resolveZoneId(manifest, id)
    if (zone !== undefined) return [zone]
    problems.push(
      error(`маяк неизвестной зоны "${id}" — её нет в zones.yml`, { file: file.path, line })
    )
    return []
  }
  for (const beacon of markup.fileBeacons) {
    for (const zone of resolve(beacon.id, beacon.line)) zones.add(zone)
  }
  const regions = markup.regions
    .map((region) => ({
      zones: [...new Set(region.ids.flatMap((id) => resolve(id, region.start)))],
      start: region.start,
      end: region.end,
    }))
    .filter((region) => region.zones.length > 0)
  return { path: file.path, zones: [...zones].toSorted(byText), regions }
}

function unzonedDirs(sources: readonly string[], zoned: ReadonlySet<string>): string[] {
  const stats = new Map<string, { zoned: number }>()
  for (const path of sources) {
    for (const dir of parentDirs(path)) {
      const stat = stats.get(dir) ?? { zoned: 0 }
      if (zoned.has(path)) stat.zoned++
      stats.set(dir, stat)
    }
  }
  return [...stats]
    .filter(([dir, stat]) => {
      if (stat.zoned > 0) return false
      const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : undefined
      return parent === undefined || (stats.get(parent)?.zoned ?? 0) > 0
    })
    .map(([dir]) => dir)
    .toSorted(byText)
}

/** `a/b/c.ts` → [`a`, `a/b`]. */
function parentDirs(path: string): string[] {
  const segments = path.split('/').slice(0, -1)
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}
