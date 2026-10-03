import { error, type Problem } from './problem.js'
import { validateZoneId } from './zone-id.js'

/**
 * Beacons in commit messages: `[BEACON: id]`, `[BEACON: id completed]`. Lines starting with `#`
 * are git comments and are ignored, as is everything below the `git commit -v` scissors line.
 * @see docs/beacon-format.md#маяки-в-коммитах
 */

export interface CommitBeacon {
  id: string
  completed: boolean
}

const BRACKET = /\[BEACON:([^\]]*)\]/g
const COMPLETED = 'completed'
const SCISSORS = /^# -+ >8 -+$/

export function parseCommitBeacons(message: string): {
  beacons: CommitBeacon[]
  problems: Problem[]
} {
  const beacons: CommitBeacon[] = []
  const problems: Problem[] = []
  for (const match of meaningfulText(message).matchAll(BRACKET)) {
    const words = (match[1] ?? '').split(/[\s,]+/).filter(Boolean)
    const completed = words.includes(COMPLETED)
    const ids = words.filter((word) => word !== COMPLETED)
    if (ids.length === 0) problems.push(error(`маяк ${match[0]} без ID зоны`))
    for (const id of ids) {
      if (validateZoneId(id)) problems.push(error(`некорректный ID зоны "${id}" в ${match[0]}`))
      else beacons.push({ id, completed })
    }
  }
  return { beacons, problems }
}

/**
 * Adds `[BEACON: id]` lines for `ids` at the end of the message, above git's comment block.
 * An empty message keeps its first line free for the subject.
 */
export function appendBeacons(message: string, ids: readonly string[]): string {
  if (ids.length === 0) return message
  const lines = message.split('\n')
  const tailStart = commentTailStart(lines)
  const head = lines.slice(0, tailStart)
  while (head.length > 0 && head.at(-1)?.trim() === '') head.pop()

  const beaconLines = ids.map((id) => `[BEACON: ${id}]`)
  const block = head.length === 0 ? ['', '', ...beaconLines] : [...head, '', ...beaconLines]
  const tail = lines.slice(tailStart)
  return [...block, ...(tail.length > 0 ? ['', ...tail] : [''])].join('\n')
}

/** Message text without git comments and the verbose diff. */
function meaningfulText(message: string): string {
  const lines = message.split('\n')
  const scissors = lines.findIndex((line) => SCISSORS.test(line))
  return (scissors === -1 ? lines : lines.slice(0, scissors))
    .filter((line) => !line.startsWith('#'))
    .join('\n')
}

/** Index where the trailing block of `#` comments (and the scissors section) begins. */
function commentTailStart(lines: string[]): number {
  const scissors = lines.findIndex((line) => SCISSORS.test(line))
  let start = scissors === -1 ? lines.length : scissors
  while (start > 0) {
    const previous = lines[start - 1] ?? ''
    if (!previous.startsWith('#') && previous.trim() !== '') break
    start--
  }
  // Keep blank lines that precede the comments with the message.
  while (start < lines.length && lines[start]?.trim() === '' && start !== scissors) start++
  return start
}
