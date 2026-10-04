import type { ZoneFacts } from '../core/checkpoint-report.js'
import { DEFAULT_CONFIG } from '../core/config.js'
import { authorActivity, parseCommitLog } from '../core/history.js'
import type { Problem } from '../core/problem.js'
import type { ProjectIndex } from '../core/project-index.js'
import { combineLines, type LineInput, type TimelineResult } from '../core/snapshot.js'

import { loadPlan } from './checkpoint-file.js'
import { commitLog } from './git.js'
import { loadConfig, loadProject, scanProject } from './project.js'
import type { ValidationRun } from './validation-runner.js'

/** Inputs of one repository's line; `index` and `runs` come from live state when available. */
export interface LineSource {
  root: string
  index?: ProjectIndex | undefined
  runs?: readonly ValidationRun[] | undefined
}

/**
 * Builds the timeline of this repository's line plus sibling repositories (`--with`): every
 * repository is one line. Settings (debt extension, stagnation) come from the first one.
 */
export function projectTimeline(sources: readonly LineSource[]): TimelineResult {
  const [primary] = sources
  if (!primary) return { missing: true }
  const config = loadConfig(primary.root)
  const { techDebt, stagnation } = config.ok ? config.config : DEFAULT_CONFIG

  const lines: LineInput[] = []
  for (const source of sources) {
    const line = collectLine(source)
    if (line === undefined) continue
    if ('problems' in line) {
      if (source === primary) return line
      continue
    }
    lines.push(line)
  }
  if (lines.length === 0) return { missing: true }
  return {
    timeline: combineLines(lines, {
      today: new Date().toLocaleDateString('sv-SE'),
      extendDays: techDebt.extendDays,
      stagnationDays: stagnation.days,
    }),
  }
}

/** One repository's line; undefined when it has no zone map or no plan. */
function collectLine(source: LineSource): LineInput | { problems: Problem[] } | undefined {
  const load = loadProject(source.root)
  if (load.kind !== 'ok') return undefined
  const plan = loadPlan(source.root, load.project.manifest)
  if (plan === undefined) return undefined
  if (!plan.ok) return { problems: plan.problems }

  const index = source.index ?? scanProject(load.project)
  const errors = new Map<string, number>()
  for (const violation of (source.runs ?? []).flatMap((run) => run.violations)) {
    if (violation.severity !== 'error') continue
    for (const zone of violation.zones) errors.set(zone, (errors.get(zone) ?? 0) + 1)
  }
  const zones = new Map(index.zones.map((zone) => [zone.id, zone]))
  return {
    plan: plan.plan,
    facts: (id): ZoneFacts | undefined => {
      const zone = zones.get(id)
      return (
        zone && { title: zone.title, state: zone.state, architectureErrors: errors.get(id) ?? 0 }
      )
    },
    activity: authorActivity(parseCommitLog(commitLog(source.root)), load.project.manifest),
  }
}
