import { z } from 'zod'

import { qaByCheckpoint } from '../core/qa.js'
import type { TimelineResult } from '../core/snapshot.js'
import {
  cardsByCheckpoint,
  cardsOf,
  type ChangedBundle,
  describeAudit,
  notesOf,
} from '../core/sync.js'
import { todoFor } from '../core/timeline.js'
import { authorEmail } from '../workspace/git.js'
import { readCache, type SyncCache } from '../workspace/sync-cache.js'

import { describeTimeline } from './checkpoints.js'
import { type CommandResult, EXIT, result } from './result.js'
import { header, notSynced, type Target } from './sync.js'
import { describeTodo } from './todo.js'

/** The project as of the last `beacon sync`: every line with the team's state, my todo. */

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
  const cards = cardsOf(cache.bundle.cards ?? [], who)
  const qaLines = testerLines(cache.bundle, who)
  const cardLines =
    cards.length === 0
      ? []
      : [
          'Карточки трекеров по вашим зонам:',
          ...cards.map((card) => `  ${card.key} «${card.title}» — ${card.status} · ${card.url}`),
        ]
  return {
    code: shown.code,
    text: [header(cache), shown.text, ...cardLines, ...qaLines].join('\n'),
    json: { ...(shown.json as object), cards },
  }
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

/** Lines under each checkpoint: the team's note, then the state of its cross-audit. */
function teamExtras(cache: SyncCache): Map<string, string[]> {
  const bundle = cache.bundle
  const notes = [...notesOf(bundle?.entities ?? [], cache.outbox)].map(
    ([ref, note]): [string, string[]] => [
      ref,
      [`✎ ${note.text}${note.pending ? ' (не отправлена)' : ''}`],
    ]
  )
  const audits = (bundle?.audits ?? []).map((audit): [string, string[]] => [
    audit.checkpoint,
    [describeAudit(audit)],
  ])
  const extras = new Map<string, string[]>()
  const sources = [
    ...notes,
    ...audits,
    ...cardsByCheckpoint(bundle?.cards ?? []),
    ...qaByCheckpoint(bundle?.qa),
  ]
  for (const [ref, lines] of sources) {
    extras.set(ref, [...(extras.get(ref) ?? []), ...lines])
  }
  return extras
}

/** For a tester: what is ready for testing and which fixes wait for them; for a developer: bugs of their zones. */
function testerLines(bundle: ChangedBundle, who: string): string[] {
  const qa = bundle.qa
  if (!qa) return []
  if (bundle.project?.role === 'tester') {
    const fixed = qa.bugs.filter((bug) => bug.status === 'fixed')
    return [
      ...(qa.ready.length > 0
        ? [
            'Готово к проверке:',
            ...qa.ready.map((entry) => `  ${entry.checkpoint} «${entry.title}»`),
          ]
        : []),
      ...(fixed.length > 0
        ? ['Исправлено, ждёт подтверждения:', ...fixed.map((bug) => `  #${bug.id} «${bug.title}»`)]
        : []),
    ]
  }
  const mine = qa.bugs.filter(
    (bug) => bug.status === 'open' && bug.owner?.toLowerCase() === who.toLowerCase()
  )
  return mine.length === 0
    ? []
    : ['Баги ваших зон:', ...mine.map((bug) => `  #${bug.id} «${bug.title}» (${bug.severity})`)]
}
