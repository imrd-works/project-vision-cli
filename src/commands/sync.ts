import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { describePlan, type Feature, isOlder, missingFeature } from '../core/plan.js'
import { type ChangedBundle, CHECKPOINT_REF, type PushResult, versionOf } from '../core/sync.js'
import { loadCredential } from '../workspace/credentials.js'
import { writeAllowedSigners } from '../workspace/identity.js'
import { loadConfig } from '../workspace/project.js'
import { ServerClient, ServerError } from '../workspace/server-client.js'
import { ownCache, readCache, type SyncCache, writeCache } from '../workspace/sync-cache.js'

import { serverFailure } from './login.js'
import { type CommandResult, EXIT, result } from './result.js'
import { packageVersion } from './running.js'

export interface Target {
  server: string
  project: string
}

/** The server and project: from flags, else from `.beacons/config.yml`. */
export function syncTarget(
  root: string,
  flags: { server?: string | undefined; project?: string | undefined }
): Target | CommandResult {
  const config = loadConfig(root)
  const server = (flags.server ?? (config.ok ? config.config.server?.url : undefined))?.replace(
    /\/+$/,
    ''
  )
  const project = flags.project ?? (config.ok ? config.config.server?.project : undefined)
  if (server === undefined || project === undefined) {
    return result(
      EXIT.usage,
      [
        '✖ Не знаю, с каким сервером синхронизироваться. Укажите в .beacons/config.yml:',
        '  server:',
        '    url: https://vision.example.com',
        '    project: <id проекта из дашборда>',
        '  или --server и --project',
      ],
      { error: 'no-server' }
    )
  }
  return { server, project }
}

/** `beacon sync`: send changes made offline, then take the project's state for offline work. */
export async function sync(
  root: string,
  target: Target,
  configDir: string
): Promise<CommandResult> {
  const opened = openCache(root, target, configDir)
  if ('failure' in opened) return opened.failure
  const { cache, client } = opened
  let pushed: PushResult | undefined
  try {
    if (cache.outbox.length > 0) {
      pushed = await client.push(target.project, cache.outbox)
      // Every operation has its answer now: applied, stale, conflict or rejected.
      cache.outbox = []
      writeCache(root, cache)
    }
    const since = cache.bundle && { revision: cache.bundle.revision, day: cache.bundle.day }
    const bundle = await client.pull(target.project, since)
    if (bundle.changed) cache.bundle = bundle as ChangedBundle
    keepSigners(root, cache.bundle)
    cache.syncedAt = new Date().toISOString()
    writeCache(root, cache)
    const notes = await syncNotes(client, cache)
    return result(EXIT.ok, [...describeSync(cache, bundle.changed, pushed), ...notes], {
      revision: bundle.revision,
      changed: bundle.changed,
      pushed: pushed?.results ?? [],
    })
  } catch (error) {
    if (!(error instanceof ServerError) || error.kind !== 'offline') {
      return serverFailure(target.server, error)
    }
    const failure = serverFailure(target.server, error)
    return result(EXIT.failed, [failure.text, ...describeOffline(cache)], {
      ...(failure.json as object),
      offline: true,
      waiting: cache.outbox.length,
    })
  }
}

/** The cache of the logged-in person and a client of the server, or why there is none. */
function openCache(
  root: string,
  target: Target,
  configDir: string
): { cache: SyncCache; client: ServerClient } | { failure: CommandResult } {
  const credential = loadCredential(configDir, target.server)
  if (!credential) {
    return {
      failure: result(
        EXIT.failed,
        [`✖ Вы не вошли на ${target.server}: beacon login ${target.server}`],
        { error: 'not-logged-in' }
      ),
    }
  }
  const owned = ownCache(readCache(root, target), credential.user.email)
  if ('author' in owned) {
    return {
      failure: result(
        EXIT.failed,
        [
          `✖ Изменения ${owned.author} ещё не отправлены (${String(owned.waiting)}): войдите как ${owned.author} и выполните beacon sync`,
        ],
        { error: 'outbox-of-another-user', user: owned.author }
      ),
    }
  }
  return { cache: owned.cache, client: new ServerClient(target.server, credential.token) }
}

/** The team's keys, for git to verify signatures with (`git log --show-signature`, the hooks). */
function keepSigners(root: string, bundle: ChangedBundle | undefined): void {
  if (bundle?.signers) writeAllowedSigners(root, bundle.signers.allowedSigners)
}

/** Queues a change of a shared entity against the version last seen; `beacon sync` sends it. */
export function enqueue(
  root: string,
  target: Target,
  change: { kind: string; key: string; data: unknown }
): void {
  const cache = readCache(root, target)
  cache.outbox.push({
    id: randomUUID(),
    ...change,
    baseVersion: versionOf(cache.bundle?.entities ?? [], change.kind, change.key),
    at: new Date().toISOString(),
  })
  writeCache(root, cache)
}

/** `beacon note <line:checkpoint> <text>` (or `--delete`): queued, then sent if the server is up. */
export async function note(
  root: string,
  target: Target,
  configDir: string,
  change: { ref: string; text: string | undefined }
): Promise<CommandResult> {
  if (!CHECKPOINT_REF.test(change.ref)) {
    return result(EXIT.usage, ['✖ Чекпоинт указывается как линия:id, например backend:auth'], {
      error: 'bad-ref',
    })
  }
  enqueue(root, target, {
    kind: 'note',
    key: change.ref,
    data: change.text === undefined ? null : { text: change.text },
  })
  const queued = change.text === undefined ? 'удаление заметки' : 'заметка'
  const sent = await sync(root, target, configDir)
  const lines = [`✓ ${queued} к ${change.ref} сохранена`, sent.text]
  return result(EXIT.ok, lines, { queued: change.ref, sync: sent.json })
}

export function notSynced(): CommandResult {
  return result(EXIT.failed, ['✖ Данных сервера ещё нет — выполните beacon sync'], {
    error: 'not-synced',
  })
}

export function header(cache: SyncCache): string {
  const bundle = cache.bundle
  const when = cache.syncedAt?.slice(0, 16).replace('T', ' ') ?? '—'
  return `Сервер ${cache.server} · «${bundle?.project?.name ?? '?'}» · данные на ${when} (ревизия ${String(bundle?.revision ?? 0)})`
}

/** The plan of the project and whether this client is too old for the server. */
async function syncNotes(client: ServerClient, cache: SyncCache): Promise<string[]> {
  const plan = cache.bundle?.plan ? [`  ${describePlan(cache.bundle.plan)}`] : []
  return [...plan, ...(await clientNotes(client))]
}

/** An older server without /meta says nothing. */
async function clientNotes(client: ServerClient): Promise<string[]> {
  try {
    const meta = await client.meta()
    return isOlder(packageVersion(), meta.minClientVersion)
      ? [
          `  ⚠ Сервер ${meta.version} ждёт beacon ${meta.minClientVersion} или новее (у вас ${packageVersion()}): обновите клиент`,
        ]
      : []
  } catch {
    return []
  }
}

/** Refuses a command whose feature the project's plan lacks, as of the last sync. */
export function planRefusal(
  root: string,
  target: Target,
  feature: Feature
): CommandResult | undefined {
  const missing = missingFeature(readCache(root, target).bundle?.plan, feature)
  return missing === undefined
    ? undefined
    : result(EXIT.failed, [`✖ ${missing}`], { error: 'plan', feature })
}

function describeSync(
  cache: SyncCache,
  changed: boolean,
  pushed: PushResult | undefined
): string[] {
  const bundle = cache.bundle
  const conflicts = bundle?.conflicts ?? []
  const title = `«${projectName(bundle)}», ревизия ${String(bundle?.revision ?? 0)}`
  return [
    changed ? `✓ Синхронизировано: ${title}` : `✓ Без изменений: ${title}`,
    `  Линии: ${lineNames(bundle).join(', ') || '—'} · людей: ${String(countPeople(bundle))} · заметок: ${String(countNotes(bundle))} · конфликтов: ${String(conflicts.length)}`,
    ...(pushed ? describePushed(pushed) : []),
    ...conflicts.map((c) => `  ⚠ конфликт ${c.kind} ${c.key}: решите в дашборде`),
  ]
}

function describePushed(pushed: PushResult): string[] {
  const count = (status: string): number => pushed.results.filter((r) => r.status === status).length
  return [
    `  Отправлено изменений: ${String(pushed.results.length)} — применено ${String(count('applied'))}, устарело ${String(count('stale'))}, конфликтов ${String(count('conflict'))}`,
    ...pushed.results
      .filter((r) => r.status === 'rejected')
      .map((r) => `  ✖ изменение отклонено: ${r.reason ?? ''}`),
  ]
}

function describeOffline(cache: SyncCache): string[] {
  const when = cache.syncedAt?.slice(0, 16).replace('T', ' ')
  return [
    when
      ? `  Работаем с данными на ${when} (ревизия ${String(cache.bundle?.revision ?? 0)})`
      : '  Данных сервера ещё нет',
    ...(cache.outbox.length > 0
      ? [`  Ждут отправки: ${String(cache.outbox.length)} — уйдут при следующем beacon sync`]
      : []),
  ]
}

function projectName(bundle: ChangedBundle | undefined): string {
  return bundle?.project?.name ?? '?'
}

function lineNames(bundle: ChangedBundle | undefined): string[] {
  const parsed = z
    .object({ timeline: z.object({ lines: z.array(z.object({ line: z.string() })) }) })
    .safeParse(bundle?.timeline)
  return parsed.success ? parsed.data.timeline.lines.map((line) => line.line) : []
}

function countPeople(bundle: ChangedBundle | undefined): number {
  return bundle?.people?.length ?? 0
}

function countNotes(bundle: ChangedBundle | undefined): number {
  return (bundle?.entities ?? []).filter((e) => e.kind === 'note' && e.data !== null).length
}
