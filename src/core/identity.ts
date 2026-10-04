import type { Person, Signers } from './sync.js'

/**
 * The people of the project as of the last `beacon sync` and the SSH signing keys of their linked
 * git accounts: whose email an author is, whose key signs.
 */

/** The team's side of the check: what the last `beacon sync` brought. */
export interface TeamPeople {
  people: readonly Person[]
  signers: Signers
  syncedAt: string | undefined
}

/** How this repository signs commits (git config). */
export interface SigningSetup {
  /** `commit.gpgsign`. */
  enabled: boolean
  /** `gpg.format`. */
  format: string | undefined
  /** The public key of `user.signingkey`, when it could be read. */
  key: string | undefined
}

export function personOf(people: readonly Person[], email: string): Person | undefined {
  const wanted = email.toLowerCase()
  return people.find((person) => person.emails.some((own) => own.toLowerCase() === wanted))
}

/** `ssh-ed25519 AAAA… comment` → `ssh-ed25519 AAAA…`: keys compare without their comments. */
export function keyId(key: string): string {
  const [type = '', body = ''] = key.trim().split(/\s+/, 2)
  return `${type} ${body}`
}

/** The emails of whoever's linked accounts hold this signing key. */
export function keyHolder(signers: Signers, key: string): Signers['signers'][number] | undefined {
  const id = keyId(key)
  return signers.signers.find((signer) => signer.keys.some((own) => keyId(own) === id))
}
