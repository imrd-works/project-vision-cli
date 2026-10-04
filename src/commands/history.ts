import { projectHistory } from '../workspace/live-index.js'

import { type CommandResult, EXIT, plural, requireProject, result } from './result.js'

const TOP_AUTHORS = 3

/** `beacon history`: commits by zones, their authors and gaps in development. */
export function history(root: string): CommandResult {
  const loaded = requireProject(root)
  if ('failure' in loaded) return loaded.failure
  const data = projectHistory(loaded.project)
  const width = Math.max(0, ...data.zones.map((zone) => zone.zone.length))

  const lines = [
    `Коммитов: ${String(data.totalCommits)}, с маяками зон: ${String(data.markedCommits)}`,
    ...data.zones.map((zone) => {
      const authors = zone.authors
        .slice(0, TOP_AUTHORS)
        .map((author) => `${author.name} (${String(author.commits)})`)
        .join(', ')
      return (
        `  ${zone.zone.padEnd(width)}  ${String(zone.commits)} ${plural(zone.commits, 'коммит', 'коммита', 'коммитов')}` +
        ` · ${authors} · последний ${zone.last.date.slice(0, 10)} «${zone.last.subject}»`
      )
    }),
  ]
  const { gaps } = data.dynamics
  if (gaps.length > 0) {
    lines.push(
      'Провалы (рабочие дни без коммитов в зонах):',
      ...gaps.map(
        (gap) =>
          `  ${gap.from} — ${gap.to}: ${String(gap.workingDays)} ${plural(gap.workingDays, 'день', 'дня', 'дней')}`
      )
    )
  }
  return result(EXIT.ok, lines, data)
}
