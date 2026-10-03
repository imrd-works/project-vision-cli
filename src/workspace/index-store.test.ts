import { describe, expect, it } from 'vitest'

import { type CachedFile, IndexStore } from './index-store.js'

const markup = { fileBeacons: [{ id: 'auth', line: 1 }], regions: [], problems: [] }

describe('IndexStore', () => {
  it('round-trips cached files and drops paths that are gone', () => {
    const store = IndexStore.inMemory()
    const now = 1_000_000
    store.sync(
      new Map<string, CachedFile>([
        ['a.ts', { size: 10, mtimeMs: 1000, markup }],
        ['logo.png', { size: 99, mtimeMs: 1000, markup: null }],
      ]),
      now
    )
    expect(store.all()).toEqual(
      new Map([
        ['a.ts', { size: 10, mtimeMs: 1000, markup }],
        ['logo.png', { size: 99, mtimeMs: 1000, markup: null }],
      ])
    )
    store.sync(new Map([['a.ts', { size: 10, mtimeMs: 1000, markup }]]), now)
    expect([...store.all().keys()]).toEqual(['a.ts'])
    store.close()
  })

  it('does not trust the mtime of files changed during the scan', () => {
    const store = IndexStore.inMemory()
    store.sync(new Map([['a.ts', { size: 1, mtimeMs: 5000, markup: null }]]), 5500)
    expect(store.all().get('a.ts')?.mtimeMs).toBe(-1)
    store.close()
  })
})
