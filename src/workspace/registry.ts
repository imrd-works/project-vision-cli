import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { isMap, isSeq, parseDocument } from 'yaml'

import type { Manifest } from '../core/manifest.js'
import {
  type ArchException,
  EXCEPTIONS_PATH,
  parseRegistry,
  type Registry,
  RULES_PATH,
} from '../core/registry.js'

/** The registry of the working tree: `.beacons/rules.yml` and `.beacons/exceptions.yml`. */
export function loadRegistry(root: string, manifest: Manifest | undefined): Registry {
  return parseRegistry(
    { rules: read(root, RULES_PATH), exceptions: read(root, EXCEPTIONS_PATH) },
    manifest
  )
}

/**
 * Appends an exception to `.beacons/exceptions.yml`, keeping the file's comments and layout;
 * returns an error message, or undefined.
 */
export function appendException(root: string, exception: ArchException): string | undefined {
  const file = path.join(root, EXCEPTIONS_PATH)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : 'version: 1\nexceptions:\n'
  const document = parseDocument(text)
  if (document.errors.length > 0) return `${EXCEPTIONS_PATH}: YAML с ошибками — поправьте файл`
  if (!isMap(document.contents)) return `${EXCEPTIONS_PATH}: ожидается version и exceptions`
  const list = document.get('exceptions')
  const entry = document.createNode(withoutEmpty(exception))
  if (isSeq(list)) list.add(entry)
  else document.set('exceptions', document.createNode([withoutEmpty(exception)]))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, document.toString({ lineWidth: 100 }))
  return undefined
}

/** Empty lists and absent fields stay out of the file. */
function withoutEmpty(exception: ArchException): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(exception).filter(
      ([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)
    )
  )
}

function read(root: string, file: string): string | undefined {
  const absolute = path.join(root, file)
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined
}
