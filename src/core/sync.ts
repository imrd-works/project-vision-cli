import { z } from 'zod'

import { planSchema } from './plan.js'
import { qaSchema } from './qa.js'

/**
 * The contract of the team server as `beacon login` and `beacon sync` see it, and the offline
 * model: what the client keeps (the last bundle) and what waits to be sent (the outbox).
 */

const person = z.object({ name: z.string(), email: z.string() }).nullable()

export const loginStartedSchema = z.object({
  id: z.string(),
  code: z.string(),
  pollSecret: z.string(),
  verificationUrl: z.string(),
  expiresAt: z.string(),
})

export const loginClaimSchema = z.object({
  status: z.enum(['pending', 'approved', 'expired']),
  token: z.string().optional(),
  user: z.object({ email: z.string(), name: z.string() }).optional(),
})

export const entitySchema = z.object({
  kind: z.string(),
  key: z.string(),
  data: z.unknown(),
  version: z.number(),
  updatedAt: z.string(),
  updatedBy: person,
})

export const conflictSchema = z.object({
  id: z.string(),
  kind: z.string(),
  key: z.string(),
  baseVersion: z.number(),
  mine: z.unknown(),
  theirs: z.unknown(),
  createdAt: z.string(),
  createdBy: person,
})

export const VERDICTS = ['agree', 'accept-risk', 'object'] as const
export type Verdict = (typeof VERDICTS)[number]

/** The cross-audit of a checkpoint as the server sees it: rounds, reports in git, signatures. */
export const auditStateSchema = z.object({
  checkpoint: z.string(),
  title: z.string(),
  auditors: z.array(z.string()),
  consolidator: z.string().optional(),
  /** The current round; null — not started. */
  round: z.number().nullable(),
  status: z.enum(['not-started', 'auditing', 'objected', 'passed']),
  closedWithoutAudit: z.boolean(),
  rounds: z.array(
    z.object({
      round: z.number(),
      commit: z.string(),
      startedBy: z.string(),
      startedAt: z.string(),
      reports: z.array(
        z.object({
          author: z.string(),
          model: z.string().optional(),
          path: z.string(),
          findings: z.number(),
        })
      ),
      summary: z
        .object({
          path: z.string(),
          fixed: z.number(),
          disputed: z.number(),
          accepted: z.number(),
          open: z.number(),
        })
        .nullable(),
      signatures: z.array(
        z.object({
          email: z.string(),
          name: z.string().optional(),
          verdict: z.enum(VERDICTS),
          comment: z.string().optional(),
          at: z.string(),
        })
      ),
    })
  ),
})

export type AuditState = z.infer<typeof auditStateSchema>

/** A person of the project: the account's email and every email their git accounts verified. */
export const personSchema = z.object({
  userId: z.string(),
  name: z.string(),
  role: z.string(),
  emails: z.array(z.string()),
  contacts: z.object({
    telegram: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
  }),
  identities: z.array(
    z.object({ provider: z.string(), login: z.string(), signingKeys: z.number() })
  ),
})

/** Who owns a zone (`repository:zone`) and who may change it alongside. */
export const zoneOwnerSchema = z.object({
  ref: z.string(),
  repository: z.string(),
  zone: z.string(),
  title: z.string(),
  owner: z.string().nullable(),
  proxies: z.array(z.string()),
  version: z.number(),
})

/** SSH signing keys of linked git accounts; `allowedSigners` is git's allowed signers file. */
export const signersSchema = z.object({
  signers: z.array(
    z.object({ name: z.string(), emails: z.array(z.string()), keys: z.array(z.string()) })
  ),
  allowedSigners: z.string(),
})

/**
 * A card of a task tracker linked through its beacons: to zones, their owners and the
 * checkpoints where the zones are items.
 */
export const trackerCardSchema = z.object({
  tracker: z.string(),
  key: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.string(),
  closed: z.boolean(),
  updatedAt: z.string(),
  links: z.array(
    z.object({
      zone: z.string(),
      link: z.enum(['task', 'stopper', 'debt']),
      repository: z.string().nullable(),
      owner: z.string().nullable(),
      checkpoints: z.array(z.string()),
    })
  ),
  /** Beacons naming zones the project does not have. */
  unresolved: z.array(z.string()),
})

export type TrackerCard = z.infer<typeof trackerCardSchema>

export type Person = z.infer<typeof personSchema>
export type ZoneOwner = z.infer<typeof zoneOwnerSchema>
export type Signers = z.infer<typeof signersSchema>

export const roundStartedSchema = z.object({ round: z.number(), commit: z.string() })

export const bundleSchema = z.object({
  revision: z.number(),
  day: z.string(),
  changed: z.boolean(),
  project: z.object({ id: z.string(), name: z.string(), role: z.string() }).optional(),
  repositories: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        /** The clone address: a checkout finds its repository by its origin remote. */
        url: z.string().optional(),
        defaultBranch: z.string().nullable(),
        status: z.string(),
        syncedAt: z.string().nullable(),
        branches: z.number(),
      })
    )
    .optional(),
  /** A TimelineResult of the server, computed for `day`. */
  timeline: z.unknown().optional(),
  entities: z.array(entitySchema).optional(),
  conflicts: z.array(conflictSchema).optional(),
  audits: z.array(auditStateSchema).optional(),
  people: z.array(personSchema).optional(),
  owners: z.array(zoneOwnerSchema).optional(),
  signers: signersSchema.optional(),
  cards: z.array(trackerCardSchema).optional(),
  qa: qaSchema.optional(),
  plan: planSchema.optional(),
})

export const pushResultSchema = z.object({
  revision: z.number(),
  results: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['applied', 'stale', 'conflict', 'rejected']),
      version: z.number().optional(),
      conflictId: z.string().optional(),
      reason: z.string().optional(),
    })
  ),
})

export type LoginStarted = z.infer<typeof loginStartedSchema>
export type LoginClaim = z.infer<typeof loginClaimSchema>
export type Bundle = z.infer<typeof bundleSchema>
export type SyncEntity = z.infer<typeof entitySchema>
export type PushResult = z.infer<typeof pushResultSchema>

/** A change made offline: applied by the server once, by its `id`. */
export interface Operation {
  id: string
  kind: string
  key: string
  data: unknown
  baseVersion: number
  at: string
}

/** The full state as of the last successful pull. */
export type ChangedBundle = Bundle & { changed: true }

export const CHECKPOINT_REF = /^[a-z0-9][\w.-]*:[a-z0-9][\w.-]*$/

/** Notes to checkpoints as the team will see them: the server's, then changes not sent yet. */
export function notesOf(
  entities: readonly SyncEntity[],
  outbox: readonly Operation[]
): Map<string, { text: string; pending: boolean }> {
  const notes = new Map<string, { text: string; pending: boolean }>()
  for (const entity of entities) {
    const text = noteText(entity.data)
    if (entity.kind === 'note' && text !== undefined)
      notes.set(entity.key, { text, pending: false })
  }
  for (const operation of outbox) {
    if (operation.kind !== 'note') continue
    const text = noteText(operation.data)
    if (text === undefined) notes.delete(operation.key)
    else notes.set(operation.key, { text, pending: true })
  }
  return notes
}

/** The version of an entity the client saw: what an offline change is made against. */
export function versionOf(entities: readonly SyncEntity[], kind: string, key: string): number {
  return entities.find((entity) => entity.kind === kind && entity.key === key)?.version ?? 0
}

function noteText(data: unknown): string | undefined {
  const parsed = z.object({ text: z.string() }).safeParse(data)
  return parsed.success ? parsed.data.text : undefined
}

/** One line about a checkpoint's cross-audit, for the terminal. */
export function describeAudit(audit: AuditState): string {
  if (audit.closedWithoutAudit) return '⚠ закрыт без кросс-аудита'
  const current = audit.rounds.at(-1)
  if (audit.status === 'not-started' || !current) return '◌ кросс-аудит не начат'
  const signed = current.signatures.filter((s) => s.verdict !== 'object').length
  const progress = `раунд ${String(current.round)}, подписей ${String(signed)}/${String(audit.auditors.length)}, отчётов ${String(current.reports.length)}`
  if (audit.status === 'passed') return `✓ кросс-аудит пройден (${progress})`
  if (audit.status === 'objected')
    return `⚠ кросс-аудит: есть возражения — нужен новый раунд (${progress})`
  return `◎ кросс-аудит: ${progress}`
}

/** A grant to change a zone's logic: `<repository>:<zone>/<email>`, given until a day or for good. */
export const grantDataSchema = z.object({
  until: z.string().nullable(),
  reason: z.string(),
})

/** A decision on an exception of the registry: `<repository>:<exception id>`. */
export const approvalDataSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().optional(),
})

export type GrantData = z.infer<typeof grantDataSchema>
export type ApprovalData = z.infer<typeof approvalDataSchema>

const CARD_MARKS = { task: '☐', stopper: '⛔', debt: '⚑' } as const
const CARD_WORDS = { task: 'задача', stopper: 'стопер', debt: 'техдолг' } as const

/** Open tracker cards by checkpoint (`line:id`): one line each, stoppers first. */
export function cardsByCheckpoint(cards: readonly TrackerCard[]): Map<string, string[]> {
  const lines = new Map<string, { rank: number; text: string }[]>()
  for (const card of cards.filter((entry) => !entry.closed)) {
    for (const link of card.links) {
      for (const ref of link.checkpoints) {
        const text = `${CARD_MARKS[link.link]} ${CARD_WORDS[link.link]} ${card.key} «${card.title}» (${card.tracker})`
        const rank = link.link === 'stopper' ? 0 : 1
        lines.set(ref, [...(lines.get(ref) ?? []), { rank, text }])
      }
    }
  }
  return new Map(
    [...lines].map(([ref, entries]) => [
      ref,
      [...new Set(entries.toSorted((a, b) => a.rank - b.rank).map((entry) => entry.text))],
    ])
  )
}

/** Open cards linked to the zones a person owns. */
export function cardsOf(cards: readonly TrackerCard[], email: string): TrackerCard[] {
  const me = email.toLowerCase()
  return cards.filter(
    (card) => !card.closed && card.links.some((link) => link.owner?.toLowerCase() === me)
  )
}
