import type { IndexedZone, ProjectIndex } from './project-index.js'
import { isAncestorOrSelf } from './zone-id.js'

/**
 * An audit context pack: everything an AI auditor needs about a topic in one Markdown document —
 * the zones of a tag or a zone branch, their files and the code of their regions. The model reads
 * this instead of crawling the repository.
 */

export interface ZoneFilter {
  tag?: string | undefined
  /** A zone together with its subzones. */
  zone?: string | undefined
}

export interface AuditOptions extends ZoneFilter {
  includeTests: boolean
  /** False: paths and line ranges only, no code. */
  code: boolean
}

export interface AuditSource {
  project: string
  index: ProjectIndex
  /** File content by repository-relative path; undefined when unreadable or binary. */
  read: (file: string) => string | undefined
  date: string
}

/** Lines of a whole file shown before it is cut. */
const MAX_FILE_LINES = 400
/** Lines shown around a region for context. */
const REGION_CONTEXT = 3

export function selectZones(index: ProjectIndex, filter: ZoneFilter): IndexedZone[] {
  return index.zones.filter(
    (zone) =>
      (filter.tag === undefined || zone.tags.includes(filter.tag)) &&
      (filter.zone === undefined || isAncestorOrSelf(filter.zone, zone.id))
  )
}

export function isTestFile(file: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|tests?|e2e|spec)\//.test(file) ||
    /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/.test(file)
  )
}

export function renderAuditPack(source: AuditSource, options: AuditOptions): string {
  const zones = selectZones(source.index, options)
    .map((zone) => withoutTests(zone, options.includeTests))
    .filter((zone) => zone.files.length > 0 || zone.regions.length > 0 || zone.state === 'planned')
  const files = new Set(zones.flatMap((zone) => zone.files)).size
  const regions = zones.reduce((sum, zone) => sum + zone.regions.length, 0)

  const lines = [
    `# Аудит: ${scopeLabel(options)} — ${source.project}`,
    '',
    `Собрано beacon ${source.date}: зон — ${String(zones.length)}, файлов — ${String(files)}, ` +
      `фрагментов — ${String(regions)}. Тесты ${options.includeTests ? 'включены' : 'исключены'}.`,
    '',
    'Ниже — весь код, размеченный маяками выбранных зон: для этой темы остальной репозиторий',
    'читать не нужно. Пути указаны от корня репозитория.',
    '',
  ]
  if (zones.length === 0) return [...lines, 'Подходящих зон нет.', ''].join('\n')

  lines.push(...zoneTable(zones))
  const shown = new Map<string, string>()
  for (const zone of zones) lines.push(...zoneSection(zone, source, options, shown))
  return lines.join('\n')
}

function withoutTests(zone: IndexedZone, includeTests: boolean): IndexedZone {
  if (includeTests) return zone
  return {
    ...zone,
    files: zone.files.filter((file) => !isTestFile(file)),
    regions: zone.regions.filter((region) => !isTestFile(region.file)),
  }
}

function scopeLabel({ tag, zone }: ZoneFilter): string {
  const parts = [
    ...(tag === undefined ? [] : [`тег ${tag}`]),
    ...(zone === undefined ? [] : [`зона ${zone}`]),
  ]
  return parts.length > 0 ? parts.join(', ') : 'все зоны'
}

function zoneTable(zones: readonly IndexedZone[]): string[] {
  return [
    '| Зона | Название | Теги | Файлы | Фрагменты |',
    '| --- | --- | --- | --- | --- |',
    ...zones.map(
      (zone) =>
        `| \`${zone.id}\` | ${zone.title} | ${zone.tags.join(', ')} | ${String(zone.files.length)} | ${String(zone.regions.length)} |`
    ),
    '',
  ]
}

function zoneSection(
  zone: IndexedZone,
  source: AuditSource,
  options: AuditOptions,
  shown: Map<string, string>
): string[] {
  const lines = [`## \`${zone.id}\` — ${zone.title}`, '', ...zoneAbout(zone)]

  for (const file of zone.files) {
    lines.push(`### ${file}`, '')
    const earlier = shown.get(file)
    if (earlier !== undefined) lines.push(`_Приведён выше, в зоне \`${earlier}\`._`, '')
    else if (options.code) lines.push(...codeBlock(file, source.read(file), undefined))
    shown.set(file, earlier ?? zone.id)
  }
  for (const region of zone.regions) {
    lines.push(
      `### ${region.file} · строки ${String(region.start)}–${String(region.end)} (регион)`,
      ''
    )
    if (options.code) lines.push(...codeBlock(region.file, source.read(region.file), region))
  }
  return lines
}

function zoneAbout(zone: IndexedZone): string[] {
  const about = [
    ...(zone.tags.length > 0 ? [`Теги: ${zone.tags.join(', ')}.`] : []),
    ...(zone.description ? [zone.description] : []),
    ...(zone.state === 'planned' ? ['Зона запланирована: кода пока нет.'] : []),
  ]
  return about.length > 0 ? [...about, ''] : []
}

function codeBlock(
  file: string,
  content: string | undefined,
  region: { start: number; end: number } | undefined
): string[] {
  if (content === undefined) return ['_Файл недоступен для чтения._', '']
  const all = content.replace(/\n$/, '').split('\n')
  let body: string[]
  let note: string | undefined
  if (region) {
    const from = Math.max(1, region.start - REGION_CONTEXT)
    const to = Math.min(all.length, region.end + REGION_CONTEXT)
    body = all.slice(from - 1, to)
    note = `Строки ${String(from)}–${String(to)}, с контекстом.`
  } else {
    body = all.slice(0, MAX_FILE_LINES)
    if (all.length > MAX_FILE_LINES) {
      note = `Показаны первые ${String(MAX_FILE_LINES)} строк из ${String(all.length)}.`
    }
  }
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1))
  return [fence + language(file), ...body, fence, ...(note ? ['', `_${note}_`] : []), '']
}

function longestBacktickRun(lines: readonly string[]): number {
  return Math.max(0, ...lines.flatMap((line) => [...line.matchAll(/`+/g)].map((m) => m[0].length)))
}

const LANGUAGES: Record<string, string> = {
  mjs: 'js',
  cjs: 'js',
  mts: 'ts',
  cts: 'ts',
  yml: 'yaml',
  htm: 'html',
  sh: 'bash',
  zsh: 'bash',
  md: 'markdown',
}

function language(file: string): string {
  const name = file.split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  const extension = name.slice(dot + 1).toLowerCase()
  return LANGUAGES[extension] ?? extension
}
