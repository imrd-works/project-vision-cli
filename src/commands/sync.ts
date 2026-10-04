import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { TimelineResult } from '../core/snapshot.js'
import {
  type ChangedBundle,
  CHECKPOINT_REF,
  describeAudit,
  notesOf,
  type PushResult,
  versionOf,
} from '../core/sync.js'
import { todoFor } from '../core/timeline.js'
import { loadCredential } from '../workspace/credentials.js'
import { authorEmail } from '../workspace/git.js'
import { writeAllowedSigners } from '../workspace/identity.js'
import { loadConfig } from '../workspace/project.js'
import { ServerClient, ServerError } from '../workspace/server-client.js'
import { readCache, type SyncCache, writeCache } from '../workspace/sync-cache.js'

import { describeTimeline } from './checkpoints.js'
import { serverFailure } from './login.js'
import { type CommandResult, EXIT, result } from './result.js'
import { describeTodo } from './todo.js'

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
  const credential = loadCredential(configDir, target.server)
  if (!credential) {
    return result(
      EXIT.failed,
      [`✖ Вы не вошли на ${target.server}: beacon login ${target.server}`],
      { error: 'not-logged-in' }
    )
  }
  const client = new ServerClient(target.server, credential.token)
  const cache = readCache(root, target)
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
    return result(EXIT.ok, describeSync(cache, bundle.changed, pushed), {
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

/** The team's keys, for git to verify signatures with (`git log --show-signature`, the hooks). */
function keepSigners(root: string, bundle: ChangedBundle | undefined): void {
  if (bundle?.signers) writeAllowedSigners(root, bundle.signers.allowedSigners)
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
  const cache = readCache(root, target)
  cache.outbox.push({
    id: randomUUID(),
    kind: 'note',
    key: change.ref,
    data: change.text === undefined ? null : { text: change.text },
    baseVersion: versionOf(cache.bundle?.entities ?? [], 'note', change.ref),
    at: new Date().toISOString(),
  })
  writeCache(root, cache)
  const queued = change.text === undefined ? 'удаление заметки' : 'заметка'
  const sent = await sync(root, target, configDir)
  const lines = [`✓ ${queued} к ${change.ref} сохранена`, sent.text]
  return result(EXIT.ok, lines, { queued: change.ref, sync: sent.json })
}

/** `beacon checkpoints --server`: every line of the project as of the last sync. */
export function serverCheckpoints(root: string, target: Target): CommandResult {
  const cache = readCache(root, target)
  const timeline = cachedTimeline(cache)
  if (!cache.bundle || timeline === undefined) return notSynced()
  if ('missing' in timeline) {
    return result(
      EXIT.ok,
      [header(cache), '• В репозиториях проекта нет планов чекпоинтов (.beacons/checkpoints.yml)'],
      { missing: true }
    )
  }
  const shown = describeTimeline(timeline, teamExtras(cache))
  return { ...shown, text: [header(cache), shown.text].join('\n') }
}

/** `beacon todo --server`: my list across the project as of the last sync. */
export function serverTodo(root: string, target: Target, owner: string | undefined): CommandResult {
  const cache = readCache(root, target)
  const timeline = cachedTimeline(cache)
  if (!cache.bundle || timeline === undefined) return notSynced()
  const who = owner ?? authorEmail(root)
  if (who === undefined) return result(EXIT.failed, ['✖ Не знаю, кто вы: задайте --owner'], {})
  if (!('timeline' in timeline)) return result(EXIT.ok, ['• Чекпоинтов нет — и задач тоже'], {})
  const shown = describeTodo(todoFor(timeline.timeline, who))
  return { ...shown, text: [header(cache), shown.text].join('\n') }
}

const timelineShape = z.union([
  z.object({ timeline: z.object({ lines: z.array(z.unknown()) }) }),
  z.object({ missing: z.literal(true) }),
  z.object({ problems: z.array(z.unknown()) }),
])

/** The server computes timelines with the same core: its JSON is trusted once the shape fits. */
function cachedTimeline(cache: SyncCache): TimelineResult | undefined {
  const parsed = timelineShape.safeParse(cache.bundle?.timeline)
  return parsed.success ? (cache.bundle?.timeline as TimelineResult) : undefined
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

/** Lines under each checkpoint: the team's note, then the state of its cross-audit. */
function teamExtras(cache: SyncCache): Map<string, string[]> {
  const extras = new Map<string, string[]>()
  const add = (ref: string, line: string): void => {
    extras.set(ref, [...(extras.get(ref) ?? []), line])
  }
  for (const [ref, note] of notesOf(cache.bundle?.entities ?? [], cache.outbox)) {
    add(ref, `✎ ${note.text}${note.pending ? ' (не отправлена)' : ''}`)
  }
  for (const audit of cache.bundle?.audits ?? []) add(audit.checkpoint, describeAudit(audit))
  return extras
}
