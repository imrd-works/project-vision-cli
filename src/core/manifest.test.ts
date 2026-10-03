import { describe, expect, it } from 'vitest'

import { type Manifest, parseManifest, resolveZoneId } from './manifest.js'

function load(text: string): Manifest {
  const result = parseManifest(text)
  if (!result.ok) throw new Error(JSON.stringify(result.problems))
  return result.manifest
}

const MAP = `
version: 1
zones:
  payments:
    title: Оплата
    tags: [security, pci]
    paths: [src/modules/payments/**]
  payments.checkout:
    title: Оформление
    tags: [ux]
    formerly: [checkout]
  home.hero:
    title: Первый экран
`

describe('parseManifest', () => {
  it('reads zones with inherited tags and defaults', () => {
    const manifest = load(MAP)
    expect(manifest.zones.get('payments.checkout')).toMatchObject({
      ownTags: ['ux'],
      tags: ['pci', 'security', 'ux'],
      paths: [],
    })
    // An undeclared parent passes no tags.
    expect(manifest.zones.get('home.hero')?.tags).toEqual([])
  })

  it('resolves former IDs to the current zone', () => {
    const manifest = load(MAP)
    expect(resolveZoneId(manifest, 'checkout')).toBe('payments.checkout')
    expect(resolveZoneId(manifest, 'payments')).toBe('payments')
    expect(resolveZoneId(manifest, 'nope')).toBeUndefined()
  })

  it('accepts an empty zone map', () => {
    expect(load('version: 1\nzones:\n').zones.size).toBe(0)
  })

  it.each([
    ['YAML syntax', 'version: 1\nzones: [', 'YAML'],
    ['unknown version', 'version: 2\nzones: {}', 'version'],
    ['unknown field', 'version: 1\nzones:\n  a:\n    title: A\n    owner: me', 'owner'],
    ['missing title', 'version: 1\nzones:\n  a:\n    paths: [x]', 'title'],
    ['bad tag', 'version: 1\nzones:\n  a:\n    title: A\n    tags: [Sec]', 'тег'],
    ['bad ID', 'version: 1\nzones:\n  Auth:\n    title: A', 'некорректный ID'],
    ['reserved ID', 'version: 1\nzones:\n  completed:\n    title: A', 'зарезервированное'],
    [
      'formerly equal to a live zone',
      'version: 1\nzones:\n  a:\n    title: A\n  b:\n    title: B\n    formerly: [a]',
      'совпадает',
    ],
    [
      'formerly used twice',
      'version: 1\nzones:\n  a:\n    title: A\n    formerly: [x]\n  b:\n    title: B\n    formerly: [x]',
      'у двух зон',
    ],
    ['invalid formerly', 'version: 1\nzones:\n  a:\n    title: A\n    formerly: [X]', 'formerly'],
  ])('rejects %s', (_, text, fragment) => {
    const result = parseManifest(text)
    const problems = result.ok ? [] : result.problems
    expect(problems.map((p) => p.message).join('\n')).toContain(fragment)
    expect(problems[0]).toMatchObject({ file: '.beacons/zones.yml' })
  })
})
