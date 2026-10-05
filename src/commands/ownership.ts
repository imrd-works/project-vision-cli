import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { ChangedFile } from '../core/commit-check.js'
import { personOf } from '../core/identity.js'
import {
  checkOwnership,
  type ForeignChange,
  type Grant,
  grantTrailer,
  type Permission,
  permission,
} from '../core/ownership.js'
import type { Person } from '../core/sync.js'
import { loadCredential } from '../workspace/credentials.js'
import { authorEmail, commitSubject, git, pushedCommits } from '../workspace/git.js'
import { type TeamOwnership, teamOwnership, zonesOfFiles } from '../workspace/ownership.js'
import {
  commitChanges,
  loadConfig,
  loadProject,
  type Project,
  stagedChanges,
} from '../workspace/project.js'

import { type CommandResult, EXIT, result } from './result.js'

/**
 * Ownership at the two lines of defence: before an edit (`beacon gate`, the agent's hook, the
 * MCP tool) and at the commit (commit-msg, pre-push). Texts, comments and formatting of any zone
 * are free; the logic of someone else's zone needs its owner, a proxy or a grant.
 */

export const FREE_EDITS =
  'Без согласования можно: тексты, комментарии, форматирование; использовать компонент как есть.'

type Context =
  | { kind: 'ok'; ownership: TeamOwnership; enforce: 'block' | 'warn'; server: string }
  | { kind: 'skip' }
  | { kind: 'note'; code: number; line: string }

/** The team's ownership for this repository, or why the check is skipped or held. */
function ownershipContext(root: string): Context {
  const config = loadConfig(root)
  if (!config.ok || !config.config.server) return { kind: 'skip' }
  const { enforce } = config.config.ownership
  if (enforce === 'off') return { kind: 'skip' }
  const { url: server, project, repository } = config.config.server
  const load = teamOwnership(root, { server, project, repository })
  if (load.kind === 'not-synced') {
    const hold = config.config.identity.whenStale === 'hold'
    return {
      kind: 'note',
      code: hold ? EXIT.failed : EXIT.ok,
      line: `${hold ? '✖' : '⚠'} beacon: нет данных о владельцах зон — выполните beacon sync`,
    }
  }
  if (load.kind === 'unknown-repository') {
    return {
      kind: 'note',
      code: EXIT.ok,
      line: `⚠ beacon: не знаю, какой это репозиторий проекта — укажите server.repository в .beacons/config.yml (${load.names.join(', ') || 'репозиториев нет'})`,
    }
  }
  return { kind: 'ok', ownership: load.ownership, enforce, server }
}

/** commit-msg: the staged change against the author's rights; grants used go into the message. */
export function commitOwnership(root: string, messageFile: string | undefined): CommandResult {
  const context = ownershipContext(root)
  if (context.kind === 'skip') return result(EXIT.ok, [], { ok: true })
  if (context.kind === 'note')
    return result(context.code, [context.line], { ownership: 'unchecked' })
  const load = loadProject(root, { from: 'index' })
  if (load.kind !== 'ok') return result(EXIT.ok, [], { ok: true })
  const { ownership } = context
  const author = authorEmail(root)
  const check = checkOwnership({
    files: zonesOfFiles(load.project, stagedChanges(root)),
    owners: ownership.owners,
    grants: ownership.grants,
    person: author === undefined ? undefined : personOf(ownership.people, author),
    today: today(),
  })
  if (check.denied.length > 0) return denied(context, check.denied, 'коммит отклонён')
  if (messageFile !== undefined) recordGrants(messageFile, check.grants)
  return result(EXIT.ok, [], { ok: true, grants: check.grants })
}

/** pre-push: every pushed commit, made with `--no-verify` too, against its author's rights. */
export function pushOwnership(root: string, remote: string, stdin: string): CommandResult {
  const context = ownershipContext(root)
  if (context.kind === 'skip') return result(EXIT.ok, [], { ok: true })
  if (context.kind === 'note')
    return result(context.code, [context.line], { ownership: 'unchecked' })
  const failures = pushedCommits(root, remote, stdin).flatMap((sha) => {
    const load = loadProject(root, { from: 'commit', sha })
    if (load.kind !== 'ok') return []
    const author = git(root, ['log', '-1', '--format=%ae', sha]).trim().toLowerCase()
    const check = checkOwnership({
      files: zonesOfFiles(load.project, commitChanges(root, sha)),
      owners: context.ownership.owners,
      grants: context.ownership.grants,
      person: personOf(context.ownership.people, author),
      today: today(),
    })
    return check.denied.length === 0 ? [] : [{ sha, author, denied: check.denied }]
  })
  if (failures.length === 0) return result(EXIT.ok, [], { ok: true })
  const lines = failures.flatMap(({ sha, author, denied: zones }) => [
    `${sha.slice(0, 7)} ${commitSubject(root, sha)} — ${author}`,
    ...zones.flatMap((zone) => describeZone(zone, context.ownership.people)),
  ])
  const block = context.enforce === 'block'
  return result(
    block ? EXIT.failed : EXIT.ok,
    [
      `${block ? '✖' : '⚠'} beacon: в пушимых коммитах правки чужих зон без разрешения`,
      ...lines.map((line) => `  ${line}`),
    ],
    { ok: !block, ownership: failures }
  )
}

function denied(
  context: Extract<Context, { kind: 'ok' }>,
  zones: readonly ForeignChange[],
  what: string
): CommandResult {
  const block = context.enforce === 'block'
  return result(
    block ? EXIT.failed : EXIT.ok,
    [
      `${block ? '✖' : '⚠'} beacon: ${block ? what : 'предупреждение'} — правка логики чужих зон`,
      ...zones.flatMap((zone) => describeZone(zone, context.ownership.people)).map((l) => `  ${l}`),
      `  ${FREE_EDITS}`,
      '  Логику меняет владелец, доверенное лицо или кто-то по гранту владельца: beacon grant <зона> <почта>',
    ],
    { ok: !block, denied: zones }
  )
}

function describeZone(zone: ForeignChange, people: readonly Person[]): string[] {
  return [
    `${zone.zone} — владелец ${who(zone.owner.owner, people)}${proxiesOf(zone.owner.proxies, people)}`,
    ...zone.files.map((file) => `  ${file}`),
  ]
}

/** A person by name with the way to reach them. */
export function who(email: string | null, people: readonly Person[]): string {
  if (email === null) return 'не назначен'
  const person = personOf(people, email)
  if (!person) return email
  const { telegram, phone, email: contact } = person.contacts
  const reach = [telegram, phone, contact].filter(Boolean).join(', ')
  return `${person.name} <${email}>${reach === '' ? '' : ` (${reach})`}`
}

function proxiesOf(proxies: readonly string[], people: readonly Person[]): string {
  if (proxies.length === 0) return ''
  return `; доверенные: ${proxies.map((email) => personOf(people, email)?.name ?? email).join(', ')}`
}

/** `Beacon-Grant:` trailers: the permission a commit was made under stays in the history. */
function recordGrants(file: string, grants: readonly Grant[]): void {
  if (grants.length === 0 || !existsSync(file)) return
  const message = readFileSync(file, 'utf8')
  const missing = grants
    .map((grant) => grantTrailer(grant))
    .filter((line) => !message.includes(line))
  if (missing.length === 0) return
  const lines = message.split('\n')
  const comments = lines.findIndex((line) => line.startsWith('#'))
  const body = (comments === -1 ? lines : lines.slice(0, comments)).join('\n').trimEnd()
  const tail = comments === -1 ? '' : `\n${lines.slice(comments).join('\n')}`
  writeFileSync(file, `${body}\n\n${missing.join('\n')}\n${tail}`)
}

/** One file as the gate sees it: each zone with the reader's right to change its logic. */
export interface GateEntry {
  file: string
  zones: { zone: string; right: Permission }[]
}

/** `beacon gate <файлы>`: may I change the logic of these files? Before the edit, not after. */
export function gate(root: string, files: readonly string[], configDir: string): CommandResult {
  const prepared = prepareGate(root, configDir)
  if ('failure' in prepared) return prepared.failure
  const entries = files.map((file) => gateEntry(prepared, file, undefined))
  const blocked = entries.some((entry) => entry.zones.some((zone) => !zone.right.allowed))
  const lines = entries.flatMap((entry) => describeEntry(entry, prepared.ownership.people))
  return result(
    blocked ? EXIT.failed : EXIT.ok,
    [...lines, ...(blocked ? [FREE_EDITS, 'Логику — через владельца или по его гранту.'] : [])],
    { allowed: !blocked, files: entries }
  )
}

export interface Prepared {
  project: Project
  ownership: TeamOwnership
  person: Person | undefined
}

/** The reader: the person logged in to the team server, else the author of commits here. */
export function prepareGate(
  root: string,
  configDir: string
): Prepared | { failure: CommandResult } {
  const context = ownershipContext(root)
  if (context.kind !== 'ok') {
    const line =
      context.kind === 'note'
        ? context.line
        : '• beacon: проверка владельцев выключена или сервер не настроен'
    return { failure: result(EXIT.ok, [line], { allowed: true, unchecked: true }) }
  }
  const load = loadProject(root)
  if (load.kind !== 'ok') {
    return { failure: result(EXIT.ok, ['• Карты зон нет — чужих зон тоже'], { allowed: true }) }
  }
  const email = loadCredential(configDir, context.server)?.user.email ?? authorEmail(root)
  return {
    project: load.project,
    ownership: context.ownership,
    person: email === undefined ? undefined : personOf(context.ownership.people, email),
  }
}

export function gateEntry(
  prepared: Prepared,
  file: string,
  change: ChangedFile | undefined
): GateEntry {
  const current = readCurrent(prepared.project.root, file)
  const probe: ChangedFile = change ?? {
    oldPath: file,
    newPath: file,
    oldRanges: [],
    newRanges: [{ start: 1, end: Math.max(1, (current ?? '').split('\n').length) }],
    ...(current === undefined ? {} : { oldText: current, newText: current }),
  }
  const [zoned] = zonesOfFiles(prepared.project, [probe])
  return {
    file,
    zones: (zoned?.zones ?? []).map((zone) => ({
      zone,
      right: permission({
        zone,
        owners: prepared.ownership.owners,
        grants: prepared.ownership.grants,
        person: prepared.person,
        today: today(),
      }),
    })),
  }
}

export function describeEntry(entry: GateEntry, people: readonly Person[]): string[] {
  if (entry.zones.length === 0) return [`✓ ${entry.file} — вне зон`]
  return entry.zones.map(({ zone, right }) => {
    if (!right.allowed)
      return `✖ ${entry.file} — зона ${zone}: владелец ${who(right.owner.owner, people)}`
    const via = {
      free: 'владельца нет',
      owner: 'вы владелец',
      proxy: 'вы доверенное лицо',
      grant: 'по гранту',
    }[right.via]
    return `✓ ${entry.file} — зона ${zone}: ${via}`
  })
}

export function readCurrent(root: string, file: string): string | undefined {
  const absolute = path.join(root, file)
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined
}

export function today(): string {
  return new Date().toLocaleDateString('sv-SE')
}
