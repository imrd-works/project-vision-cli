/**
 * Parses what git reports about a change set:
 *   `git diff --name-status -z -M`                       → which files changed and how
 *   `git diff -U0 --src-prefix=a/ --dst-prefix=b/ -M`     → which lines changed
 */

export interface LineRange {
  /** 1-based, inclusive. */
  start: number
  end: number
}

export interface FileChange {
  /** Path before the change; absent for added files. */
  oldPath?: string
  /** Path after the change; absent for deleted files. */
  newPath?: string
  /** Changed lines in the old version (removed or replaced). */
  oldRanges: LineRange[]
  /** Changed lines in the new version (added or replacing). */
  newRanges: LineRange[]
}

type Paths = Pick<FileChange, 'oldPath' | 'newPath'>

export function parseNameStatus(output: string): Paths[] {
  const fields = output.split('\0')
  const result: Paths[] = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? ''
    if (status === '') break
    const first = fields[index++] ?? ''
    switch (status.charAt(0)) {
      case 'A': {
        result.push({ newPath: first })
        break
      }
      case 'D': {
        result.push({ oldPath: first })
        break
      }
      case 'R':
      case 'C': {
        result.push({ oldPath: first, newPath: fields[index++] ?? '' })
        break
      }
      default: {
        result.push({ oldPath: first, newPath: first })
      }
    }
  }
  return result
}

interface Hunks {
  oldRanges: LineRange[]
  newRanges: LineRange[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Changed line ranges per file, keyed by the new path (old path for deletions). */
export function parsePatch(patch: string): Map<string, Hunks> {
  const result = new Map<string, Hunks>()
  let oldPath: string | undefined
  let current: Hunks | undefined
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = undefined
      current = undefined
    } else if (line.startsWith('--- ')) {
      oldPath = patchPath(line.slice(4), 'a/')
    } else if (line.startsWith('+++ ') && !current) {
      const key = patchPath(line.slice(4), 'b/') ?? oldPath
      current = { oldRanges: [], newRanges: [] }
      if (key !== undefined) result.set(key, current)
    } else if (current) {
      addHunk(current, line)
    }
  }
  return result
}

export function buildFileChanges(nameStatus: string, patch: string): FileChange[] {
  const hunks = parsePatch(patch)
  return parseNameStatus(nameStatus).map((paths) => {
    const key = paths.newPath ?? paths.oldPath ?? ''
    const ranges = hunks.get(key) ?? { oldRanges: [], newRanges: [] }
    return { ...paths, ...ranges }
  })
}

export function intersects(ranges: readonly LineRange[], start: number, end: number): boolean {
  return ranges.some((range) => range.start <= end && range.end >= start)
}

function addHunk(hunks: Hunks, line: string): void {
  const match = HUNK.exec(line)
  if (!match) return
  const [, oldStart, oldCount, newStart, newCount] = match
  pushRange(hunks.oldRanges, oldStart, oldCount)
  pushRange(hunks.newRanges, newStart, newCount)
}

function pushRange(ranges: LineRange[], start = '0', count = '1'): void {
  const from = Number(start)
  const length = Number(count)
  if (length > 0) ranges.push({ start: from, end: from + length - 1 })
}

/** `a/src/x.ts`, `"b/src/\321\217.ts"`, `/dev/null` (→ undefined). */
function patchPath(raw: string, prefix: string): string | undefined {
  const value = raw.replace(/\t$/, '')
  if (value === '/dev/null') return undefined
  const path = value.startsWith('"') ? unquote(value) : value
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

const ESCAPES: Record<string, number> = {
  n: 10,
  t: 9,
  r: 13,
  '"': 34,
  '\\': 92,
  a: 7,
  b: 8,
  f: 12,
  v: 11,
}

const encoder = new TextEncoder()

/** Undoes git's C-style path quoting; octal escapes are UTF-8 bytes. */
function unquote(quoted: string): string {
  const bytes: number[] = []
  const body = quoted.slice(1, -1)
  for (let index = 0; index < body.length; index++) {
    const char = body[index] ?? ''
    if (char !== '\\') {
      bytes.push(...encoder.encode(char))
      continue
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1))
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8))
      index += 3
    } else {
      bytes.push(ESCAPES[body[index + 1] ?? ''] ?? 92)
      index += 1
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}
