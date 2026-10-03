import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { draftZones, renderDraft } from '../core/init-draft.js'
import { MANIFEST_PATH } from '../core/manifest.js'
import { listFiles } from '../workspace/git.js'
import { installHooks } from '../workspace/hooks.js'
import { ensureCacheIgnored } from '../workspace/project.js'

import { type CommandResult, EXIT, result } from './result.js'

/** Creates `.beacons/` with a draft zone map and connects the git hooks. Safe to re-run. */
export function init(root: string): CommandResult {
  const lines: string[] = []
  const manifestFile = path.join(root, MANIFEST_PATH)
  let draftedZones: string[] = []

  if (existsSync(manifestFile)) {
    lines.push(`• ${MANIFEST_PATH} уже есть — не трогаю`)
  } else {
    const zones = draftZones(listFiles(root))
    draftedZones = zones.map((zone) => zone.id)
    mkdirSync(path.dirname(manifestFile), { recursive: true })
    writeFileSync(manifestFile, renderDraft(zones))
    lines.push(
      zones.length > 0
        ? `✓ ${MANIFEST_PATH}: черновик из ${String(zones.length)} зон по структуре папок — отредактируйте его`
        : `✓ ${MANIFEST_PATH}: пустая карта с примером — добавьте зоны`
    )
  }
  ensureCacheIgnored(root)

  const hooks = installHooks(root)
  const where = hooks.mode === 'husky' ? '.husky' : 'git hooks'
  if (hooks.installed.length > 0) lines.push(`✓ Хуки (${where}): ${hooks.installed.join(', ')}`)
  if (hooks.alreadyInstalled.length > 0) {
    lines.push(`• Уже подключены: ${hooks.alreadyInstalled.join(', ')}`)
  }
  for (const manual of hooks.manual) {
    lines.push(
      `⚠ ${path.relative(root, manual.file)} — чужой хук, добавьте в него строку:`,
      `    ${manual.line}`
    )
  }
  lines.push('Дальше: beacon status — покрытие и папки без зон; beacon check — проверка разметки')

  return result(EXIT.ok, lines, { manifest: MANIFEST_PATH, draftedZones, hooks })
}
