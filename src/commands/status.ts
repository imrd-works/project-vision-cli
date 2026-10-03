import type { ZoneState } from '../core/project-index.js'
import { scanProject } from '../workspace/project.js'

import { STATE_LABELS } from './list.js'
import { type CommandResult, EXIT, plural, requireProject, result } from './result.js'

const STATE_MARKS: Record<ZoneState, string> = { planned: '○', active: '●', completed: '✓' }
const UNZONED_SHOWN = 20

/** Coverage of the code by zones, zone states and folders nobody has mapped yet. */
export function status(root: string): CommandResult {
  const loaded = requireProject(root)
  if ('failure' in loaded) return loaded.failure

  const index = scanProject(loaded.project)
  const { sourceFiles, zonedSourceFiles } = index.coverage
  const percent = sourceFiles === 0 ? 0 : Math.round((zonedSourceFiles / sourceFiles) * 100)
  const count = (state: ZoneState): number => index.zones.filter((z) => z.state === state).length
  const width = Math.max(0, ...index.zones.map((zone) => zone.id.length))

  const lines = [
    `Покрытие: ${String(percent)}% исходных файлов в зонах (${String(zonedSourceFiles)} из ${String(sourceFiles)})`,
    `Зоны: ${String(count('active'))} ${plural(count('active'), 'активная', 'активные', 'активных')}, ` +
      `${String(count('planned'))} ${plural(count('planned'), 'запланированная', 'запланированные', 'запланированных')}, ` +
      `${String(count('completed'))} ${plural(count('completed'), 'завершённая', 'завершённые', 'завершённых')}`,
    ...index.zones.map((zone) => {
      const files = zone.files.length + zone.regions.length
      const size = files > 0 ? `  ${String(files)} ${plural(files, 'файл', 'файла', 'файлов')}` : ''
      return `  ${STATE_MARKS[zone.state]} ${zone.id.padEnd(width)}  ${zone.title} — ${STATE_LABELS[zone.state]}${size}`
    }),
  ]
  if (index.unzonedDirs.length > 0) {
    lines.push(
      'Папки без зон:',
      ...index.unzonedDirs.slice(0, UNZONED_SHOWN).map((dir) => `  ${dir}`)
    )
    const rest = index.unzonedDirs.length - UNZONED_SHOWN
    if (rest > 0) lines.push(`  …и ещё ${String(rest)}`)
  }
  if (index.problems.length > 0) {
    lines.push(`⚠ Проблем разметки: ${String(index.problems.length)} — подробности: beacon check`)
  }
  return result(EXIT.ok, lines, {
    coverage: { ...index.coverage, percent },
    zones: index.zones.map(({ id, title, tags, state }) => ({ id, title, tags, state })),
    unzonedDirs: index.unzonedDirs,
    problems: index.problems.length,
  })
}
