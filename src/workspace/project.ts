import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import type { ChangedFile } from '../core/commit-check.js'
import { parseCommitBeacons } from '../core/commit-message.js'
import { CONFIG_PATH, type ConfigResult, parseConfig } from '../core/config.js'
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
import { type CachedFile, IndexStore } from './index-store.js'

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

/** `.beacons/config.yml` of the working tree; defaults when it does not exist. */
export function loadConfig(root: string): ConfigResult {
  const file = path.join(root, CONFIG_PATH)
  return parseConfig(existsSync(file) ? readFileSync(file, 'utf8') : undefined)
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

/**
 * Indexes every file git can see. Markup is re-parsed only for files whose size or modification
 * time changed since the last scan (cached in `.git/beacon/index.db`).
 */
export function scanProject(project: Project): ProjectIndex {
  const store = IndexStore.open(project.root)
  try {
    const cached = store.all()
    const current = new Map<string, CachedFile>()
    let dirty = false
    for (const file of listFiles(project.root)) {
      const previous = cached.get(file)
      const entry = cachedOrRead(project.root, file, previous)
      if (!entry) continue // deleted in the working tree, or not a regular file
      if (entry !== previous) dirty = true
      current.set(file, entry)
    }
    if (dirty || current.size !== cached.size) store.sync(current, Date.now())

    const scanned = [...current].map(([file, entry]): ScannedFile => ({
      path: file,
      pathZone: project.resolver(file),
      ...(entry.markup === null ? {} : { markup: entry.markup }),
    }))
    return buildIndex(project.manifest, scanned, completedZones(project))
  } finally {
    store.close()
  }
}

function cachedOrRead(
  root: string,
  file: string,
  cached: CachedFile | undefined
): CachedFile | undefined {
  const absolute = path.join(root, file)
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    return undefined
  }
  if (!stat.isFile()) return undefined // submodules, sockets
  if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached
  const text = stat.size > MAX_SCAN_BYTES ? undefined : readText(absolute)
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    markup: text === undefined ? null : parseMarkup(text, file),
  }
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
    const content = readFileSync(file)
    return isBinary(content) ? undefined : content.toString('utf8')
  } catch {
    return undefined // unreadable (permissions, a socket): nothing to scan
  }
}
