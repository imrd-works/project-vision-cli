import { describe, expect, it } from 'vitest'

import { keyHolder, keyId, personOf } from './identity.js'
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
})
