import type { AuditReport, Finding } from './audit.js'

/**
 * Starting points of the audit files: a report an auditor (or their model) fills in, and the
 * summary of a round with every finding waiting for its resolution.
 */

export interface ReportTemplate {
  /** `line:id`. */
  checkpoint: string
  title: string
  round: number
  author: string
  model?: string | undefined
  commit?: string | undefined
  zones: readonly string[]
}

export function renderReportTemplate(template: ReportTemplate): string {
  return [
    '---',
    `checkpoint: ${template.checkpoint}`,
    `round: ${String(template.round)}`,
    `author: ${template.author}`,
    ...(template.model === undefined ? [] : [`model: ${template.model}`]),
    // Quoted: a SHA of digits only would be a number to YAML.
    ...(template.commit === undefined ? [] : [`commit: '${template.commit}'`]),
    '---',
    '',
    `# Аудит ${template.checkpoint} «${template.title}» — раунд ${String(template.round)}`,
    '',
    '<!--',
    'Проверьте весь чекпоинт, не только свой модуль. Код зон чекпоинта:',
    `  beacon audit --checkpoint ${template.checkpoint.split(':').at(-1) ?? ''}   (или MCP-инструмент audit_checkpoint)`,
    `Зоны: ${template.zones.join(', ') || '—'}`,
    '',
    'Каждая находка — заголовок ### [важность] и строки Файл/Зона, затем описание:',
    '',
    '### [high] Пароль сравнивается без постоянного времени',
    '- Файл: src/auth/password.service.ts:42',
    '- Зона: auth.passwords',
    '',
    'Что не так, чем грозит, как исправить.',
    '',
    'Важность: critical, high, medium, low, info. Нет находок — оставьте раздел пустым.',
    '-->',
    '',
    '## Находки',
    '',
  ].join('\n')
}

/** Every finding of the round under `### [?]`: the consolidator decides fixed, disputed or accepted. */
export function renderSummaryTemplate(input: {
  checkpoint: string
  round: number
  consolidator: string
  reports: readonly AuditReport[]
}): string {
  return [
    '---',
    `checkpoint: ${input.checkpoint}`,
    `round: ${String(input.round)}`,
    `consolidator: ${input.consolidator}`,
    'commit: # коммит с исправлениями — по нему пойдёт следующий раунд',
    '---',
    '',
    `# Сводка раунда ${String(input.round)} — ${input.checkpoint}`,
    '',
    '<!--',
    'Замените [?] решением: [fixed] — исправлено, [disputed] — оспорено (почему),',
    '[accepted] — риск принят осознанно (почему). Одинаковые находки разных моделей сведите в одну.',
    '-->',
    '',
    ...input.reports.flatMap((report) =>
      report.findings.flatMap((finding) => [
        `### [?] ${finding.title} — ${report.author}`,
        `- Важность: ${finding.severity}${location(finding)}`,
        '',
      ])
    ),
  ].join('\n')
}

/** All findings of a round by file: what the consolidator's model reads first. */
export function renderMergedFindings(checkpoint: string, reports: readonly AuditReport[]): string {
  const byFile = new Map<string, { finding: Finding; author: string }[]>()
  for (const report of reports) {
    for (const finding of report.findings) {
      const key = finding.file ?? '(без файла)'
      byFile.set(key, [...(byFile.get(key) ?? []), { finding, author: report.author }])
    }
  }
  return [
    `# Находки ${checkpoint}: отчётов ${String(reports.length)}`,
    '',
    ...[...byFile]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .flatMap(([file, entries]) => [
        `## ${file}`,
        ...entries.map(
          ({ finding, author }) =>
            `- [${finding.severity}] ${finding.title}${finding.line === undefined ? '' : ` (строка ${String(finding.line)})`} — ${author}`
        ),
        '',
      ]),
  ].join('\n')
}

function location(finding: Finding): string {
  if (finding.file === undefined) return ''
  return ` · ${finding.file}${finding.line === undefined ? '' : `:${String(finding.line)}`}`
}
