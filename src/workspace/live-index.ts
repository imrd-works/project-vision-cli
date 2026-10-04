import { type FSWatcher, watch } from 'node:fs'
import path from 'node:path'

import { buildHistory, type History, parseCommitLog } from '../core/history.js'
import type { Problem } from '../core/problem.js'
import type { ProjectIndex } from '../core/project-index.js'

import { commitLog, listFiles } from './git.js'
import { loadConfig, loadProject, type Project, scanProject } from './project.js'

/** What the live index currently knows. `version` grows on every real change. */
export interface Snapshot {
  version: number
  generatedAt: string
  manifest: 'ok' | 'missing' | 'invalid'
  /** Zone map problems when it is invalid; markup problems live in `index`. */
  problems: Problem[]
  index: ProjectIndex | undefined
  /** Commits by zones and development dynamics. */
  history: History | undefined
}

type Listener = (snapshot: Snapshot) => void

/** macOS and Windows watch a tree natively; Linux needs one inotify watch per folder. */
const NATIVE_RECURSIVE = process.platform === 'darwin' || process.platform === 'win32'

/**
 * Keeps the index up to date while files change: the source of `beacon watch`, the local API
 * of `beacon serve` and its live updates. Changes are debounced; only real differences in the
 * index bump the version and notify listeners.
 */
export class LiveIndex {
  private snapshot: Snapshot
  private fingerprint = ''
  private readonly listeners = new Set<Listener>()
  private readonly watchers = new Map<string, FSWatcher>()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly root: string,
    private readonly debounceMs = 150
  ) {
    this.snapshot = this.build(0)
    this.fingerprint = fingerprint(this.snapshot)
  }

  current(): Snapshot {
    return this.snapshot
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Starts watching the working tree; returns `this` for chaining. */
  start(): this {
    if (NATIVE_RECURSIVE) this.watchDir('', true)
    else this.syncDirWatchers()
    // Commits change zone states (`completed`): HEAD's reflog moves on every commit.
    this.watchDir('.git/logs', false)
    return this
  }

  stop(): void {
    clearTimeout(this.timer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.listeners.clear()
  }

  /** Rebuilds the index now; true when it changed. */
  refresh(): boolean {
    const next = this.build(this.snapshot.version + 1)
    const nextFingerprint = fingerprint(next)
    if (nextFingerprint === this.fingerprint) return false
    this.snapshot = next
    this.fingerprint = nextFingerprint
    if (!NATIVE_RECURSIVE) this.syncDirWatchers()
    for (const listener of this.listeners) listener(next)
    return true
  }

  private build(version: number): Snapshot {
    const generatedAt = new Date().toISOString()
    const load = loadProject(this.root)
    const empty = { index: undefined, history: undefined }
    if (load.kind === 'missing') {
      return { version, generatedAt, manifest: 'missing', problems: [], ...empty }
    }
    if (load.kind === 'invalid') {
      return { version, generatedAt, manifest: 'invalid', problems: load.problems, ...empty }
    }
    return {
      version,
      generatedAt,
      manifest: 'ok',
      problems: [],
      index: scanProject(load.project),
      history: projectHistory(load.project),
    }
  }

  private schedule(file: string): void {
    if (!isRelevant(file)) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.refresh(), this.debounceMs)
  }

  private watchDir(dir: string, recursive: boolean): void {
    if (this.watchers.has(dir)) return
    try {
      const watcher = watch(path.join(this.root, dir), { recursive }, (_event, name) => {
        this.schedule(path.posix.join(dir, name ?? ''))
      })
      watcher.on('error', () => {
        this.unwatch(dir)
      })
      this.watchers.set(dir, watcher)
    } catch {
      // The folder vanished between listing and watching; the next refresh resyncs.
    }
  }

  private unwatch(dir: string): void {
    this.watchers.get(dir)?.close()
    this.watchers.delete(dir)
  }

  /** One non-recursive watcher per folder that holds files git can see (plus the root). */
  private syncDirWatchers(): void {
    const dirs = new Set([''])
    for (const file of listFiles(this.root)) {
      for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir))
        dirs.add(dir)
    }
    dirs.add('.git/logs')
    for (const dir of this.watchers.keys()) if (!dirs.has(dir)) this.unwatch(dir)
    for (const dir of dirs) this.watchDir(dir, false)
  }
}

/** Our own cache writes and dependency installs must not trigger rebuilds. */
function isRelevant(file: string): boolean {
  if (file === '.git/logs/HEAD') return true
  return !file.startsWith('.git/') && file !== '.git' && !file.split('/').includes('node_modules')
}

function fingerprint(snapshot: Snapshot): string {
  return JSON.stringify([snapshot.manifest, snapshot.problems, snapshot.index, snapshot.history])
}

export function projectHistory(project: Project): History {
  const config = loadConfig(project.root)
  const gapDays = config.ok ? config.config.dynamics.gapDays : 3
  return buildHistory(parseCommitLog(commitLog(project.root)), project.manifest, {
    gapDays,
    // Local calendar date (sv-SE formats as YYYY-MM-DD).
    today: new Date().toLocaleDateString('sv-SE'),
  })
}
