import path from 'node:path'

import { LiveIndex, type Snapshot } from '../workspace/live-index.js'

import { EXIT, plural, requireProject } from './result.js'
import { type RunContext, untilAborted } from './running.js'

/** `beacon watch`: keeps the index current while files change and reports each change. */
export async function watchCommand(root: string, context: RunContext): Promise<number> {
  const loaded = requireProject(root)
  if ('failure' in loaded) {
    context.err(loaded.failure.text)
    return loaded.failure.code
  }
  const live = new LiveIndex(root).start()
  context.out(`Слежу за ${path.basename(root)}: ${describe(live.current())}. Остановить — Ctrl+C`)
  live.subscribe((snapshot) => {
    context.out(`↻ ${new Date().toLocaleTimeString('ru-RU')} ${describe(snapshot)}`)
  })
  await untilAborted(context.signal)
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
