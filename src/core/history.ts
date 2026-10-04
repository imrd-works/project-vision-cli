import { dateRange, isWorkingDay, workingDaysBetween } from './calendar.js'
import { type CommitBeacon, parseCommitBeacons } from './commit-message.js'
import { type Manifest, resolveZoneId } from './manifest.js'
import type { Activity } from './timeline.js'

/**
 * Commit history by zones (who changed which part of the product, how often) and the
 * development dynamics: progress over time with gaps — runs of working days without zone work.
 */

export interface CommitRecord {
  sha: string
  author: { name: string; email: string }
  /** ISO date with the author's offset, as git recorded it. */
  date: string
  subject: string
  beacons: CommitBeacon[]
}

export interface ZoneActivity {
  zone: string
  commits: number
  authors: { name: string; email: string; commits: number }[]
  last: { sha: string; subject: string; date: string }
}

export interface DynamicsDay {
  /** YYYY-MM-DD. */
  date: string
  /** Commits with zone beacons that day. */
  commits: number
  /** Zones completed so far (cumulative). */
  completed: number
}

export interface Gap {
  from: string
  to: string
  /** Working days (Mon–Fri) without commits in zones. */
  workingDays: number
}

export interface History {
  totalCommits: number
  /** Commits that carry at least one zone beacon. */
  markedCommits: number
  zones: ZoneActivity[]
  dynamics: { days: DynamicsDay[]; gaps: Gap[] }
}

/** `git log --format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e` → records. */
export function parseCommitLog(output: string): CommitRecord[] {
  return output
    .split('\u{1E}')
    .map((entry) => entry.replace(/^\n+/, ''))
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [sha = '', name = '', email = '', date = '', body = ''] = entry.split('\u{1F}', 5)
      return {
        sha,
        author: { name, email },
        date,
        subject: body.split('\n', 1)[0] ?? '',
        beacons: parseCommitBeacons(body).beacons,
      }
    })
}

/** `commits` newest first, as git log prints them; `today` as YYYY-MM-DD. */
export function buildHistory(
  commits: readonly CommitRecord[],
  manifest: Manifest,
  options: { gapDays: number; today: string }
): History {
  const resolved = commits.map((commit) => ({
    ...commit,
    zones: [...new Set(commit.beacons.flatMap((b) => resolveZoneId(manifest, b.id) ?? []))],
    completed: commit.beacons.flatMap((b) =>
      b.completed ? (resolveZoneId(manifest, b.id) ?? []) : []
    ),
  }))
  const marked = resolved.filter((commit) => commit.zones.length > 0)
  return {
    totalCommits: commits.length,
    markedCommits: marked.length,
    zones: zoneActivity(marked),
    dynamics: dynamics(marked.toReversed(), options),
  }
}

type ResolvedCommit = CommitRecord & { zones: string[]; completed: string[] }

function zoneActivity(commits: readonly ResolvedCommit[]): ZoneActivity[] {
  const byZone = new Map<string, ResolvedCommit[]>()
  for (const commit of commits) {
    for (const zone of commit.zones) byZone.set(zone, [...(byZone.get(zone) ?? []), commit])
  }
  return [...byZone]
    .map(([zone, list]) => {
      const authors = new Map<string, { name: string; email: string; commits: number }>()
      for (const commit of list) {
        const key = commit.author.email.toLowerCase()
        const author = authors.get(key) ?? { ...commit.author, commits: 0 }
        author.commits++
        authors.set(key, author)
      }
      const [latest] = list
      return {
        zone,
        commits: list.length,
        authors: [...authors.values()].toSorted((a, b) => b.commits - a.commits),
        last: { sha: latest?.sha ?? '', subject: latest?.subject ?? '', date: latest?.date ?? '' },
      }
    })
    .toSorted((a, b) => b.commits - a.commits || a.zone.localeCompare(b.zone))
}

function dynamics(
  oldestFirst: readonly ResolvedCommit[],
  { gapDays, today }: { gapDays: number; today: string }
): History['dynamics'] {
  const [first] = oldestFirst
  if (!first) return { days: [], gaps: [] }
  const perDay = new Map<string, ResolvedCommit[]>()
  for (const commit of oldestFirst) {
    const day = commit.date.slice(0, 10)
    perDay.set(day, [...(perDay.get(day) ?? []), commit])
  }
  const completed = new Set<string>()
  const days: DynamicsDay[] = []
  for (const date of dateRange(first.date.slice(0, 10), today)) {
    const list = perDay.get(date) ?? []
    for (const zone of list.flatMap((commit) => commit.completed)) completed.add(zone)
    days.push({ date, commits: list.length, completed: completed.size })
  }
  return { days, gaps: findGaps(days, gapDays) }
}

/** Runs of at least `gapDays` working days without commits; weekends neither break nor count. */
function findGaps(days: readonly DynamicsDay[], gapDays: number): Gap[] {
  const gaps: Gap[] = []
  let run: { from: string; to: string; workingDays: number } | undefined
  const close = (): void => {
    if (run && run.workingDays >= gapDays) gaps.push(run)
    run = undefined
  }
  for (const day of days) {
    if (day.commits > 0) close()
    else if (isWorkingDay(day.date)) {
      run = run
        ? { ...run, to: day.date, workingDays: run.workingDays + 1 }
        : { from: day.date, to: day.date, workingDays: 1 }
    }
  }
  close()
  return gaps
}

/** Who last worked in which zone, and how long zones take to complete — for stagnation. */
export function authorActivity(commits: readonly CommitRecord[], manifest: Manifest): Activity {
  const lastByZone = new Map<string, string>()
  const lastAny = new Map<string, string>()
  const firstByZone = new Map<string, string>()
  const completedByZone = new Map<string, string>()
  // git log is newest first: the first date seen is the latest, the last one the earliest.
  for (const commit of commits) {
    const day = commit.date.slice(0, 10)
    const email = commit.author.email.toLowerCase()
    for (const beacon of commit.beacons) {
      const zone = resolveZoneId(manifest, beacon.id)
      if (zone === undefined) continue
      if (!lastByZone.has(`${email} ${zone}`)) lastByZone.set(`${email} ${zone}`, day)
      if (!lastAny.has(email)) lastAny.set(email, day)
      firstByZone.set(zone, day)
      if (beacon.completed && !completedByZone.has(zone)) completedByZone.set(zone, day)
    }
  }
  return {
    last: (email, zones) => {
      const key = email.toLowerCase()
      if (zones.length === 0) return lastAny.get(key)
      const dates = zones.flatMap((zone) => lastByZone.get(`${key} ${zone}`) ?? [])
      return dates.length > 0 ? dates.toSorted((a, b) => a.localeCompare(b)).at(-1) : undefined
    },
    durations: [...completedByZone].map(([zone, completed]) =>
      workingDaysBetween(firstByZone.get(zone) ?? completed, completed)
    ),
  }
}
