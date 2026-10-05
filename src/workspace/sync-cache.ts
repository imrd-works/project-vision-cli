import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { bundleSchema, type ChangedBundle, type Operation } from '../core/sync.js'

import { gitPath } from './git.js'

/**
 * What `beacon sync` keeps for offline work, in `.git/beacon/sync.json` (never committed): the
 * last state of the server's project and the changes waiting to be sent.
 */

const CACHE_GIT_PATH = 'beacon/sync.json'

const operationSchema = z.object({
  id: z.string(),
  kind: z.string(),
  key: z.string(),
  data: z.unknown(),
  baseVersion: z.number(),
  at: z.string(),
})

const cacheSchema = z.object({
  format: z.literal(1),
  server: z.string(),
  project: z.string(),
  syncedAt: z.string().optional(),
  user: z.string().optional(),
  bundle: bundleSchema.optional(),
  outbox: z.array(operationSchema),
})

export interface SyncCache {
  format: 1
  server: string
  project: string
  syncedAt?: string
  /** Whose state the bundle is (roles, todo) and whose changes wait in the outbox. */
  user?: string
  bundle?: ChangedBundle
  outbox: Operation[]
}

/** The cache of this server and project; a fresh one when the repository moved to another. */
export function readCache(root: string, target: { server: string; project: string }): SyncCache {
  const empty: SyncCache = { format: 1, ...target, outbox: [] }
  const file = gitPath(root, CACHE_GIT_PATH)
  if (!existsSync(file)) return empty
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (!parsed.success) return empty
    const cache = parsed.data as SyncCache
    return cache.server === target.server && cache.project === target.project ? cache : empty
  } catch {
    return empty
  }
}

/**
 * The cache as the syncing person's: another person's state (their role, their todo) is dropped
 * to be taken whole. Changes another person made offline go under their own name only: then
 * their author is returned instead.
 */
export function ownCache(
  cache: SyncCache,
  email: string
): { cache: SyncCache } | { author: string; waiting: number } {
  const user = email.toLowerCase()
  if (cache.user === undefined || cache.user === user) return { cache: { ...cache, user } }
  if (cache.outbox.length > 0) return { author: cache.user, waiting: cache.outbox.length }
  const { bundle: _bundle, ...rest } = cache
  return { cache: { ...rest, user } }
}

export function writeCache(root: string, cache: SyncCache): void {
  const file = gitPath(root, CACHE_GIT_PATH)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`)
}
