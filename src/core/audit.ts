import { parseDocument } from 'yaml'
import { z } from 'zod'

import { error, type Problem } from './problem.js'

/**
 * Cross-audit files in git: every auditor's report of a round and the consolidator's summary.
 *
 *   .beacons/audits/<checkpoint>/round-<n>/<author>.md   a report: findings of one model
 *   .beacons/audits/<checkpoint>/round-<n>/summary.md    what was done with every finding
 *
 * Both are Markdown with a YAML header; findings and resolutions are `### [label] title` headings,
 * so people write them by hand and models fill them from a template.
 * @see docs/beacon-format.md#кросс-аудит
 */

export const AUDITS_DIR = '.beacons/audits'
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export const RESOLUTIONS = ['fixed', 'disputed', 'accepted'] as const

export type Severity = (typeof SEVERITIES)[number]
export type Resolution = (typeof RESOLUTIONS)[number]

export interface Finding {
  severity: Severity
  title: string
  file?: string
  line?: number
  zone?: string
}

export interface AuditReport {
  path: string
  round: number
  author: string
  model?: string
  commit?: string
  findings: Finding[]
}

export interface AuditSummary {
  path: string
  round: number
  consolidator?: string
  /** The commit with the fixes: the next round audits it. */
  commit?: string
  resolutions: { resolution: Resolution | 'open'; title: string }[]
}

export interface AuditRound {
  round: number
  reports: AuditReport[]
  summary?: AuditSummary
}

/** Audit files of one checkpoint, by round (oldest first). */
export interface CheckpointAudit {
  checkpoint: string
  rounds: AuditRound[]
  problems: Problem[]
}

const FILE = /^\.beacons\/audits\/([a-z][a-z0-9-]*)\/round-(\d+)\/([\w.-]+)\.md$/
const FINDING = /^### \[(critical|high|medium|low|info)\]\s+(.+)$/
const RESOLUTION = /^### \[(fixed|disputed|accepted|\?)\]\s+(.+)$/
const FILE_LINE = /^- (?:Файл|File):\s*`?([^`\s:]+)(?::(\d+))?`?\s*$/
const ZONE_LINE = /^- (?:Зона|Zone):\s*`?([^`\s]+)`?\s*$/

/**
 * Empty fields of a template (`commit:` before the fixes) read as absent; a short commit SHA of
 * digits only is a number to YAML when written by hand without quotes.
 */
const text = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((value) =>
    value === null || value === undefined || value === '' ? undefined : String(value)
  )

const headerSchema = z.object({
  round: z.number().int().min(1).optional(),
  author: text,
  consolidator: text,
  model: text,
  commit: text,
})

export function auditPath(checkpoint: string, round: number, name: string): string {
  return `${AUDITS_DIR}/${checkpoint}/round-${String(round)}/${name}.md`
}

/** `ann.lee@x.io` → `ann-lee-x-io`: a report's file name. */
export function authorSlug(email: string): string {
  return email
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
}

/** Groups the audit files of a repository by checkpoint and round. */
export function collectAudits(
  files: readonly { path: string; text: string }[]
): Map<string, CheckpointAudit> {
  const audits = new Map<string, CheckpointAudit>()
  for (const file of files) {
    const match = FILE.exec(file.path)
    if (!match) continue
    const [, checkpoint = '', roundText = '', name = ''] = match
    const round = Number(roundText)
    const audit = audits.get(checkpoint) ?? { checkpoint, rounds: [], problems: [] }
    audits.set(checkpoint, audit)
    const entry = roundOf(audit, round)
    if (name === 'summary') {
      const summary = parseSummary(file.path, file.text, round)
      entry.summary = summary.summary
      audit.problems.push(...summary.problems)
    } else {
      const report = parseReport(file.path, file.text, round)
      entry.reports.push(report.report)
      audit.problems.push(...report.problems)
    }
  }
  for (const audit of audits.values()) {
    audit.rounds.sort((a, b) => a.round - b.round)
    for (const round of audit.rounds) round.reports.sort((a, b) => a.author.localeCompare(b.author))
  }
  return audits
}

export function parseReport(
  path: string,
  text: string,
  round: number
): { report: AuditReport; problems: Problem[] } {
  const { header, body, problems } = splitHeader(path, text)
  if (header.author === undefined)
    problems.push(error('нет author в заголовке отчёта', { file: path }))
  return {
    report: {
      path,
      round: header.round ?? round,
      author: header.author ?? path.split('/').at(-1)?.replace(/\.md$/, '') ?? '',
      ...(header.model === undefined ? {} : { model: header.model }),
      ...(header.commit === undefined ? {} : { commit: header.commit }),
      findings: findingsOf(body),
    },
    problems,
  }
}

export function parseSummary(
  path: string,
  text: string,
  round: number
): { summary: AuditSummary; problems: Problem[] } {
  const { header, body, problems } = splitHeader(path, text)
  const resolutions = body.flatMap((line) => {
    const match = RESOLUTION.exec(line)
    if (!match) return []
    const [, label = '', title = ''] = match
    return [
      {
        resolution: label === '?' ? ('open' as const) : (label as Resolution),
        title: title.trim(),
      },
    ]
  })
  return {
    summary: {
      path,
      round: header.round ?? round,
      ...(header.consolidator === undefined ? {} : { consolidator: header.consolidator }),
      ...(header.commit === undefined ? {} : { commit: header.commit }),
      resolutions,
    },
    problems,
  }
}

function findingsOf(body: readonly string[]): Finding[] {
  const findings: Finding[] = []
  for (const line of body) {
    const heading = FINDING.exec(line)
    if (heading) {
      const [, severity = 'info', title = ''] = heading
      findings.push({ severity: severity as Severity, title: title.trim() })
    } else {
      const current = findings.at(-1)
      if (current) Object.assign(current, detailOf(line))
    }
  }
  return findings
}

/** `- Файл: path:line` and `- Зона: id` under a finding. */
function detailOf(line: string): Partial<Finding> {
  const file = FILE_LINE.exec(line)
  if (file?.[1] !== undefined) {
    return file[2] === undefined ? { file: file[1] } : { file: file[1], line: Number(file[2]) }
  }
  const zone = ZONE_LINE.exec(line)
  return zone?.[1] === undefined ? {} : { zone: zone[1] }
}

function splitHeader(
  path: string,
  text: string
): { header: Partial<z.infer<typeof headerSchema>>; body: string[]; problems: Problem[] } {
  const lines = text.split(/\r?\n/)
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  if (end === -1) {
    return { header: {}, body: lines, problems: [error('нет заголовка --- … ---', { file: path })] }
  }
  const parsed = headerSchema.safeParse(parseDocument(lines.slice(1, end).join('\n')).toJS())
  return {
    header: parsed.success ? parsed.data : {},
    body: withoutComments(lines.slice(end + 1)),
    problems: parsed.success ? [] : [error('заголовок не по формату', { file: path })],
  }
}

/** HTML comments hold the instructions and the example of the templates: never findings. */
function withoutComments(lines: readonly string[]): string[] {
  return lines
    .join('\n')
    .replaceAll(/<!--[\s\S]*?-->/g, '')
    .split('\n')
}

function roundOf(audit: CheckpointAudit, round: number): AuditRound {
  let entry = audit.rounds.find((candidate) => candidate.round === round)
  if (!entry) {
    entry = { round, reports: [] }
    audit.rounds.push(entry)
  }
  return entry
}
