import { stringify } from 'yaml'

import { byText } from './text.js'
import { validateZoneId } from './zone-id.js'

/**
 * Drafts a zone map from the folder structure. Folders that usually hold one piece of
 * functionality — Nest/DDD modules, FSD slices — become zones. Slices with the same name in
 * different FSD layers (pages/login, features/login) become one zone with several paths:
 * a zone is functionality, not a folder.
 */
const FEATURE_FOLDERS = new Set(['modules', 'domains', 'features', 'widgets', 'pages', 'entities'])

export interface DraftZone {
  id: string
  title: string
  paths: string[]
}

export function draftZones(files: readonly string[]): DraftZone[] {
  const zones = new Map<string, Set<string>>()
  for (const file of files) {
    const folder = featureFolder(file)
    if (!folder) continue
    const id = toZoneId(folder.name)
    if (validateZoneId(id)) continue
    zones.set(id, (zones.get(id) ?? new Set()).add(`${folder.path}/**`))
  }
  return [...zones]
    .map(([id, paths]) => ({ id, title: id, paths: [...paths].toSorted(byText) }))
    .toSorted((a, b) => a.id.localeCompare(b.id))
}

const HEADER = `# Карта зон: какие зоны есть в проекте и какие пути они покрывают.
# Спецификация: https://github.com/imrd-works/project-vision-cli/blob/main/docs/beacon-format.md
#
# Черновик собран по структуре папок — переименуйте зоны по смыслу (зона — это
# функциональность, а не папка), объедините лишние, добавьте теги аудита и запланированные
# зоны из ТЗ. Подзоны задаются точкой: home.hero — подзона home.
`

const EXAMPLE = `
# Пример:
#
# zones:
#   auth.session:
#     title: Вход и сессии
#     paths: [src/modules/auth/**]
#   auth.passwords:
#     title: Хранение паролей
#     tags: [security]
`

export function renderDraft(zones: readonly DraftZone[]): string {
  if (zones.length === 0) return `${HEADER}\nversion: 1\n\nzones: {}\n${EXAMPLE}`
  const body = Object.fromEntries(
    zones.map((zone) => [zone.id, { title: zone.title, paths: zone.paths }])
  )
  return `${HEADER}\n${stringify({ version: 1, zones: body }, { lineWidth: 0 })}`
}

function featureFolder(file: string): { name: string; path: string } | undefined {
  const segments = file.split('/')
  const layer = segments.findIndex((segment) => FEATURE_FOLDERS.has(segment))
  // The slice is the folder right below the layer, and the file must be inside it.
  if (layer === -1 || layer + 2 >= segments.length) return undefined
  const name = segments[layer + 1] ?? ''
  return { name, path: segments.slice(0, layer + 2).join('/') }
}

function toZoneId(name: string): string {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}
