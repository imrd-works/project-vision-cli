import type { ChangedFile } from './commit-check.js'
import { personOf } from './identity.js'
import type { Person } from './sync.js'
import { ancestorsOf } from './zone-id.js'

/**
 * Who may change what. The owner of a zone (and their proxies) changes its logic; anyone fixes
 * texts, comments and formatting; using a component as it is touches none of its files. Someone
 * else changes the logic of a zone only under a grant of its owner or of the project's owner.
 * @see docs/beacon-format.md#ownership
 */

export type EditKind = 'cosmetic' | 'logic'

/** The owner record of a zone as the server keeps it (`repository:zone`). */
export interface ZoneOwnerRecord {
  zone: string
  owner: string | null
  proxies: readonly string[]
}

/** A permission to change a zone's logic, given to one person — for a while or for good. */
export interface Grant {
  /** Zone ID within the repository. */
  zone: string
  grantee: string
  /** Last day it is valid, inclusive; undefined — permanent. */
  until?: string | undefined
  grantedBy?: string | undefined
  reason?: string | undefined
}

export type Permission =
  | { allowed: true; via: 'free' | 'owner' | 'proxy'; owner?: ZoneOwnerRecord }
  | { allowed: true; via: 'grant'; owner: ZoneOwnerRecord; grant: Grant }
  | { allowed: false; owner: ZoneOwnerRecord }

/** Texts, docs, translations and styles: changing them never touches a zone's logic. */
const TEXT_FILE =
  /(?:\.(?:md|mdx|markdown|txt|rst|adoc|po|css|scss|sass|less)$|(?:^|\/)(?:locales?|i18n|translations)\/)/i
const C_LIKE =
  /\.(?:[cm]?[jt]sx?|java|kt|kts|scala|c|cc|cpp|h|hpp|cs|go|rs|swift|dart|php|vue|svelte)$/i
const HASH_COMMENTS = /\.(?:py|rb|sh|bash|zsh|ya?ml|toml|tf|r)$/i

/** A change is cosmetic when only comments, string texts and whitespace differ. */
export function editKind(file: ChangedFile): EditKind {
  const path = file.newPath ?? file.oldPath ?? ''
  if (TEXT_FILE.test(path)) return 'cosmetic'
  if (file.oldText === undefined || file.newText === undefined) return 'logic'
  return skeleton(file.oldText, path) === skeleton(file.newText, path) ? 'cosmetic' : 'logic'
}

/**
 * The code with comments dropped, string contents emptied and whitespace collapsed. Template
 * literals keep their `${…}` expressions: those are code.
 */
export function skeleton(text: string, path: string): string {
  const style = C_LIKE.test(path) ? 'c' : HASH_COMMENTS.test(path) ? 'hash' : 'plain'
  const stripped = style === 'plain' ? text : stripCode(text, style)
  return stripped.replaceAll(/\s+/g, ' ').trim()
}

function stripCode(text: string, style: 'c' | 'hash'): string {
  return new Scanner(text, style).run()
}

/** Walks code once: comments are dropped, strings emptied, everything else kept. */
class Scanner {
  private out = ''
  private index = 0
  /** Open template literals: the brace depth of the `${…}` each is in, 0 — in its text. */
  private readonly templates: number[] = []

  constructor(
    private readonly text: string,
    private readonly style: 'c' | 'hash'
  ) {}

  run(): string {
    while (this.index < this.text.length) this.step()
    return this.out
  }

  private step(): void {
    if (this.templates.at(-1) === 0) {
      this.templateText()
      return
    }
    if (this.comment()) return
    const char = this.text[this.index] ?? ''
    if (char === '"' || char === "'") {
      this.out += `${char}${char}`
      this.index = skipString(this.text, this.index + 1, char)
    } else if (char === '`' && this.style === 'c') {
      this.out += '`'
      this.templates.push(0)
      this.index++
    } else {
      this.code(char)
    }
  }

  private comment(): boolean {
    const pair = this.text.slice(this.index, this.index + 2)
    const line = this.style === 'c' ? pair === '//' : this.text[this.index] === '#'
    if (line) {
      const end = this.text.indexOf('\n', this.index)
      this.index = end === -1 ? this.text.length : end
      return true
    }
    if (this.style === 'c' && pair === '/*') {
      const end = this.text.indexOf('*/', this.index + 2)
      this.index = end === -1 ? this.text.length : end + 2
      return true
    }
    return false
  }

  private code(char: string): void {
    const top = this.templates.length - 1
    if (top >= 0 && char === '{') this.templates[top] = (this.templates[top] ?? 0) + 1
    if (top >= 0 && char === '}') this.templates[top] = (this.templates[top] ?? 1) - 1
    this.out += char
    this.index++
  }

  /** A template literal's text: up to `${` (code again) or the closing backtick. */
  private templateText(): void {
    const char = this.text[this.index]
    if (char === '\\') {
      this.index += 2
    } else if (char === '`') {
      this.out += '`'
      this.templates.pop()
      this.index++
    } else if (char === '$' && this.text[this.index + 1] === '{') {
      this.out += '${'
      this.templates[this.templates.length - 1] = 1
      this.index += 2
    } else {
      this.index++
    }
  }
}

function skipString(text: string, start: number, quote: string): number {
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') index += 2
    else if (char === quote || char === '\n') return index + 1
    else index++
  }
  return index
}

/**
 * The owner record that governs a zone: its own, else the nearest ancestor's — an owner of
 * `auth` answers for `auth.passwords` until someone else is assigned there.
 */
export function governingOwner(
  owners: ReadonlyMap<string, ZoneOwnerRecord>,
  zone: string
): ZoneOwnerRecord | undefined {
  return [zone, ...ancestorsOf(zone)]
    .map((id) => owners.get(id))
    .find((record) => record?.owner !== undefined && record.owner !== null)
}

/** May this person change the logic of a zone today? */
export function permission(input: {
  zone: string
  owners: ReadonlyMap<string, ZoneOwnerRecord>
  grants: readonly Grant[]
  person: Person | undefined
  today: string
}): Permission {
  const owner = governingOwner(input.owners, input.zone)
  if (!owner) return { allowed: true, via: 'free' }
  const { person } = input
  const isMine = (email: string | null): boolean =>
    email !== null && person !== undefined && personOf([person], email) !== undefined
  if (isMine(owner.owner)) return { allowed: true, via: 'owner', owner }
  if (owner.proxies.some((email) => isMine(email))) return { allowed: true, via: 'proxy', owner }
  const grant = input.grants.find(
    (candidate) =>
      (candidate.zone === input.zone || candidate.zone === owner.zone) &&
      isMine(candidate.grantee) &&
      (candidate.until === undefined || candidate.until >= input.today)
  )
  return grant ? { allowed: true, via: 'grant', owner, grant } : { allowed: false, owner }
}

/** A zone whose logic the change touches without a right to. */
export interface ForeignChange {
  zone: string
  owner: ZoneOwnerRecord
  files: string[]
}

export interface OwnershipCheck {
  denied: ForeignChange[]
  /** Grants the change relies on: recorded in the commit message. */
  grants: Grant[]
}

/** Every zone whose logic the files change, against the author's rights. */
export function checkOwnership(input: {
  files: readonly { file: ChangedFile; zones: readonly string[] }[]
  owners: ReadonlyMap<string, ZoneOwnerRecord>
  grants: readonly Grant[]
  person: Person | undefined
  today: string
}): OwnershipCheck {
  const denied = new Map<string, ForeignChange>()
  const grants = new Map<string, Grant>()
  const logic = input.files.filter(({ file }) => editKind(file) === 'logic')
  for (const { file, zones } of logic) {
    for (const zone of zones) {
      const right = permission({ ...input, zone })
      if (right.allowed && right.via === 'grant') {
        grants.set(`${right.grant.zone}/${right.grant.grantee}`, right.grant)
      } else if (!right.allowed) {
        addDenied(denied, { zone, owner: right.owner, path: file.newPath ?? file.oldPath ?? '' })
      }
    }
  }
  return {
    denied: [...denied.values()].toSorted((a, b) => a.zone.localeCompare(b.zone)),
    grants: [...grants.values()],
  }
}

function addDenied(
  denied: Map<string, ForeignChange>,
  { zone, owner, path }: { zone: string; owner: ZoneOwnerRecord; path: string }
): void {
  const entry = denied.get(zone) ?? { zone, owner, files: [] }
  if (!entry.files.includes(path)) entry.files.push(path)
  denied.set(zone, entry)
}

/** `Beacon-Grant: auth by ann@x.io until 2026-10-12` — the permission beacon of a commit. */
export function grantTrailer(grant: Grant): string {
  const by = grant.grantedBy === undefined ? '' : ` by ${grant.grantedBy}`
  return `Beacon-Grant: ${grant.zone} for ${grant.grantee}${by}${grant.until === undefined ? '' : ` until ${grant.until}`}`
}
