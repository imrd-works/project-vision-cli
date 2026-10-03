import { parseCommitBeacons } from './commit-message.js'
import { type FileChange, intersects, type LineRange } from './diff.js'
import { type Manifest, resolveZoneId } from './manifest.js'
import { parseMarkup } from './markup.js'
import { error, type Problem } from './problem.js'
import { byText } from './text.js'
import type { ZoneResolver } from './zone-resolver.js'

/**
 * Commit rules: every zone touched by the change must have its beacon in the message.
 * @see docs/beacon-format.md#маяки-в-коммитах
 */

export interface ChangedFile extends FileChange {
  /** Content before the change; undefined for added or binary files. */
  oldText?: string | undefined
  /** Content after the change; undefined for deleted or binary files. */
  newText?: string | undefined
}

export interface ZoneTouch {
  zone: string
  /** Files through which the commit touches the zone. */
  files: string[]
}

export interface TouchedZones {
  zones: ZoneTouch[]
  problems: Problem[]
}

export interface CommitCheck extends TouchedZones {
  /** Touched zones whose beacon is missing in the message. */
  missing: ZoneTouch[]
  /** Zones that the message marks as completed. */
  completed: string[]
}

interface Context {
  manifest: Manifest
  resolver: ZoneResolver
}

export function touchedZones(context: Context, files: readonly ChangedFile[]): TouchedZones {
  const touches = new Map<string, Set<string>>()
  const problems: Problem[] = []
  for (const file of files) {
    const display = file.newPath ?? file.oldPath ?? ''
    const zones = new Set<string>()
    if (file.oldPath !== undefined) {
      zonesOfSide(context, side(file.oldPath, file.oldText, file.oldRanges), zones, undefined)
    }
    if (file.newPath !== undefined) {
      zonesOfSide(context, side(file.newPath, file.newText, file.newRanges), zones, problems)
    }
    for (const zone of zones) touches.set(zone, (touches.get(zone) ?? new Set()).add(display))
  }
  return {
    zones: [...touches]
      .map(([zone, paths]) => ({ zone, files: [...paths].toSorted(byText) }))
      .toSorted((a, b) => a.zone.localeCompare(b.zone)),
    problems,
  }
}

export function checkCommit(
  context: Context,
  files: readonly ChangedFile[],
  message: string
): CommitCheck {
  const touched = touchedZones(context, files)
  const parsed = parseCommitBeacons(message)
  const problems = [...touched.problems, ...parsed.problems]
  const provided = new Set<string>()
  const completed: string[] = []
  for (const beacon of parsed.beacons) {
    const zone = resolveZoneId(context.manifest, beacon.id)
    if (zone === undefined) {
      problems.push(error(`маяк коммита [BEACON: ${beacon.id}]: такой зоны нет в zones.yml`))
      continue
    }
    provided.add(zone)
    if (beacon.completed) completed.push(zone)
  }
  return {
    zones: touched.zones,
    missing: touched.zones.filter((touch) => !provided.has(touch.zone)),
    completed: [...new Set(completed)].toSorted(byText),
    problems,
  }
}

interface Side {
  path: string
  text: string | undefined
  ranges: LineRange[]
}

function side(path: string, text: string | undefined, ranges: LineRange[]): Side {
  return { path, text, ranges }
}

/**
 * Collects zones of one version of a file. Problems are reported only for the new version:
 * the old one is history the author cannot fix in this commit.
 */
function zonesOfSide(
  { manifest, resolver }: Context,
  { path, text, ranges }: Side,
  zones: Set<string>,
  problems: Problem[] | undefined
): void {
  const byPath = resolver(path)
  if (byPath.kind === 'zone') zones.add(byPath.zone)
  if (byPath.kind === 'conflict') {
    problems?.push(
      error(
        `файл попадает в несвязанные зоны ${byPath.zones.join(', ')} — поправьте пути в zones.yml`,
        {
          file: path,
        }
      )
    )
  }
  if (text === undefined) return

  const markup = parseMarkup(text, path)
  problems?.push(...markup.problems.filter((problem) => problem.severity === 'error'))
  const add = (id: string, line: number): void => {
    const zone = resolveZoneId(manifest, id)
    if (zone === undefined) {
      problems?.push(
        error(`маяк неизвестной зоны "${id}" — её нет в zones.yml`, { file: path, line })
      )
    } else {
      zones.add(zone)
    }
  }
  for (const beacon of markup.fileBeacons) add(beacon.id, beacon.line)
  for (const region of markup.regions) {
    if (!intersects(ranges, region.start, region.end)) continue
    for (const id of region.ids) add(id, region.start)
  }
}
