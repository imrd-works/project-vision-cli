import type { IdentityPolicy } from './config.js'
import type { Person, Signers } from './sync.js'

/**
 * Who makes a commit, against the people of the project as of the last `beacon sync`. The author
 * field of a commit is a line anyone can type; an SSH signature by a key of the author's linked
 * git account is not. `check: email` trusts the field, `check: signature` wants the key.
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

export interface IdentityCheck {
  errors: string[]
  warnings: string[]
}

export type CommitVerdict =
  'verified' | 'foreign-key' | 'unknown-key' | 'bad' | 'known-author' | 'unknown-author'

const DAY_MS = 86_400_000

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

/** Days since the last sync; undefined — never synced. */
export function staleness(syncedAt: string | undefined, now: Date): number | undefined {
  if (syncedAt === undefined) return undefined
  return Math.floor((now.getTime() - Date.parse(syncedAt)) / DAY_MS)
}

export interface AuthorInput {
  policy: IdentityPolicy
  team: TeamPeople | undefined
  author: string | undefined
  signing: SigningSetup
  /** The email `beacon login` signed in with. */
  loggedIn?: string | undefined
  now: Date
}

/** The commit about to be made: its author, and with `check: signature` the signing key. */
export function checkAuthor(input: AuthorInput): IdentityCheck {
  const check: IdentityCheck = { errors: [], warnings: [] }
  const { policy, team } = input
  if (policy.check === 'off') return check
  const fresh = freshness(policy, team, input.now)
  if (fresh !== undefined) {
    const hold = policy.whenStale === 'hold'
    ;(hold ? check.errors : check.warnings).push(fresh)
    if (hold) return check
  }
  if (team) checkPerson(input, team, check)
  return check
}

function checkPerson(input: AuthorInput, team: TeamPeople, check: IdentityCheck): void {
  if (input.author === undefined) {
    check.errors.push('не задана почта автора: git config user.email')
    return
  }
  const person = personOf(team.people, input.author)
  if (!person) {
    check.errors.push(
      `${input.author} — не почта участника проекта. Коммитьте со своей почтой (git config user.email) или привяжите git-аккаунт с ней в профиле дашборда, затем beacon sync`
    )
    return
  }
  if (input.loggedIn !== undefined && personOf(team.people, input.loggedIn) !== person) {
    check.warnings.push(`вы вошли как ${input.loggedIn}, а коммит — от имени ${person.name}`)
  }
  if (input.policy.check === 'signature') {
    check.errors.push(...signingProblems(input.signing, team, person))
  }
}

function freshness(
  policy: IdentityPolicy,
  team: TeamPeople | undefined,
  now: Date
): string | undefined {
  if (!team) return 'нет данных о людях проекта — выполните beacon sync'
  const days = staleness(team.syncedAt, now)
  if (days === undefined || days > policy.staleDays) {
    return `данные о людях проекта устарели${days === undefined ? '' : ` (${String(days)} дн.)`} — выполните beacon sync`
  }
  return undefined
}

function signingProblems(signing: SigningSetup, team: TeamPeople, person: Person): string[] {
  if (!signing.enabled || signing.format !== 'ssh') {
    return ['коммиты не подписываются SSH-ключом — beacon signing setup']
  }
  if (signing.key === undefined) {
    return ['не читается ключ user.signingkey — beacon signing setup --key <файл .pub>']
  }
  const holder = keyHolder(team.signers, signing.key)
  if (!holder) {
    return [
      'ключ подписи не привязан к вашему git-аккаунту: добавьте его на GitHub или GitLab как ключ подписи (Signing Key), обновите ключи в профиле дашборда и выполните beacon sync',
    ]
  }
  const own = holder.emails.some((email) => personOf([person], email) === person)
  return own ? [] : [`ключ подписи принадлежит ${holder.name}, а коммит — от имени ${person.name}`]
}

/**
 * A made commit by git's verdict on its signature (`%G?`, `%GS`) against the team's allowed
 * signers: verified only when the key belongs to the author's own person.
 */
export function commitVerdict(
  people: readonly Person[],
  commit: { email: string; status: string; signer: string }
): CommitVerdict {
  const author = personOf(people, commit.email)
  if (commit.status === 'G' || commit.status === 'U') {
    const principals = commit.signer.split(',').map((email) => email.trim())
    const own = author !== undefined && principals.some((email) => personOf([author], email))
    return own ? 'verified' : 'foreign-key'
  }
  if (commit.status === 'B') return 'bad'
  if (!author) return 'unknown-author'
  return commit.status === 'N' ? 'known-author' : 'unknown-key'
}

/** What a policy lets through: a signature check wants every commit verified. */
export function verdictPasses(policy: IdentityPolicy, verdict: CommitVerdict): boolean {
  if (policy.check === 'off') return true
  if (policy.check === 'signature') return verdict === 'verified'
  return verdict === 'verified' || verdict === 'known-author' || verdict === 'unknown-key'
}

export const VERDICT_TEXT: Record<CommitVerdict, string> = {
  verified: 'подписан ключом автора',
  'foreign-key': 'подписан ключом другого человека',
  'unknown-key': 'подписан ключом, не привязанным ни к одному аккаунту',
  bad: 'подпись не сходится',
  'known-author': 'не подписан',
  'unknown-author': 'автор — не участник проекта',
}
