import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { commentStyleFor, insertFileBeacon } from '../core/comment-style.js'
import { MANIFEST_PATH, resolveZoneId } from '../core/manifest.js'
import { parseMarkup } from '../core/markup.js'

import { type CommandResult, EXIT, requireProject, result } from './result.js'

/** Puts a file beacon for `zoneId` into `file` (relative to the repository root). */
export function mark(root: string, file: string, zoneId: string): CommandResult {
  const loaded = requireProject(root)
  if ('failure' in loaded) return loaded.failure
  const { project } = loaded

  const zone = resolveZoneId(project.manifest, zoneId)
  if (zone === undefined) {
    return fail(`Зоны "${zoneId}" нет в ${MANIFEST_PATH} — сначала добавьте её туда`)
  }
  const absolute = path.join(root, file)
  if (!existsSync(absolute)) return fail(`Файл не найден: ${file}`)
  const style = commentStyleFor(file)
  if (!style) {
    return fail(`Не знаю, как писать комментарии в ${file} — добавьте файл в paths зоны "${zone}"`)
  }

  const text = readFileSync(absolute, 'utf8')
  const byPath = project.resolver(file)
  const inFile = parseMarkup(text, file).fileBeacons.some(
    (beacon) => resolveZoneId(project.manifest, beacon.id) === zone
  )
  if ((byPath.kind === 'zone' && byPath.zone === zone) || inFile) {
    return result(EXIT.ok, [`${file} уже в зоне ${zone}`], { file, zone, changed: false })
  }

  writeFileSync(absolute, insertFileBeacon(text, style, [zone]))
  const renamed =
    zone === zoneId ? [] : [`⚠ "${zoneId}" — прежнее имя зоны, записан текущий ID "${zone}"`]
  return result(EXIT.ok, [...renamed, `✓ ${file}: добавлен маяк зоны ${zone}`], {
    file,
    zone,
    changed: true,
  })
}

function fail(message: string): CommandResult {
  return result(EXIT.failed, [`✖ ${message}`], { error: message })
}
