import { parseDocument } from 'yaml'
import { z } from 'zod'

import { type Manifest, resolveZoneId } from './manifest.js'
import { error, type Problem } from './problem.js'

/**
 * `.beacons/checkpoints.yml`: the architect's plan for this repository's line (frontend,
 * backend…) — checkpoints with required items and dependencies — and the decisions taken on it:
 * manual ticks, closures, technical debt. Zone items are never ticked by hand: they close when
 * the zone is completed.
 * @see docs/beacon-format.md#чекпоинты
 */
export const CHECKPOINTS_PATH = '.beacons/checkpoints.yml'

const SLUG = /^[a-z][a-z0-9-]*$/
const REF = /^(?:[a-z][a-z0-9-]*:)?[a-z][a-z0-9-]*$/
const slug = z.string().regex(SLUG, 'латиница в нижнем регистре, цифры, дефис')
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата в формате ГГГГ-ММ-ДД')
const email = z.string().regex(/^[^\s@]+@[^\s@]+$/, 'email из git config user.email')
/** `checkpoint` on this line or `line:checkpoint` on another one. */
const ref = z.string().regex(REF, 'чекпоинт или линия:чекпоинт')

const zoneItem = z.strictObject({ zone: z.string(), owner: email.optional() })
const checkItem = z.strictObject({
  id: slug,
  check: z.string().trim().min(1),
  owner: email.optional(),
  done: z.strictObject({ date: day, by: email.optional() }).optional(),
})

const debtSchema = z.strictObject({
  id: slug,
  reason: z.string().trim().min(1),
  owner: email,
  created: day,
  deadline: day,
  /** What the debt waits for; when it closes, the debt becomes its owner's first priority. */
  waitsFor: ref.optional(),
  zones: z.array(z.string()).default([]),
  closed: day.optional(),
})

const checkpointSchema = z.strictObject({
  title: z.string().trim().min(1),
  description: z.string().optional(),
  deadline: day.optional(),
  after: z.array(slug).default([]),
  dependsOn: z.array(ref).default([]),
  items: z.array(z.union([zoneItem, checkItem])).min(1, 'нужен хотя бы один пункт'),
  closed: z
    .strictObject({ date: day, by: email.optional(), conditional: z.boolean().default(false) })
    .optional(),
  debts: z.array(debtSchema).default([]),
  /** Who audits it (the item owners by default) and who consolidates the findings. */
  audit: z
    .strictObject({ auditors: z.array(email).min(1).optional(), consolidator: email.optional() })
    .optional(),
})

const fileSchema = z.strictObject({
  version: z.literal(1),
  line: slug,
  title: z.string().optional(),
  checkpoints: z
    .record(slug, checkpointSchema)
    .nullish()
    .transform((value) => value ?? {}),
})

export type PlanItem = z.infer<typeof zoneItem> | z.infer<typeof checkItem>
export type Debt = z.infer<typeof debtSchema>
export type PlannedCheckpoint = z.infer<typeof checkpointSchema> & { id: string }

export interface CheckpointPlan {
  line: string
  title: string
  checkpoints: PlannedCheckpoint[]
}

export type PlanResult = { ok: true; plan: CheckpointPlan } | { ok: false; problems: Problem[] }

export function isZoneItem(item: PlanItem): item is z.infer<typeof zoneItem> {
  return 'zone' in item
}

/** Parses the plan and checks it against the zone map; zone IDs are normalized (formerly). */
export function parseCheckpoints(text: string, manifest: Manifest): PlanResult {
  const document = parseDocument(text, { prettyErrors: false })
  if (document.errors.length > 0) {
    return { ok: false, problems: document.errors.map((e) => at(`YAML: ${e.message}`)) }
  }
  const parsed = fileSchema.safeParse(document.toJS())
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) =>
        at(`${issue.path.join('.') || 'корень'}: ${issue.message}`)
      ),
    }
  }
  const checkpoints = Object.entries(parsed.data.checkpoints).map(([id, checkpoint]) => ({
    ...checkpoint,
    id,
    items: checkpoint.items.map((item) =>
      isZoneItem(item) ? { ...item, zone: resolveZoneId(manifest, item.zone) ?? item.zone } : item
    ),
  }))
  const problems = checkpoints.flatMap((checkpoint) =>
    checkCheckpoint(checkpoint, checkpoints, manifest)
  )
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    plan: { line: parsed.data.line, title: parsed.data.title ?? parsed.data.line, checkpoints },
  }
}

function checkCheckpoint(
  checkpoint: PlannedCheckpoint,
  all: readonly PlannedCheckpoint[],
  manifest: Manifest
): Problem[] {
  const where = `чекпоинт "${checkpoint.id}"`
  const problems: Problem[] = []
  for (const item of checkpoint.items) {
    if (isZoneItem(item) && !manifest.zones.has(item.zone)) {
      problems.push(at(`${where}: зоны "${item.zone}" нет в zones.yml`))
    }
  }
  for (const id of duplicates(
    checkpoint.items.flatMap((item) => (isZoneItem(item) ? [] : [item.id]))
  )) {
    problems.push(at(`${where}: пункт "${id}" указан дважды`))
  }
  for (const id of duplicates(checkpoint.debts.map((debt) => debt.id))) {
    problems.push(at(`${where}: техдолг "${id}" указан дважды`))
  }
  for (const id of checkpoint.after.filter((after) => all.every((other) => other.id !== after))) {
    problems.push(at(`${where}: after "${id}" — такого чекпоинта на линии нет`))
  }
  if (checkpoint.closed?.conditional && checkpoint.debts.length === 0) {
    problems.push(at(`${where}: условное закрытие требует хотя бы одного техдолга`))
  }
  return problems
}

function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

function at(message: string): Problem {
  return error(message, { file: CHECKPOINTS_PATH })
}
