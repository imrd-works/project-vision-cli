import { describe, expect, it } from 'vitest'

import { parseManifest } from './manifest.js'
import {
  coveringException,
  exceptionsOfZone,
  namingViolations,
  parseRegistry,
  rulesOfZone,
} from './registry.js'

const manifest = (() => {
  const parsed = parseManifest(
    'version: 1\nzones:\n  web:\n    title: Web\n  web.profile:\n    title: Profile\n  api:\n    title: API\n'
  )
  if (!parsed.ok) throw new Error('bad manifest')
  return parsed.manifest
})()

const RULES = `version: 1
rules:
  fsd-layers:
    title: FSD layers
    kind: architecture
    zones: [web]
    validatorRules: [boundaries/*]
  ui-names:
    title: Components in PascalCase
    kind: naming
    naming:
      - paths: [src/**/ui/*.tsx]
        pattern: ^[A-Z]
  api-shape:
    title: REST resources
    kind: api
    zones: [api]
`

const EXCEPTIONS = `version: 1
exceptions:
  - id: legacy-profile
    rule: fsd-layers
    zones: [web.profile]
    reason: The old profile imports a widget until the rewrite
    raw: ну там короче старый профиль, перепишем потом
    author: bob@example.com
    date: 2026-10-05
  - id: lower-case-icons
    rule: ui-names
    paths: [src/shared/ui/icons.tsx]
    reason: Icons are generated
    author: ann@example.com
    date: 2026-10-05
`

describe('registry', () => {
  it('reads rules and exceptions against the zone map', () => {
    const registry = parseRegistry({ rules: RULES, exceptions: EXCEPTIONS }, manifest)

    expect(registry.problems).toEqual([])
    expect(registry.rules.map((rule) => [rule.id, rule.kind])).toEqual([
      ['fsd-layers', 'architecture'],
      ['ui-names', 'naming'],
      ['api-shape', 'api'],
    ])
    expect(rulesOfZone(registry.rules, 'web.profile').map((rule) => rule.id)).toEqual([
      'fsd-layers',
      'ui-names',
    ])
    expect(exceptionsOfZone(registry.exceptions, 'web').map((e) => e.id)).toEqual([
      'legacy-profile',
    ])
    expect(parseRegistry({}, manifest)).toEqual({ rules: [], exceptions: [], problems: [] })
  })

  it('names what is wrong in the registry', () => {
    const registry = parseRegistry(
      {
        rules: `version: 1\nrules:\n  bad:\n    title: Bad\n    zones: [nowhere]\n    naming:\n      - paths: ['*']\n        pattern: '('\n`,
        exceptions: `version: 1\nexceptions:\n  - id: x\n    rule: missing\n    reason: why\n    author: a@b.c\n    date: 2026-10-05\n  - id: x\n    rule: bad\n    zones: [ghost]\n    reason: why\n    author: a@b.c\n    date: 2026-10-05\n`,
      },
      manifest
    )
    expect(registry.problems.map((problem) => problem.message)).toEqual([
      'правило "bad": некорректный шаблон "("',
      'правило "bad": зоны "nowhere" нет в zones.yml',
      'исключение "x": правила "missing" нет в rules.yml',
      'исключение "x": укажите zones или paths — к чему оно относится',
      'исключение "x" указано дважды',
      'исключение "x": зоны "ghost" нет в zones.yml',
    ])
    expect(parseRegistry({ rules: 'version: 2\n' }, undefined).problems).toHaveLength(1)
    expect(parseRegistry({ exceptions: 'a: [' }, undefined).problems[0]?.message).toMatch(/^YAML/)
  })

  it('checks file names and finds the exception that covers a deviation', () => {
    const registry = parseRegistry({ rules: RULES, exceptions: EXCEPTIONS }, manifest)
    const files = ['src/shared/ui/Button.tsx', 'src/shared/ui/icons.tsx', 'src/web/ui/card.tsx']

    const naming = namingViolations(registry.rules, files)
    expect(naming.map((violation) => violation.file)).toEqual([
      'src/shared/ui/icons.tsx',
      'src/web/ui/card.tsx',
    ])
    expect(
      coveringException(registry, { rule: 'ui-names', file: 'src/shared/ui/icons.tsx', zones: [] })
        ?.id
    ).toBe('lower-case-icons')
    expect(
      coveringException(registry, { rule: 'ui-names', file: 'src/web/ui/card.tsx', zones: [] })
    ).toBeUndefined()

    // A validator's finding is matched through the rule that names that validator rule.
    const finding = { validatorRule: 'boundaries/element-types', zones: ['web.profile'] }
    expect(coveringException(registry, finding)?.id).toBe('legacy-profile')
    expect(coveringException(registry, { ...finding, zones: ['web'] })).toBeUndefined()
    expect(coveringException(registry, { ...finding, validatorRule: 'no-console' })).toBeUndefined()
  })
})
