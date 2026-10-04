import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import type { SigningSetup, TeamPeople } from '../core/identity.js'

import { configValue, git, gitPath, tryGit } from './git.js'
import { readCache } from './sync-cache.js'

/**
 * The machine's side of identity checks: how git signs commits here, the team's allowed signers
 * kept next to the sync cache, and git's verdict on the signatures of made commits.
 */

const ALLOWED_SIGNERS_GIT_PATH = 'beacon/allowed_signers'

/** `.git/beacon/allowed_signers`: git's `gpg.ssh.allowedSignersFile` for this project. */
export function allowedSignersPath(root: string): string {
  return gitPath(root, ALLOWED_SIGNERS_GIT_PATH)
}

export function writeAllowedSigners(root: string, text: string): string {
  const file = allowedSignersPath(root)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

/** The people and signers of the last sync of this repository's project. */
export function teamPeople(
  root: string,
  target: { server: string; project: string }
): TeamPeople | undefined {
  const cache = readCache(root, target)
  const people = cache.bundle?.people
  const signers = cache.bundle?.signers
  if (people === undefined || signers === undefined) return undefined
  return { people, signers, syncedAt: cache.syncedAt }
}

export function signingSetup(root: string): SigningSetup {
  const key = configValue(root, 'user.signingkey')
  return {
    enabled: configValue(root, 'commit.gpgsign') === 'true',
    format: configValue(root, 'gpg.format'),
    key: key === undefined ? undefined : publicKeyOf(key),
  }
}

/**
 * The public key behind `user.signingkey`: a literal (`key::ssh-…` or `ssh-…`), a `.pub` file, or
 * a private key file with its `.pub` beside it.
 */
export function publicKeyOf(value: string): string | undefined {
  const literal = value.replace(/^key::/, '')
  if (/^(?:ssh-|ecdsa-|sk-)/.test(literal)) return literal.trim()
  const file = expandHome(value)
  const publicFile = `${file.replace(/\.pub$/, '')}.pub`
  if (!existsSync(publicFile)) return undefined
  return readFileSync(publicFile, 'utf8').trim() || undefined
}

/** The key to sign with: the one given, else the usual keys of `~/.ssh`. */
export function findSigningKey(explicit: string | undefined, cwd: string): string | undefined {
  if (explicit !== undefined) return path.resolve(cwd, expandHome(explicit))
  const ssh = path.join(homedir(), '.ssh')
  return ['id_ed25519', 'id_ecdsa', 'id_rsa']
    .map((name) => path.join(ssh, `${name}.pub`))
    .find((file) => existsSync(file))
}

/**
 * Signs this repository's commits with an SSH key: git takes the private key when it lies next
 * to the `.pub` (else ssh-agent holds it), and verifies against the team's allowed signers.
 */
export function configureSigning(root: string, keyFile: string): void {
  const privateKey = keyFile.replace(/\.pub$/, '')
  const signingKey = keyFile.endsWith('.pub') && existsSync(privateKey) ? privateKey : keyFile
  git(root, ['config', 'gpg.format', 'ssh'])
  git(root, ['config', 'user.signingkey', signingKey])
  git(root, ['config', 'commit.gpgsign', 'true'])
  git(root, ['config', 'gpg.ssh.allowedSignersFile', allowedSignersPath(root)])
}

/** Git's verdict on each commit's signature against the allowed signers (`%G?`, `%GS`). */
export function commitSignatures(
  root: string,
  shas: readonly string[],
  allowedSigners: string
): { sha: string; email: string; status: string; signer: string }[] {
  if (shas.length === 0) return []
  const file = writeAllowedSigners(root, allowedSigners)
  const output =
    tryGit(root, [
      '-c',
      `gpg.ssh.allowedSignersFile=${file}`,
      'log',
      '--no-walk=unsorted',
      '--format=%H%x1f%ae%x1f%G?%x1f%GS%x1e',
      ...shas,
    ]) ?? ''
  return output
    .split('\u{1E}')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha = '', email = '', status = 'N', signer = ''] = entry.split('\u{1F}', 4)
      return { sha, email: email.toLowerCase(), status, signer }
    })
}

function expandHome(file: string): string {
  return file === '~' || file.startsWith('~/') ? path.join(homedir(), file.slice(1)) : file
}
