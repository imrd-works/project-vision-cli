import { type CheckpointAudit, collectAudits } from './audit.js'
import { type LineReport, reportLine, type ZoneFacts } from './checkpoint-report.js'
import { type CheckpointPlan, parseCheckpoints } from './checkpoints.js'
import { type BeaconConfig, DEFAULT_CONFIG, parseConfig } from './config.js'
import { authorActivity, buildHistory, type CommitRecord, type History } from './history.js'
import { type Manifest, parseManifest } from './manifest.js'
import { error, type Problem } from './problem.js'
import type { ProjectIndex } from './project-index.js'
import { type Activity, buildTimeline, type Timeline } from './timeline.js'

/**
 * Everything the dashboard shows about one repository at one commit, in a form that survives
 * JSON: the raw `.beacons` files, the index of the files and the commit log. Whatever depends on
 * the date (dynamics, overdue debts, stagnation) is computed from it on demand.
 */
export interface RepositorySnapshot {
  format: 1
  /** The repository's name: its line on the timeline unless the plan names another. */
  name: string
  generatedAt: string
  files: { zones?: string; checkpoints?: string; config?: string }
  /** Absent when the zone map is missing or invalid. */
  index?: ProjectIndex
  /** Recent non-merge commits, newest first. */
  commits: CommitRecord[]
  /** Cross-audit reports and summaries (`.beacons/audits/**`). */
  audits?: { path: string; text: string }[]
}

export type ManifestState =
  | { kind: 'ok'; manifest: Manifest }
  | { kind: 'missing' }
  | { kind: 'invalid'; problems: Problem[] }

export interface IndexView {
  project: { name: string }
  manifest: 'ok' | 'missing' | 'invalid'
  /** Zone map problems when it is invalid; markup problems live in `index`. */
  problems: Problem[]
  index: ProjectIndex | undefined
}

export type TimelineResult = { timeline: Timeline } | { missing: true } | { problems: Problem[] }

/** One line ready to be put on the timeline. */
export interface LineInput {
  plan: CheckpointPlan
  facts: (zone: string) => ZoneFacts | undefined
  activity: Activity
}

export interface TimelineOptions {
  today: string
  extendDays: number
  stagnationDays: number
}

export function manifestState(snapshot: RepositorySnapshot): ManifestState {
  if (snapshot.files.zones === undefined) return { kind: 'missing' }
  const parsed = parseManifest(snapshot.files.zones)
  return parsed.ok
    ? { kind: 'ok', manifest: parsed.manifest }
    : { kind: 'invalid', problems: parsed.problems }
}

export function snapshotConfig(snapshot: RepositorySnapshot): BeaconConfig {
  const parsed = parseConfig(snapshot.files.config)
  return parsed.ok ? parsed.config : DEFAULT_CONFIG
}

export function indexView(snapshot: RepositorySnapshot): IndexView {
  const state = manifestState(snapshot)
  return {
    project: { name: snapshot.name },
    manifest: state.kind,
    problems: state.kind === 'invalid' ? state.problems : [],
    index: state.kind === 'ok' ? snapshot.index : undefined,
  }
}

/** Commits by zones and dynamics up to `today` (YYYY-MM-DD); undefined without a zone map. */
export function historyView(snapshot: RepositorySnapshot, today: string): History | undefined {
  const state = manifestState(snapshot)
  if (state.kind !== 'ok') return undefined
  const { gapDays } = snapshotConfig(snapshot).dynamics
  return buildHistory(snapshot.commits, state.manifest, { gapDays, today })
}

/**
 * The timeline of several repositories, each a line. Settings come from the first one. A line
 * with a broken plan does not hide the others: its problems are reported with the line's name.
 */
export function timelineView(
  snapshots: readonly RepositorySnapshot[],
  today: string
): TimelineResult {
  const [primary] = snapshots
  if (!primary) return { missing: true }
  const { techDebt, stagnation } = snapshotConfig(primary)
  const inputs: LineInput[] = []
  const problems: Problem[] = []
  for (const snapshot of snapshots) {
    const line = lineInput(snapshot)
    if (line === undefined) continue
    if ('problems' in line) {
      problems.push(...line.problems.map((p) => error(`${snapshot.name}: ${p.message}`)))
      continue
    }
    inputs.push(line)
  }
  if (inputs.length === 0) return problems.length > 0 ? { problems } : { missing: true }
  const timeline = combineLines(inputs, {
    today,
    extendDays: techDebt.extendDays,
    stagnationDays: stagnation.days,
  })
  return { timeline: { ...timeline, problems: [...problems, ...timeline.problems] } }
}

/** Reports every line for `today` and links them: the shared core of local and server timelines. */
export function combineLines(lines: readonly LineInput[], options: TimelineOptions): Timeline {
  const reports: LineReport[] = lines.map((line) =>
    reportLine(line.plan, line.facts, { today: options.today, extendDays: options.extendDays })
  )
  return buildTimeline(reports, mergeActivity(lines.map((line) => line.activity)), {
    today: options.today,
    stagnationDays: options.stagnationDays,
  })
}

/** The cross-audits of a snapshot's line: reports and summaries by checkpoint (`line:id`). */
export function auditView(snapshot: RepositorySnapshot): {
  line?: string
  audits: CheckpointAudit[]
} {
  const audits = [
    ...collectAudits(
      snapshot.files.checkpoints === undefined ? [] : (snapshot.audits ?? [])
    ).values(),
  ]
  const line = lineName(snapshot)
  return line === undefined ? { audits } : { line, audits }
}

function lineName(snapshot: RepositorySnapshot): string | undefined {
  const state = manifestState(snapshot)
  if (state.kind !== 'ok' || snapshot.files.checkpoints === undefined) return undefined
  const plan = parseCheckpoints(snapshot.files.checkpoints, state.manifest)
  return plan.ok ? plan.plan.line : undefined
}

/** A snapshot's line; undefined when it has no zone map or no plan. */
function lineInput(snapshot: RepositorySnapshot): LineInput | { problems: Problem[] } | undefined {
  const state = manifestState(snapshot)
  if (state.kind !== 'ok' || snapshot.files.checkpoints === undefined) return undefined
  const plan = parseCheckpoints(snapshot.files.checkpoints, state.manifest)
  if (!plan.ok) return { problems: plan.problems }
  // Architecture checks need the project's own tools: a snapshot knows nothing about them.
  const zones = new Map((snapshot.index?.zones ?? []).map((zone) => [zone.id, zone]))
  return {
    plan: plan.plan,
    facts: (id) => {
      const zone = zones.get(id)
      return zone && { title: zone.title, state: zone.state, architectureErrors: 0 }
    },
    activity: authorActivity(snapshot.commits, state.manifest),
  }
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
