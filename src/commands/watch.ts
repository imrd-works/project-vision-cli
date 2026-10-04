import { projectName } from '../workspace/git.js'
import { LiveIndex, type Snapshot } from '../workspace/live-index.js'
import { LiveValidation } from '../workspace/live-validation.js'

import { EXIT, plural, requireProject } from './result.js'
import { type RunContext, untilAborted } from './running.js'
import { describeValidation } from './validate.js'

/** `beacon watch`: keeps the index current while files change and reports each change. */
export async function watchCommand(root: string, context: RunContext): Promise<number> {
  const loaded = requireProject(root)
  if ('failure' in loaded) {
    context.err(loaded.failure.text)
    return loaded.failure.code
  }
  const live = new LiveIndex(root).start()
  context.out(`Слежу за ${projectName(root)}: ${describe(live.current())}. Остановить — Ctrl+C`)
  const validation = new LiveValidation(root, () => live.current().index)
  live.subscribe((snapshot) => {
    context.out(`↻ ${new Date().toLocaleTimeString('ru-RU')} ${describe(snapshot)}`)
    validation.schedule()
  })
  validation.subscribe((snapshot) => {
    if (!snapshot.running && snapshot.configured)
      context.out(describeValidation(snapshot).join('\n'))
  })
  validation.schedule(0)
  await untilAborted(context.signal)
  validation.stop()
  live.stop()
  return EXIT.ok
}

export function describe(snapshot: Snapshot): string {
  if (snapshot.manifest === 'missing') return 'карты зон нет'
  if (snapshot.manifest === 'invalid') return 'карта зон некорректна — beacon check'
  const index = snapshot.index
  if (!index) return 'индекс не построен'
  const { sourceFiles, zonedSourceFiles } = index.coverage
  const percent = sourceFiles === 0 ? 0 : Math.round((zonedSourceFiles / sourceFiles) * 100)
  const zones = index.zones.length
  const problems = index.problems.length
  return `${String(zones)} ${plural(zones, 'зона', 'зоны', 'зон')}, покрытие ${String(percent)}%${
    problems > 0 ? `, проблем разметки: ${String(problems)}` : ''
  }`
}
