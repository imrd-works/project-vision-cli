import { describe, expect, it } from 'vitest'

import type { IdentityPolicy } from './config.js'
import {
  type AuthorInput,
  checkAuthor,
  commitVerdict,
  keyHolder,
  keyId,
  personOf,
  staleness,
  verdictPasses,
} from './identity.js'
import type { Person, Signers } from './sync.js'

const ANN_KEY = 'ssh-ed25519 AAAAannkey ann@laptop'
const BOB_KEY = 'ssh-ed25519 AAAAbobkey'

function person(name: string, emails: string[]): Person {
  return {
    userId: name,
    name,
    role: 'member',
    emails,
    contacts: { telegram: null, phone: null, email: null },
    identities: [],
  }
}

const people = [person('Ann Lee', ['ann@x.io', 'ann@work.io']), person('Bob Kim', ['bob@x.io'])]
const signers: Signers = {
  signers: [
    { name: 'Ann Lee', emails: ['ann@x.io', 'ann@work.io'], keys: [ANN_KEY] },
    { name: 'Bob Kim', emails: ['bob@x.io'], keys: [BOB_KEY] },
  ],
  allowedSigners: '',
}
const NOW = new Date('2026-10-04T12:00:00Z')
const policy = (overrides: Partial<IdentityPolicy> = {}): IdentityPolicy => ({
  check: 'email',
  staleDays: 7,
  whenStale: 'allow',
  ...overrides,
})

function input(overrides: Partial<AuthorInput> = {}): AuthorInput {
  return {
    policy: policy(),
    team: { people, signers, syncedAt: '2026-10-03T12:00:00Z' },
    author: 'ann@work.io',
    signing: { enabled: true, format: 'ssh', key: 'ssh-ed25519 AAAAannkey' },
    now: NOW,
    ...overrides,
  }
}

describe('people and keys', () => {
  it('finds a person by any of their emails, ignoring case', () => {
    expect(personOf(people, 'ANN@Work.io')?.name).toBe('Ann Lee')
    expect(personOf(people, 'eve@x.io')).toBeUndefined()
  })

  it('compares keys without their comments', () => {
    expect(keyId(ANN_KEY)).toBe('ssh-ed25519 AAAAannkey')
    expect(keyHolder(signers, 'ssh-ed25519 AAAAannkey other')?.name).toBe('Ann Lee')
    expect(keyHolder(signers, 'ssh-ed25519 AAAAnobody')).toBeUndefined()
  })

  it('counts whole days since the last sync', () => {
    expect(staleness('2026-09-30T13:00:00Z', NOW)).toBe(3)
    expect(staleness(undefined, NOW)).toBeUndefined()
  })
})

describe('checkAuthor', () => {
  it('passes a person of the project, and with a signature check their own key', () => {
    expect(checkAuthor(input())).toEqual({ errors: [], warnings: [] })
    expect(checkAuthor(input({ policy: policy({ check: 'signature' }) }))).toEqual({
      errors: [],
      warnings: [],
    })
    expect(checkAuthor(input({ policy: policy({ check: 'off' }), team: undefined }))).toEqual({
      errors: [],
      warnings: [],
    })
  })

  it('rejects an author who is not a person of the project', () => {
    expect(checkAuthor(input({ author: 'eve@x.io' })).errors).toEqual([
      expect.stringContaining('eve@x.io — не почта участника проекта') as string,
    ])
    expect(checkAuthor(input({ author: undefined })).errors).toEqual([
      'не задана почта автора: git config user.email',
    ])
  })

  it('wants signing with the author’s own linked key', () => {
    const signature = policy({ check: 'signature' })
    const unsigned = { enabled: false, format: undefined, key: undefined }
    expect(checkAuthor(input({ policy: signature, signing: unsigned })).errors).toEqual([
      'коммиты не подписываются SSH-ключом — beacon signing setup',
    ])
    expect(
      checkAuthor(
        input({ policy: signature, signing: { ...unsigned, enabled: true, format: 'ssh' } })
      ).errors
    ).toEqual([expect.stringContaining('не читается ключ') as string])
    expect(
      checkAuthor(
        input({
          policy: signature,
          signing: { enabled: true, format: 'ssh', key: 'ssh-ed25519 X' },
        })
      ).errors
    ).toEqual([expect.stringContaining('не привязан к вашему git-аккаунту') as string])
    expect(
      checkAuthor(
        input({ policy: signature, signing: { enabled: true, format: 'ssh', key: BOB_KEY } })
      ).errors
    ).toEqual(['ключ подписи принадлежит Bob Kim, а коммит — от имени Ann Lee'])
  })

  it('warns when the author is not the one logged in', () => {
    expect(checkAuthor(input({ loggedIn: 'bob@x.io' })).warnings).toEqual([
      'вы вошли как bob@x.io, а коммит — от имени Ann Lee',
    ])
    expect(checkAuthor(input({ loggedIn: 'ann@x.io' })).warnings).toEqual([])
  })

  it('holds or lets through commits on stale or missing data', () => {
    const old = { people, signers, syncedAt: '2026-09-01T12:00:00Z' }
    expect(checkAuthor(input({ team: old }))).toEqual({
      errors: [],
      warnings: ['данные о людях проекта устарели (33 дн.) — выполните beacon sync'],
    })
    expect(checkAuthor(input({ team: old, author: 'eve@x.io' })).errors).toHaveLength(1)
    expect(checkAuthor(input({ team: old, policy: policy({ whenStale: 'hold' }) }))).toEqual({
      errors: ['данные о людях проекта устарели (33 дн.) — выполните beacon sync'],
      warnings: [],
    })
    expect(checkAuthor(input({ team: undefined }))).toEqual({
      errors: [],
      warnings: ['нет данных о людях проекта — выполните beacon sync'],
    })
    expect(checkAuthor(input({ team: { people, signers, syncedAt: undefined } })).warnings).toEqual(
      ['данные о людях проекта устарели — выполните beacon sync']
    )
  })
})

describe('commitVerdict', () => {
  it('verifies a signature only by a key of the author’s own person', () => {
    const verdict = (email: string, status: string, signer = ''): string =>
      commitVerdict(people, { email, status, signer })
    expect(verdict('ann@work.io', 'G', 'ann@x.io')).toBe('verified')
    expect(verdict('ann@work.io', 'G', 'bob@x.io')).toBe('foreign-key')
    expect(verdict('eve@x.io', 'G', 'bob@x.io')).toBe('foreign-key')
    expect(verdict('ann@x.io', 'B')).toBe('bad')
    expect(verdict('ann@x.io', 'E')).toBe('unknown-key')
    expect(verdict('ann@x.io', 'N')).toBe('known-author')
    expect(verdict('eve@x.io', 'N')).toBe('unknown-author')
  })

  it('lets through what the policy accepts', () => {
    expect(verdictPasses(policy(), 'known-author')).toBe(true)
    expect(verdictPasses(policy(), 'unknown-key')).toBe(true)
    expect(verdictPasses(policy(), 'foreign-key')).toBe(false)
    expect(verdictPasses(policy({ check: 'signature' }), 'known-author')).toBe(false)
    expect(verdictPasses(policy({ check: 'signature' }), 'verified')).toBe(true)
    expect(verdictPasses(policy({ check: 'off' }), 'unknown-author')).toBe(true)
  })
})
