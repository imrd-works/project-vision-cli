import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { type FileMarkup, MARKUP_VERSION } from '../core/markup.js'

import { gitPath } from './git.js'

/**
 * SQLite cache of parsed markup per file, in `.git/beacon/index.db`: never committed, never
 * seen by formatters or linters, one per worktree. A file is re-read only when its size or
 * modification time changed, so scans of large repositories stay fast.
 */

/** Bump when the table layout changes; MARKUP_VERSION covers parser changes. */
const SCHEMA_VERSION = 1
const INDEX_DB_GIT_PATH = 'beacon/index.db'

/**
 * A file modified this recently may change again within the same timestamp tick. Such files are
 * cached with an impossible mtime, so the next scan re-reads them (the "racy git" problem).
 */
const RACY_WINDOW_MS = 2000
const UNTRUSTED_MTIME = -1

export interface CachedFile {
  size: number
  mtimeMs: number
  /** Null for binary, oversized or unreadable files. */
  markup: FileMarkup | null
}

interface FileRow {
  path: string
  size: number
  mtime_ms: number
  markup: string | null
}

export class IndexStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(root: string): IndexStore {
    const file = gitPath(root, INDEX_DB_GIT_PATH)
    mkdirSync(path.dirname(file), { recursive: true })
    return IndexStore.fromDatabase(new DatabaseSync(file))
  }

  static inMemory(): IndexStore {
    return IndexStore.fromDatabase(new DatabaseSync(':memory:'))
  }

  private static fromDatabase(db: DatabaseSync): IndexStore {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const version = `${String(SCHEMA_VERSION)}.${String(MARKUP_VERSION)}`
    const stored = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
      { value: string } | undefined
    if (stored?.value !== version) {
      db.exec('DROP TABLE IF EXISTS files')
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)").run(version)
    }
    db.exec(`CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      markup TEXT
    )`)
    return new IndexStore(db)
  }

  all(): Map<string, CachedFile> {
    const rows = this.db
      .prepare('SELECT path, size, mtime_ms, markup FROM files')
      .all() as unknown as FileRow[]
    return new Map(
      rows.map((row) => [
        row.path,
        {
          size: row.size,
          mtimeMs: row.mtime_ms,
          markup: row.markup === null ? null : (JSON.parse(row.markup) as FileMarkup),
        },
      ])
    )
  }

  /** Replaces the cache with `files` in one transaction; paths not listed are dropped. */
  sync(files: ReadonlyMap<string, CachedFile>, now: number): void {
    const upsert = this.db.prepare(
      'INSERT OR REPLACE INTO files (path, size, mtime_ms, markup) VALUES (?, ?, ?, ?)'
    )
    this.db.exec('BEGIN')
    try {
      this.db.exec('DELETE FROM files')
      for (const [file, entry] of files) {
        const racy = now - entry.mtimeMs < RACY_WINDOW_MS
        upsert.run(
          file,
          entry.size,
          racy ? UNTRUSTED_MTIME : entry.mtimeMs,
          entry.markup === null ? null : JSON.stringify(entry.markup)
        )
      }
      this.db.exec('COMMIT')
    } catch (error_) {
      this.db.exec('ROLLBACK')
      throw error_
    }
  }

  close(): void {
    this.db.close()
  }
}
