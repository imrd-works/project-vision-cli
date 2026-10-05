import { describe, expect, it } from 'vitest'

import type { SyncEntity } from '../core/sync.js'

import { grantsOf, sameRemote } from './ownership.js'

function entity(kind: string, key: string, data: unknown): SyncEntity {
  return {
    kind,
    key,
    data,
    version: 1,
    updatedAt: '2026-10-05T10:00:00.000Z',
    updatedBy: { name: 'Ann Lee', email: 'ann@x.io' },
  }
}

describe('team ownership', () => {
  it('knows one repository by its ssh and https addresses', () => {
    expect(sameRemote('git@github.com:org/backend.git', 'https://github.com/org/backend')).toBe(
      true
    )
    expect(
      sameRemote('ssh://git@gitlab.example.com:2222/org/app.git', 'gitlab.example.com:2222/org/app')
    ).toBe(true)
    expect(sameRemote('https://github.com/org/backend', 'https://github.com/org/web')).toBe(false)
  })

  it('reads grants of this repository only', () => {
    const entities = [
      entity('grant', 'backend:auth/eve@x.io', { until: '2026-10-12', reason: 'Fix' }),
      entity('grant', 'backend:billing/eve@x.io', { until: null, reason: '' }),
      entity('grant', 'web:ui/eve@x.io', { until: null, reason: '' }),
      entity('grant', 'backend:auth/bob@x.io', null),
      entity('note', 'backend:auth', { text: 'x' }),
    ]
    expect(grantsOf(entities, 'backend')).toEqual([
      {
        zone: 'auth',
        grantee: 'eve@x.io',
        until: '2026-10-12',
        grantedBy: 'ann@x.io',
        reason: 'Fix',
      },
      { zone: 'billing', grantee: 'eve@x.io', grantedBy: 'ann@x.io', reason: '' },
    ])
  })
})
