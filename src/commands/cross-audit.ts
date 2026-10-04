import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  renderMergedFindings,
  renderReportTemplate,
  renderSummaryTemplate,
} from '../core/audit-templates.js'
import { auditPath, authorSlug, type CheckpointAudit, collectAudits } from '../core/audit.js'
import { isZoneItem, type PlannedCheckpoint } from '../core/checkpoints.js'
import { loadPlan } from '../workspace/checkpoint-file.js'
import { authorEmail, git } from '../workspace/git.js'
import { auditFiles } from '../workspace/snapshot.js'

import { type CommandResult, EXIT, formatProblem, requireProject, result } from './result.js'

/**
 * Cross-audit in the working copy: the report of this developer, the consolidator's merge and
 * the state of the audit files. Rounds and signatures are the team server's (`beacon sync`):
 * without it the round is read from the folders.
 */

export interface AuditTarget {
  root: string
  /** `id` or `line:id` of a checkpoint of this repository's line. */
  checkpoint: string
  /** The round the server opened, when known (`beacon sync`). */
  round?: number | undefined
}

interface Resolved {
  line: string
  checkpoint: PlannedCheckpoint
  ref: string
  audit: CheckpointAudit
  round: number
}

/** `beacon audit report <чп>`: a report of the current round from the template, once. */
export function auditReport(
  target: AuditTarget,
  options: { model?: string | undefined }
): CommandResult {
  const resolved = resolve(target)
  if ('failure' in resolved) return resolved.failure
  const author = authorEmail(target.root)
  if (author === undefined) return failed('Не знаю, кто вы: задайте git config user.email')
  const file = auditPath(resolved.checkpoint.id, resolved.round, authorSlug(author))
  if (existsSync(path.join(target.root, file))) {
    return result(EXIT.ok, [`• Отчёт раунда ${String(resolved.round)} уже есть: ${file}`], {
      file,
      created: false,
    })
  }
  write(
    target.root,
    file,
    renderReportTemplate({
      checkpoint: resolved.ref,
      title: resolved.checkpoint.title,
      round: resolved.round,
      author,
      model: options.model,
      commit: head(target.root),
      zones: zonesOf(resolved.checkpoint),
    })
  )
  return result(
    EXIT.ok,
    [
      `✓ Отчёт раунда ${String(resolved.round)}: ${file}`,
      `  Код зон чекпоинта для вашей модели: beacon audit --checkpoint ${resolved.checkpoint.id}`,
      '  Заполните находки, закоммитьте и запушьте — отчёт увидит вся команда.',
    ],
    { file, created: true, round: resolved.round }
  )
}

/** `beacon audit merge <чп>`: all findings of the round and a summary to fill in. */
export function auditMerge(target: AuditTarget): CommandResult {
  const found = resolve(target)
  if ('failure' in found) return found.failure
  // Without the server the merge is of the latest round with reports, summarised or not.
  const number = target.round ?? found.audit.rounds.at(-1)?.round ?? 1
  const round = found.audit.rounds.find((entry) => entry.round === number)
  if (!round || round.reports.length === 0) {
    return failed(`В раунде ${String(number)} ещё нет отчётов`)
  }
  const file = auditPath(found.checkpoint.id, number, 'summary')
  const created = round.summary === undefined
  if (created) {
    const consolidator = authorEmail(target.root) ?? ''
    const reports = round.reports
    write(
      target.root,
      file,
      renderSummaryTemplate({ checkpoint: found.ref, round: number, consolidator, reports })
    )
  }
  return result(
    EXIT.ok,
    [
      renderMergedFindings(found.ref, round.reports),
      created ? `✓ Сводка для решений: ${file}` : `• Сводка уже есть: ${file}`,
    ],
    { file, created, reports: round.reports.length }
  )
}

/** `beacon audit status <чп>`: rounds in the files — reports, findings, the summary. */
export function auditStatus(target: AuditTarget): CommandResult {
  const resolved = resolve(target)
  if ('failure' in resolved) return resolved.failure
  const { audit, ref } = resolved
  const lines = [
    `Кросс-аудит ${ref} «${resolved.checkpoint.title}» — раунд ${String(resolved.round)}`,
    ...audit.rounds.flatMap((round) => [
      `  Раунд ${String(round.round)}: отчётов ${String(round.reports.length)}`,
      ...round.reports.map(
        (report) =>
          `    • ${report.author}${report.model ? ` (${report.model})` : ''} — находок: ${String(report.findings.length)}`
      ),
      ...(round.summary ? [`    ✎ сводка: ${describeSummary(round.summary.resolutions)}`] : []),
    ]),
    ...audit.problems.map((problem) => `  ${formatProblem(problem)}`),
  ]
  if (audit.rounds.length === 0)
    lines.push(`  Отчётов пока нет: beacon audit report ${resolved.checkpoint.id}`)
  return result(EXIT.ok, lines, { checkpoint: ref, round: resolved.round, rounds: audit.rounds })
}

/** The zones a checkpoint's audit covers: its zone items. */
export function zonesOf(checkpoint: PlannedCheckpoint): string[] {
  return checkpoint.items.flatMap((item) => (isZoneItem(item) ? [item.zone] : []))
}

/** The checkpoint of this repository's line, by `id` or `line:id`. */
export function findCheckpoint(
  root: string,
  name: string
): { line: string; checkpoint: PlannedCheckpoint } | { failure: CommandResult } {
  const loaded = requireProject(root)
  if ('failure' in loaded) return loaded
  const plan = loadPlan(root, loaded.project.manifest)
  if (!plan?.ok) return { failure: failed('Нет плана чекпоинтов — .beacons/checkpoints.yml') }
  const [line, id] = name.includes(':') ? name.split(':', 2) : [plan.plan.line, name]
  const checkpoint = plan.plan.checkpoints.find((entry) => entry.id === id)
  if (line !== plan.plan.line || !checkpoint) {
    return { failure: failed(`Чекпоинта ${name} нет в линии ${plan.plan.line}`) }
  }
  return { line: plan.plan.line, checkpoint }
}

function resolve(target: AuditTarget): Resolved | { failure: CommandResult } {
  const found = findCheckpoint(target.root, target.checkpoint)
  if ('failure' in found) return found
  const audit = collectAudits(auditFiles(target.root)).get(found.checkpoint.id) ?? {
    checkpoint: found.checkpoint.id,
    rounds: [],
    problems: [],
  }
  return {
    ...found,
    ref: `${found.line}:${found.checkpoint.id}`,
    audit,
    round: target.round ?? localRound(audit),
  }
}

/** Without the server: the latest round in the folders, the next one once it has a summary. */
function localRound(audit: CheckpointAudit): number {
  const latest = audit.rounds.at(-1)
  if (!latest) return 1
  return latest.summary ? latest.round + 1 : latest.round
}

function describeSummary(resolutions: readonly { resolution: string }[]): string {
  const count = (label: string): number => resolutions.filter((r) => r.resolution === label).length
  return `исправлено ${String(count('fixed'))}, оспорено ${String(count('disputed'))}, риск принят ${String(count('accepted'))}, без решения ${String(count('open'))}`
}

function head(root: string): string | undefined {
  try {
    return git(root, ['rev-parse', '--short', 'HEAD']).trim()
  } catch {
    return undefined
  }
}

function write(root: string, file: string, text: string): void {
  const absolute = path.join(root, file)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, text)
}

function failed(message: string): CommandResult {
  return result(EXIT.failed, [`✖ ${message}`], { error: message })
}
