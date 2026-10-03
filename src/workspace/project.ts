import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { ChangedFile } from '../core/commit-check.js'
import { parseCommitBeacons } from '../core/commit-message.js'
import { buildFileChanges } from '../core/diff.js'
import { MANIFEST_PATH, type Manifest, parseManifest, resolveZoneId } from '../core/manifest.js'
import { parseMarkup } from '../core/markup.js'
import type { Problem } from '../core/problem.js'
import { buildIndex, type ProjectIndex, type ScannedFile } from '../core/project-index.js'
import { createZoneResolver, type ZoneResolver } from '../core/zone-resolver.js'

import {
  commitDiff,
  completionMessages,
  isBinary,
  listFiles,
  readRevision,
  stagedDiff,
} from './git.js'

export interface Project {
  root: string
  manifest: Manifest
  resolver: ZoneResolver
}

export type ProjectLoad =
  { kind: 'ok'; project: Project } | { kind: 'missing' } | { kind: 'invalid'; problems: Problem[] }

/** Where to read the zone map from: the working tree, the git index, or a commit. */
export type ManifestSource =
  { from: 'worktree' } | { from: 'index' } | { from: 'commit'; sha: string }

export const INDEX_CACHE_PATH = '.beacons/.cache/index.json'

/** Files above this size are not scanned for beacons (generated bundles, dumps). */
const MAX_SCAN_BYTES = 1024 * 1024

export function loadProject(root: string, source?: ManifestSource): ProjectLoad {
  const text = manifestText(root, source ?? { from: 'worktree' })
  if (text === undefined) return { kind: 'missing' }
  const parsed = parseManifest(text)
  if (!parsed.ok) return { kind: 'invalid', problems: parsed.problems }
  return {
    kind: 'ok',
    project: { root, manifest: parsed.manifest, resolver: createZoneResolver(parsed.manifest) },
  }
}

function manifestText(root: string, source: ManifestSource): string | undefined {
  switch (source.from) {
    case 'worktree': {
      const file = path.join(root, MANIFEST_PATH)
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined
    }
    case 'index': {
      // A zone map that is not staged yet still applies to the commit being made.
      return readRevision(root, '', MANIFEST_PATH) ?? manifestText(root, { from: 'worktree' })
    }
    case 'commit': {
      return readRevision(root, source.sha, MANIFEST_PATH)
    }
  }
}

/** Reads every non-ignored file, builds the index and caches it in `.beacons/.cache`. */
export function scanProject(project: Project): ProjectIndex {
  const scanned = listFiles(project.root).flatMap((file): ScannedFile[] => {
    const absolute = path.join(project.root, file)
    if (!existsSync(absolute)) return [] // deleted in the working tree, not committed yet
    const pathZone = project.resolver(file)
    const text = readText(absolute)
    return [
      text === undefined
        ? { path: file, pathZone }
        : { path: file, pathZone, markup: parseMarkup(text, file) },
    ]
  })
  const index = buildIndex(project.manifest, scanned, completedZones(project))
  writeCache(project.root, index)
  return index
}

/** Staged changes with both versions of each file. */
export function stagedChanges(root: string): ChangedFile[] {
  const { nameStatus, patch } = stagedDiff(root)
  return withTexts(root, buildFileChanges(nameStatus, patch), 'HEAD', '')
}

/** Changes of one commit with both versions of each file. */
export function commitChanges(root: string, sha: string): ChangedFile[] {
  const { nameStatus, patch } = commitDiff(root, sha)
  return withTexts(root, buildFileChanges(nameStatus, patch), `${sha}^`, sha)
}

function withTexts(
  root: string,
  changes: ChangedFile[],
  oldRevision: string,
  newRevision: string
): ChangedFile[] {
  return changes.map((change) => ({
    ...change,
    oldText:
      change.oldPath === undefined ? undefined : readRevision(root, oldRevision, change.oldPath),
    newText:
      change.newPath === undefined ? undefined : readRevision(root, newRevision, change.newPath),
  }))
}

function completedZones(project: Project): Set<string> {
  const zones = new Set<string>()
  for (const message of completionMessages(project.root)) {
    for (const beacon of parseCommitBeacons(message).beacons) {
      const zone = beacon.completed ? resolveZoneId(project.manifest, beacon.id) : undefined
      if (zone !== undefined) zones.add(zone)
    }
  }
  return zones
}

function readText(file: string): string | undefined {
  try {
    if (statSync(file).size > MAX_SCAN_BYTES) return undefined
    const content = readFileSync(file)
    return isBinary(content) ? undefined : content.toString('utf8')
  } catch {
    return undefined // unreadable (permissions, a socket): nothing to scan
  }
}

/** Keeps the index cache out of git: `.beacons/.gitignore` with `.cache/`. */
export function ensureCacheIgnored(root: string): void {
  const file = path.join(root, '.beacons/.gitignore')
  if (existsSync(file)) return
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '.cache/\n')
}

function writeCache(root: string, index: ProjectIndex): void {
  const file = path.join(root, INDEX_CACHE_PATH)
  try {
    ensureCacheIgnored(root)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`)
  } catch {
    // The cache is an optimization for other tools; failing to write it is not an error.
  }
}
