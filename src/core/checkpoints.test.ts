import { describe, expect, it } from 'vitest'

import { parseCheckpoints } from './checkpoints.js'
import { parseManifest } from './manifest.js'

const manifestResult = parseManifest(
  'version: 1\nzones:\n  ui.button:\n    title: Button\n    formerly: [button]\n  ui.input:\n    title: Input\n'
)
if (!manifestResult.ok) throw new Error('invalid test manifest')
const manifest = manifestResult.manifest

const PLAN = `
version: 1
line: frontend
title: Фронтенд
checkpoints:
  ui-kit:
    title: UI kit
    deadline: 2026-10-20
    items:
      - zone: button
        owner: ann@x.io
      - id: design
        check: Approved by the designer
        done: { date: 2026-10-05, by: lead@x.io }
  pages:
    title: Pages
    after: [ui-kit]
    dependsOn: [backend:auth-api]
    items:
      - zone: ui.input
`

describe('parseCheckpoints', () => {
  it('reads the plan in file order and normalizes former zone IDs', () => {
    const result = parseCheckpoints(PLAN, manifest)
    if (!result.ok) throw new Error(JSON.stringify(result.problems))
    expect(result.plan).toMatchObject({ line: 'frontend', title: 'Фронтенд' })
    expect(result.plan.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(['ui-kit', 'pages'])
    expect(result.plan.checkpoints[0]?.items[0]).toEqual({ zone: 'ui.button', owner: 'ann@x.io' })
    expect(result.plan.checkpoints[1]).toMatchObject({ dependsOn: ['backend:auth-api'], debts: [] })
  })

  it.each([
    ['YAML syntax', 'version: 1\nline: [', 'YAML'],
    [
      'missing items',
      'version: 1\nline: a\ncheckpoints:\n  x:\n    title: X\n    items: []',
      'пункт',
    ],
    [
      'bad date',
      'version: 1\nline: a\ncheckpoints:\n  x:\n    title: X\n    deadline: 20.10.2026\n    items:\n      - zone: ui.input',
      'ГГГГ-ММ-ДД',
    ],
    [
      'unknown zone',
      'version: 1\nline: a\ncheckpoints:\n  x:\n    title: X\n    items:\n      - zone: ghost',
      'зоны "ghost"',
    ],
    [
      'unknown after',
      'version: 1\nline: a\ncheckpoints:\n  x:\n    title: X\n    after: [y]\n    items:\n      - zone: ui.input',
      'after "y"',
    ],
    [
      'duplicate item',
      'version: 1\nline: a\ncheckpoints:\n  x:\n    title: X\n    items:\n      - { id: a, check: A }\n      - { id: a, check: B }',
      'пункт "a" указан дважды',
    ],
    [
      'conditional close without debt',
      'version: 1\nline: a\ncheckpoints:\n  x:\n    title: X\n    closed: { date: 2026-10-01, conditional: true }\n    items:\n      - zone: ui.input',
      'требует хотя бы одного техдолга',
    ],
  ])('rejects %s', (_, text, fragment) => {
    const result = parseCheckpoints(text, manifest)
    const problems = result.ok ? [] : result.problems
    expect(problems.map((p) => p.message).join('\n')).toContain(fragment)
    expect(problems[0]).toMatchObject({ file: '.beacons/checkpoints.yml' })
  })
})
