import { keyHolder, personOf, type SigningSetup, type TeamPeople } from '../core/identity.js'
import { describePlan } from '../core/plan.js'
import type { Person, ZoneOwner } from '../core/sync.js'
import { type Credential, loadCredential } from '../workspace/credentials.js'
import { authorEmail } from '../workspace/git.js'
import {
  configureSigning,
  findSigningKey,
  signingSetup,
  teamPeople,
  writeAllowedSigners,
} from '../workspace/identity.js'
import { loadConfig } from '../workspace/project.js'
import { readCache, type SyncCache } from '../workspace/sync-cache.js'

import { type CommandResult, EXIT, result } from './result.js'
import { header, notSynced, type Target } from './sync.js'

/** The people of the project as of the last sync: who I am here, who owns the zones, signing. */

/** `beacon whoami`: my account, the author of commits here, linked accounts, signing, my zones. */
export function whoami(root: string, target: Target, configDir: string): CommandResult {
  const credential = loadCredential(configDir, target.server)
  if (!credential) return notLoggedIn(target)
  const cache = readCache(root, target)
  const team = teamPeople(root, target)
  if (!cache.bundle || !team) return notSynced()
  const me = personOf(team.people, credential.user.email)
  const author = authorEmail(root)
  const signing = signingSetup(root)
  const mine = (cache.bundle.owners ?? []).filter((zone) => isMine(zone, me))
  const lines = [
    header(cache),
    youLine(cache, credential, me),
    authorLine(author, me),
    ...accountLines(me),
    signingLine(signing, team, me),
    zonesLine(mine, me),
    ...(cache.bundle.plan ? [`• ${describePlan(cache.bundle.plan)}`] : []),
    ...contactLines(me),
    `• Проверка автора в хуках: ${identityCheck(root)}`,
  ]
  return result(EXIT.ok, lines, {
    user: credential.user,
    person: me ?? null,
    author: author ?? null,
    signing: { ...signing, linked: ownsKey(team, me, signing.key) },
    zones: mine.map((zone) => zone.ref),
  })
}

/** `beacon owners [зона]`: owners and proxies of the zones, by name. */
export function owners(root: string, target: Target, zone: string | undefined): CommandResult {
  const cache = readCache(root, target)
  if (!cache.bundle) return notSynced()
  const people = cache.bundle.people ?? []
  const zones = (cache.bundle.owners ?? []).filter(
    (entry) => zone === undefined || entry.ref === zone || entry.zone === zone
  )
  if (zone !== undefined && zones.length === 0) {
    return result(EXIT.failed, [header(cache), `✖ Зона ${zone} не найдена`], { zones })
  }
  if (zones.length === 0) return result(EXIT.ok, [header(cache), '• В проекте нет зон'], { zones })
  const width = Math.max(...zones.map((entry) => entry.ref.length))
  const lines = zones.map((entry) => {
    const owner = entry.owner === null ? 'не назначен' : nameOf(people, entry.owner)
    const proxies = entry.proxies.map((email) => nameOf(people, email)).join(', ')
    return `${entry.ref.padEnd(width)}  ${owner}${proxies === '' ? '' : `; доверенные: ${proxies}`}`
  })
  return result(EXIT.ok, [header(cache), ...lines], { zones })
}

/** `beacon signing setup [--key файл]`: sign commits here with an SSH key of your git account. */
export function setupSigning(
  root: string,
  target: Target | undefined,
  options: { key: string | undefined; cwd: string; configDir: string }
): CommandResult {
  const keyFile = findSigningKey(options.key, options.cwd)
  if (keyFile === undefined) {
    return result(
      EXIT.failed,
      [
        '✖ SSH-ключ не найден в ~/.ssh. Создайте: ssh-keygen -t ed25519',
        '  или укажите: beacon signing setup --key <файл .pub>',
      ],
      { error: 'no-key' }
    )
  }
  configureSigning(root, keyFile)
  const key = signingSetup(root).key
  if (key === undefined) {
    return result(EXIT.failed, [`✖ Не читается публичный ключ ${keyFile}`], { error: 'bad-key' })
  }
  const team = target && teamPeople(root, target)
  if (team) writeAllowedSigners(root, team.signers.allowedSigners)
  const email = target && loadCredential(options.configDir, target.server)?.user.email
  const me = team && email !== undefined ? personOf(team.people, email) : undefined
  const linked = team !== undefined && ownsKey(team, me, key)
  return result(
    EXIT.ok,
    [`✓ Коммиты этого репозитория подписываются ключом ${keyFile}`, keyLine(team, key, linked)],
    { key: keyFile, linked }
  )
}

function keyLine(team: TeamPeople | undefined, key: string, linked: boolean): string {
  if (linked) return '✓ Ключ привязан к вашему git-аккаунту — подпись подтверждает, что коммит ваш'
  const holder = team && keyHolder(team.signers, key)
  if (holder) return `⚠ Это ключ ${holder.name}, а не ваш`
  return [
    '⚠ Сервер команды не знает этот ключ. Добавьте его на GitHub или GitLab как ключ подписи',
    '  (Settings → SSH and GPG keys → New SSH key, тип Signing Key), обновите ключи в профиле',
    '  дашборда и выполните beacon sync. Ключ:',
    `  ${key}`,
  ].join('\n')
}

/** The key belongs to one of my linked git accounts. */
function ownsKey(team: TeamPeople, me: Person | undefined, key: string | undefined): boolean {
  if (me === undefined || key === undefined) return false
  return keyHolder(team.signers, key)?.emails.some((email) => isMe(me, email)) ?? false
}

function isMe(me: Person | undefined, email: string | null): boolean {
  return me !== undefined && email !== null && personOf([me], email) !== undefined
}

function isMine(zone: ZoneOwner, me: Person | undefined): boolean {
  return [zone.owner, ...zone.proxies].some((email) => isMe(me, email))
}

function youLine(cache: SyncCache, credential: Credential, me: Person | undefined): string {
  const role = cache.bundle?.project?.role === 'owner' ? ', владелец проекта' : ''
  return `Вы: ${me?.name ?? credential.user.name} <${credential.user.email}>${role}`
}

function authorLine(author: string | undefined, me: Person | undefined): string {
  if (author === undefined) return '✖ Почта автора коммитов не задана: git config user.email'
  return isMe(me, author)
    ? `✓ Коммиты здесь — от вашего имени: ${author}`
    : `⚠ Коммиты здесь — от ${author}: это не ваша почта (git config user.email)`
}

function signingLine(signing: SigningSetup, team: TeamPeople, me: Person | undefined): string {
  if (!signing.enabled || signing.format !== 'ssh') {
    return '⚠ Коммиты не подписываются — beacon signing setup'
  }
  return ownsKey(team, me, signing.key)
    ? '✓ Коммиты подписываются ключом вашего git-аккаунта'
    : '⚠ Ключ подписи не привязан к вашему git-аккаунту — beacon signing setup'
}

function zonesLine(mine: readonly ZoneOwner[], me: Person | undefined): string {
  if (mine.length === 0) return '• Зон за вами нет'
  const zones = mine.map((zone) => `${zone.ref}${isMe(me, zone.owner) ? '' : ' (доверенное лицо)'}`)
  return `• Зоны: ${zones.join(', ')}`
}

function nameOf(people: readonly Person[], email: string): string {
  const person = personOf(people, email)
  return person ? `${person.name} <${email}>` : email
}

function accountLines(me: Person | undefined): string[] {
  if (!me || me.identities.length === 0) {
    return ['⚠ Git-аккаунт не привязан — привяжите GitHub или GitLab в профиле дашборда']
  }
  return me.identities.map(
    (identity) =>
      `✓ ${identity.provider}: ${identity.login}, ключей подписи: ${String(identity.signingKeys)}`
  )
}

function contactLines(me: Person | undefined): string[] {
  const contacts = me?.contacts
  const filled = [
    contacts?.telegram && `telegram ${contacts.telegram}`,
    contacts?.phone && `телефон ${contacts.phone}`,
    contacts?.email && `почта ${contacts.email}`,
  ].filter(Boolean)
  if (filled.length === 0) {
    return ['⚠ Контакты не заполнены — команде не связаться с вами (профиль в дашборде)']
  }
  return [`• Контакты: ${filled.join(' · ')}`]
}

const CHECK_NAMES = { signature: 'подпись', email: 'почта', off: 'выключена' } as const

function identityCheck(root: string): string {
  const config = loadConfig(root)
  if (!config.ok) return '—'
  const policy = config.config.identity
  if (policy.check === 'off') return CHECK_NAMES.off
  const stale = policy.whenStale === 'hold' ? 'блокируют коммит' : 'только предупреждают'
  return `${CHECK_NAMES[policy.check]}; данные старше ${String(policy.staleDays)} дн. ${stale}`
}

function notLoggedIn(target: Target): CommandResult {
  return result(EXIT.failed, [`✖ Вы не вошли на ${target.server}: beacon login ${target.server}`], {
    error: 'not-logged-in',
  })
}
