import { type LineReport, reportLine, type ZoneFacts } from '../core/checkpoint-report.js'
import type { CheckpointPlan } from '../core/checkpoints.js'
import { DEFAULT_CONFIG } from '../core/config.js'
import { authorActivity, parseCommitLog } from '../core/history.js'
import type { Problem } from '../core/problem.js'
import type { ProjectIndex } from '../core/project-index.js'
import { type Activity, buildTimeline, type Timeline } from '../core/timeline.js'

import { loadPlan } from './checkpoint-file.js'
import { commitLog } from './git.js'
import { loadConfig, loadProject, type Project, scanProject } from './project.js'
import type { ValidationRun } from './validation-runner.js'

/** Inputs of one repository's line; `index` and `runs` come from live state when available. */
export interface LineSource {
  root: string
  index?: ProjectIndex | undefined
  runs?: readonly ValidationRun[] | undefined
}

export type TimelineResult = { timeline: Timeline } | { missing: true } | { problems: Problem[] }

/**
 * Builds the timeline of this repository's line plus sibling repositories (`--with`): every
 * repository is one line. Settings (debt extension, stagnation) come from the first one.
 */
export function projectTimeline(sources: readonly LineSource[]): TimelineResult {
  const [primary] = sources
  if (!primary) return { missing: true }
  const config = loadConfig(primary.root)
  const { techDebt, stagnation } = config.ok ? config.config : DEFAULT_CONFIG
  const today = new Date().toLocaleDateString('sv-SE')

  const lines: LineReport[] = []
  const activities: Activity[] = []
  for (const source of sources) {
    const line = collectLine(source, { today, extendDays: techDebt.extendDays })
    if (line === undefined) continue
    if ('problems' in line) {
      if (source === primary) return line
      continue
    }
    lines.push(line.report)
    activities.push(line.activity)
  }
  if (lines.length === 0) return { missing: true }
  return {
    timeline: buildTimeline(lines, mergeActivity(activities), {
      today,
      stagnationDays: stagnation.days,
    }),
  }
}

/** One repository's line; undefined when it has no zone map or no plan. */
function collectLine(
  source: LineSource,
  options: { today: string; extendDays: number }
): { report: LineReport; activity: Activity } | { problems: Problem[] } | undefined {
  const load = loadProject(source.root)
  if (load.kind !== 'ok') return undefined
  const plan = loadPlan(source.root, load.project.manifest)
  if (plan === undefined) return undefined
  if (!plan.ok) return { problems: plan.problems }
  return {
    report: lineOf(load.project, plan.plan, source, options),
    activity: authorActivity(parseCommitLog(commitLog(source.root)), load.project.manifest),
  }
}

function lineOf(
  project: Project,
  plan: CheckpointPlan,
  source: LineSource,
  options: { today: string; extendDays: number }
): LineReport {
  const index = source.index ?? scanProject(project)
  const errors = new Map<string, number>()
  for (const violation of (source.runs ?? []).flatMap((run) => run.violations)) {
    if (violation.severity !== 'error') continue
    for (const zone of violation.zones) errors.set(zone, (errors.get(zone) ?? 0) + 1)
  }
  const zones = new Map(index.zones.map((zone) => [zone.id, zone]))
  const facts = (id: string): ZoneFacts | undefined => {
    const zone = zones.get(id)
    return zone && { title: zone.title, state: zone.state, architectureErrors: errors.get(id) ?? 0 }
  }
  return reportLine(plan, facts, options)
}

function mergeActivity(activities: readonly Activity[]): Activity {
  return {
    last: (email, zones) =>
      activities
        .map((activity) => activity.last(email, zones))
        .filter((date) => date !== undefined)
        .toSorted((a, b) => a.localeCompare(b))
        .at(-1),
    durations: activities.flatMap((activity) => activity.durations),
  }
}
