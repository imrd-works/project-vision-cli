import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ArchException } from '../core/registry.js'

import { appendException, loadRegistry } from './registry.js'

const exception: ArchException = {
  id: 'legacy',
  rule: 'layers',
  zones: ['web'],
  paths: [],
  reason: 'Old code',
  author: 'ann@x.io',
  date: '2026-10-05',
}

describe('the registry file', () => {
  let root: string
  const file = () => path.join(root, '.beacons/exceptions.yml')

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'beacon-registry-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the file and keeps comments of an existing one', () => {
    expect(appendException(root, exception)).toBeUndefined()
    expect(readFileSync(file(), 'utf8')).toContain('- id: legacy')
    expect(readFileSync(file(), 'utf8')).not.toContain('paths')

    writeFileSync(file(), '# agreed deviations\nversion: 1\n')
    expect(appendException(root, { ...exception, id: 'second' })).toBeUndefined()
    const text = readFileSync(file(), 'utf8')
    expect(text).toContain('# agreed deviations')
    expect(text).toContain('- id: second')
    expect(loadRegistry(root, undefined).exceptions.map((entry) => entry.id)).toEqual(['second'])
  })

  it('refuses to edit a broken file', () => {
    expect(appendException(root, exception)).toBeUndefined()
    writeFileSync(file(), 'version: [\n')
    expect(appendException(root, exception)).toContain('YAML с ошибками')
    writeFileSync(file(), '- just a list\n')
    expect(appendException(root, exception)).toContain('ожидается version и exceptions')
  })
})
