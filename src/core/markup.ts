import { type CommentOpener, commentOpenersFor } from './comment-style.js'
import { error, type Problem, warning } from './problem.js'
import { validateZoneId } from './zone-id.js'

/**
 * Beacons inside source files: `// @beacon a b`, `// [BEACON: a] [BEACON: b]`, and regions
 * `// #region @beacon a` … `// #endregion`. A comment counts only when it starts the line and
 * its text starts with the beacon.
 * @see docs/beacon-format.md#маяки-в-коде
 */

/** Bump when parsing rules change: cached markup of every file is then re-parsed. */
export const MARKUP_VERSION = 1

export interface CodeBeacon {
  id: string
  /** 1-based line of the marker. */
  line: number
}

export interface BeaconRegion {
  ids: string[]
  /** Line of `#region`, 1-based, inclusive. */
  start: number
  /** Line of `#endregion` (or the last line when unclosed), inclusive. */
  end: number
}

export interface FileMarkup {
  /** Beacons outside regions: the whole file belongs to these zones. */
  fileBeacons: CodeBeacon[]
  regions: BeaconRegion[]
  problems: Problem[]
}

const EMPTY: FileMarkup = { fileBeacons: [], regions: [], problems: [] }

const MARKDOWN = /\.mdx?$/i
const FENCE = /^\s*(?:```|~~~)/
const REGION = /^#region\b(.*)$/
const END_REGION = /^#endregion\b/
const BRACKET_GROUP = /^\[BEACON:([^\]]*)\]\s*/

interface OpenRegion {
  ids: string[] | undefined
  start: number
}

export function parseMarkup(text: string, file: string): FileMarkup {
  if (!text.includes('BEACON') && !text.includes('@beacon')) return EMPTY
  const lines = text.split(/\r?\n/)
  const openers = commentOpenersFor(file)
  const skip = MARKDOWN.test(file) ? fencedCodeLines(lines) : new Set<number>()
  const scanner = new MarkupScanner(file, lines.length)
  for (const [index, line] of lines.entries()) {
    const comment = skip.has(index) ? undefined : readComment(line, openers)
    if (comment) scanner.comment(comment, index + 1)
  }
  return scanner.finish()
}

class MarkupScanner {
  private readonly result: FileMarkup = { fileBeacons: [], regions: [], problems: [] }
  private readonly stack: OpenRegion[] = []
  private hasBeaconRegions = false
  private strayEnd: number | undefined

  constructor(
    private readonly file: string,
    private readonly lastLine: number
  ) {}

  comment(comment: Comment, line: number): void {
    const region = REGION.exec(comment.text)
    if (region) this.openRegion(region[1] ?? '', line)
    else if (END_REGION.test(comment.text)) this.closeRegion(line)
    else collectFileBeacons(comment, line, this.file, this.result)
  }

  finish(): FileMarkup {
    // Unbalanced plain #region markers are none of our business, only beacon regions are.
    if (!this.hasBeaconRegions) return this.result
    if (this.strayEnd !== undefined) {
      this.problem('#endregion без открывающего #region', this.strayEnd)
    }
    for (const open of this.stack) {
      if (!open.ids) continue
      this.problem('регион с маяком не закрыт (#endregion)', open.start)
      this.result.regions.push({ ids: open.ids, start: open.start, end: this.lastLine })
    }
    return this.result
  }

  private openRegion(label: string, line: number): void {
    const ids = parseDirective(label.trim())
    if (ids) this.hasBeaconRegions = true
    this.stack.push({
      ids: ids && validIds(ids, line, this.file, this.result.problems),
      start: line,
    })
  }

  private closeRegion(line: number): void {
    const open = this.stack.pop()
    if (!open) this.strayEnd ??= line
    else if (open.ids) this.result.regions.push({ ids: open.ids, start: open.start, end: line })
  }

  private problem(message: string, line: number): void {
    this.result.problems.push(error(message, { file: this.file, line }))
  }
}

/** Parses the text after a comment opener: `@beacon a b` or `[BEACON: a] [BEACON: b c]`. */
export function parseDirective(text: string): string[] | undefined {
  if (text.startsWith('@beacon')) {
    const rest = text.slice('@beacon'.length)
    if (rest !== '' && !/^\s/.test(rest)) return undefined
    return splitIds(rest)
  }
  if (!text.startsWith('[BEACON:')) return undefined
  const ids: string[] = []
  let rest = text
  for (let group = BRACKET_GROUP.exec(rest); group; group = BRACKET_GROUP.exec(rest)) {
    ids.push(...splitIds(group[1] ?? ''))
    rest = rest.slice(group[0].length)
  }
  return ids
}

interface Comment {
  opener: CommentOpener
  /** Comment text without the opener and closer, trimmed; `#region` normalized. */
  text: string
}

function readComment(line: string, openers: readonly CommentOpener[]): Comment | undefined {
  const trimmed = line.trimStart()
  const opener = openers.find((candidate) => trimmed.startsWith(candidate))
  if (!opener) return undefined
  let text = trimmed.slice(opener.length).trim()
  if (opener === '<!--') text = text.replace(/-->$/, '').trim()
  if (opener === '/*' || opener === '/**') text = text.replace(/\*\/$/, '').trim()
  // In `#` comments the opener is part of the marker: `#region`, `# region`.
  if (opener === '#' && /^(?:end)?region\b/.test(text)) text = `#${text}`
  return { opener, text }
}

function collectFileBeacons(
  comment: Comment,
  lineNo: number,
  file: string,
  result: FileMarkup
): void {
  const ids = parseDirective(comment.text)
  if (!ids) return
  if (comment.opener === '/**') {
    result.problems.push(
      warning('маяк в JSDoc-блоке /** */ не распознаётся — перенесите его в обычный комментарий', {
        file,
        line: lineNo,
      })
    )
    return
  }
  for (const id of validIds(ids, lineNo, file, result.problems)) {
    result.fileBeacons.push({ id, line: lineNo })
  }
}

function validIds(ids: string[], line: number, file: string, problems: Problem[]): string[] {
  if (ids.length === 0) {
    problems.push(error('пустой маяк: укажите ID зоны', { file, line }))
    return []
  }
  return ids.filter((id) => {
    const idError = validateZoneId(id)
    if (idError === 'reserved') {
      problems.push(
        error(`"${id}" — не зона: флаг completed ставится только в коммите`, { file, line })
      )
    } else if (idError) {
      problems.push(error(`некорректный ID зоны "${id}"`, { file, line }))
    }
    return !idError
  })
}

/** Indexes of lines inside fenced code blocks: examples, not markup. */
function fencedCodeLines(lines: readonly string[]): Set<number> {
  const result = new Set<number>()
  let inside = false
  for (const [index, line] of lines.entries()) {
    if (FENCE.test(line)) inside = !inside
    if (inside || FENCE.test(line)) result.add(index)
  }
  return result
}

function splitIds(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean)
}
