import { z } from 'zod'

/**
 * The plan of a team's project as the server tells it: what the Team plan adds, the trial, the
 * paid period. The client only explains it; the server enforces it.
 */
export const planSchema = z.object({
  plan: z.enum(['free', 'team']),
  status: z.enum(['trial', 'active', 'grace', 'free']),
  features: z.array(z.string()),
  seats: z.number().nullable(),
  developers: z.number(),
  trialEndsAt: z.string(),
  paidUntil: z.string().nullable(),
  graceEndsAt: z.string().nullable(),
  source: z.enum(['admin', 'license']),
})

export type Plan = z.infer<typeof planSchema>

export type Feature = 'cross-audit' | 'signatures' | 'exception-registry' | 'insights'

const FEATURE_TITLES: Readonly<Record<Feature, string>> = {
  'cross-audit': 'кросс-аудит',
  signatures: 'проверка подписей коммитов',
  'exception-registry': 'реестр исключений',
  insights: 'аналитика',
}

/** One line about the plan: which, until when, how many developers. */
export function describePlan(plan: Plan): string {
  const seats = `разработчиков ${String(plan.developers)} из ${plan.seats === null ? '∞' : String(plan.seats)}`
  return `Тариф ${plan.plan === 'team' ? 'Team' : 'Free'} — ${periodOf(plan)} · ${seats}`
}

function periodOf(plan: Plan): string {
  if (plan.status === 'trial') return `пробный период до ${plan.trialEndsAt}`
  if (plan.status === 'grace') {
    return `оплата закончилась ${plan.paidUntil ?? '?'}, льготный период до ${plan.graceEndsAt ?? '?'}`
  }
  if (plan.status === 'free')
    return 'без кросс-аудита, проверки подписей, реестра исключений и аналитики'
  const by = plan.source === 'license' ? 'по лицензии' : 'оплачен'
  return plan.paidUntil === null ? `${by}, без срока` : `${by} до ${plan.paidUntil}`
}

/** Why a command is refused, when the plan lacks its feature; an older server says nothing. */
export function missingFeature(plan: Plan | undefined, feature: Feature): string | undefined {
  if (!plan || plan.features.includes(feature)) return undefined
  return `${FEATURE_TITLES[feature]} доступен на тарифе Team (сейчас Free): обратитесь к владельцу проекта`
}

/** Whether a version is older than another: `0.1.0` < `0.2.0`; pre-release tags are ignored. */
export function isOlder(version: string, than: string): boolean {
  const parts = (value: string): number[] => value.split('-', 1)[0]?.split('.').map(Number) ?? []
  const [a, b] = [parts(version), parts(than)]
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference < 0
  }
  return false
}
