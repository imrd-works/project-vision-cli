import { loadPlan } from './checkpoint-file.js'
import { authorEmail } from './git.js'
import { loadConfig, type Project } from './project.js'

const OVERRIDE = /\[DEBT-OVERRIDE:\s*[^\]\s][^\]]*\]/

/**
 * The technical debt limit: a developer over it may commit only into the zones of their debts —
 * closing debt comes first. `[DEBT-OVERRIDE: reason]` lets an emergency through, on the record.
 * Returns the explanation when the commit must be rejected.
 */
export function debtLimitViolation(
  project: Project,
  touchedZones: readonly string[],
  message: string
): string[] | undefined {
  if (touchedZones.length === 0 || OVERRIDE.test(message)) return undefined
  const email = authorEmail(project.root)
  const plan = loadPlan(project.root, project.manifest, 'index')
  if (email === undefined || !plan?.ok) return undefined
  const config = loadConfig(project.root)
  const limit = config.ok ? config.config.techDebt.limitPerDeveloper : 2

  const debts = plan.plan.checkpoints.flatMap((checkpoint) =>
    checkpoint.debts
      .filter((debt) => debt.closed === undefined && debt.owner.toLowerCase() === email)
      .map((debt) => ({ ...debt, checkpoint: checkpoint.id }))
  )
  if (debts.length <= limit) return undefined
  const allowed = new Set(debts.flatMap((debt) => debt.zones))
  const outside = touchedZones.filter((zone) => !allowed.has(zone))
  if (outside.length === 0) return undefined

  return [
    `У ${email} открыто техдолгов: ${String(debts.length)} при лимите ${String(limit)}:`,
    ...debts.map(
      (debt) => `  ⚑ ${debt.checkpoint}/${debt.id}: ${debt.reason} (до ${debt.deadline})`
    ),
    `Коммит трогает зоны вне техдолга: ${outside.join(', ')}`,
    'Сначала закройте техдолг — beacon todo покажет порядок. Аварийно: [DEBT-OVERRIDE: причина] в сообщении',
  ]
}
