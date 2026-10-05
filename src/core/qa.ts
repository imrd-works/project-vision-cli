import { z } from 'zod'

/**
 * The testers' side of the checkpoints: test cases with their results, bug reports with their
 * state (open → fixed by a developer → closed by a tester), checkpoints ready for testing.
 */
export const qaSchema = z.object({
  testCases: z.array(
    z.object({
      id: z.string(),
      checkpoint: z.string(),
      zone: z.string().nullable(),
      title: z.string(),
      result: z
        .object({ verdict: z.enum(['passed', 'failed']), by: z.string(), at: z.string() })
        .nullable(),
    })
  ),
  bugs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      severity: z.string(),
      status: z.enum(['open', 'fixed', 'closed']),
      zone: z.string().nullable(),
      owner: z.string().nullable(),
      checkpoints: z.array(z.string()),
    })
  ),
  ready: z.array(z.object({ checkpoint: z.string(), title: z.string() })),
})

export type Qa = z.infer<typeof qaSchema>

/** What keeps a checkpoint from closing for the testers: unpassed test cases, unclosed bugs. */
export function qaBlockers(qa: Qa | undefined, ref: string): string[] {
  if (!qa) return []
  const cases = qa.testCases.filter(
    (entry) => entry.checkpoint === ref && entry.result?.verdict !== 'passed'
  )
  const bugs = qa.bugs.filter((bug) => bug.status !== 'closed' && bug.checkpoints.includes(ref))
  return [
    ...cases.map(
      (entry) => `тест-кейс «${entry.title}» ${entry.result ? 'не пройден' : 'не проверен'}`
    ),
    ...bugs.map(
      (bug) =>
        `баг #${bug.id} «${bug.title}» ${bug.status === 'fixed' ? 'ждёт подтверждения тестировщика' : 'открыт'}`
    ),
  ]
}

/** Lines of the testers' state by checkpoint: test cases passed, bugs not closed. */
export function qaByCheckpoint(qa: Qa | undefined): Map<string, string[]> {
  const lines = new Map<string, string[]>()
  const add = (ref: string, line: string): void => {
    lines.set(ref, [...(lines.get(ref) ?? []), line])
  }
  const testCases = qa?.testCases ?? []
  for (const ref of new Set(testCases.map((entry) => entry.checkpoint))) {
    add(ref, casesLine(testCases.filter((entry) => entry.checkpoint === ref)))
  }
  for (const bug of (qa?.bugs ?? []).filter((entry) => entry.status !== 'closed')) {
    for (const ref of bug.checkpoints) add(ref, bugLine(bug))
  }
  return lines
}

function casesLine(cases: Qa['testCases']): string {
  const passed = cases.filter((entry) => entry.result?.verdict === 'passed').length
  return `🧪 тест-кейсы: пройдено ${String(passed)}/${String(cases.length)}`
}

function bugLine(bug: Qa['bugs'][number]): string {
  const state = bug.status === 'fixed' ? 'исправлен, ждёт подтверждения' : 'открыт'
  return `🐞 баг #${bug.id} «${bug.title}» — ${state}`
}
