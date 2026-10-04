import { describe, expect, it } from 'vitest'

import { notesOf, type Operation, type SyncEntity, versionOf } from './sync.js'

const entity = (key: string, text: string | null, version = 1): SyncEntity => ({
  kind: 'note',
  key,
  data: text === null ? null : { text },
  version,
  updatedAt: '2026-10-04T10:00:00.000Z',
  updatedBy: { name: 'Ann', email: 'ann@x.io' },
})

const change = (key: string, text: string | null): Operation => ({
  id: key,
  kind: 'note',
  key,
  data: text === null ? null : { text },
  baseVersion: 0,
  at: '2026-10-04T11:00:00.000Z',
})

describe('notesOf', () => {
  it('shows the server notes with changes not sent yet on top', () => {
    const notes = notesOf(
      [entity('backend:auth', 'old'), entity('backend:api', 'kept'), entity('web:gone', null)],
      [change('backend:auth', 'new'), change('backend:api', null), change('web:new', 'hi')]
    )
    expect(Object.fromEntries(notes)).toEqual({
      'backend:auth': { text: 'new', pending: true },
      'web:new': { text: 'hi', pending: true },
    })
  })

  it('ignores other kinds', () => {
    const other = { ...entity('x:y', 'z'), kind: 'signature' }
    expect(notesOf([other], [{ ...change('x:y', 'z'), kind: 'signature' }]).size).toBe(0)
  })
})

describe('versionOf', () => {
  it('is the version the client saw, 0 for a new entity', () => {
    expect(versionOf([entity('backend:auth', 'x', 3)], 'note', 'backend:auth')).toBe(3)
    expect(versionOf([entity('backend:auth', 'x', 3)], 'note', 'web:home')).toBe(0)
  })
})
