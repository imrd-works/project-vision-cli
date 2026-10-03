import { describe, expect, it } from 'vitest'

import { parseDirective, parseMarkup } from './markup.js'

const ids = (text: string, file = 'src/a.ts') =>
  parseMarkup(text, file).fileBeacons.map((beacon) => beacon.id)

describe('parseDirective', () => {
  it('reads both forms and several zones', () => {
    expect(parseDirective('@beacon auth.session auth.passwords')).toEqual([
      'auth.session',
      'auth.passwords',
    ])
    expect(parseDirective('[BEACON: a] [BEACON: b c]')).toEqual(['a', 'b', 'c'])
    expect(parseDirective('[BEACON: a] — пояснение')).toEqual(['a'])
  })

  it('ignores text that only looks like a beacon', () => {
    expect(parseDirective('@beacons are cool')).toBeUndefined()
    expect(parseDirective('see @beacon a')).toBeUndefined()
    expect(parseDirective('beacon: a')).toBeUndefined()
  })
})

describe('parseMarkup', () => {
  it('finds file beacons in comments of the file type', () => {
    expect(ids('// @beacon home.hero\nexport {}')).toEqual(['home.hero'])
    expect(ids('# [BEACON: payments]', 'app/main.py')).toEqual(['payments'])
    expect(ids('<!-- @beacon home.hero -->', 'src/Hero.vue')).toEqual(['home.hero'])
    expect(ids('/* @beacon home.pricing */', 'src/pricing.css')).toEqual(['home.pricing'])
    expect(ids('-- @beacon reports', 'db/report.sql')).toEqual(['reports'])
  })

  it('accepts a beacon only when the comment starts the line and the text', () => {
    expect(ids('const a = 1 // @beacon x')).toEqual([])
    expect(ids('// see @beacon x')).toEqual([])
    expect(ids('# @beacon x', 'src/a.ts')).toEqual([])
  })

  it('does not treat code samples in Markdown as beacons', () => {
    const text = '<!-- @beacon docs -->\n```ts\n// @beacon sample\n```\n<!-- [BEACON: other] -->'
    expect(ids(text, 'README.md')).toEqual(['docs', 'other'])
  })

  it('warns about beacons in JSDoc blocks and skips them', () => {
    const markup = parseMarkup('/** @beacon auth */\nexport {}', 'src/a.ts')
    expect(markup.fileBeacons).toEqual([])
    expect(markup.problems).toEqual([expect.objectContaining({ severity: 'warning', line: 1 })])
  })

  it('reports invalid and reserved IDs', () => {
    const markup = parseMarkup('// @beacon Bad_Id completed ok', 'src/a.ts')
    expect(markup.fileBeacons.map((b) => b.id)).toEqual(['ok'])
    expect(markup.problems).toHaveLength(2)
  })

  it('reads beacon regions with nesting and plain regions', () => {
    const text = [
      '// #region @beacon security.http', // 1
      'a()', // 2
      '// #region helpers', // 3
      'b()', // 4
      '// #endregion', // 5
      '// #endregion security.http', // 6
      '# region not a ts comment', // 7
    ].join('\n')
    const markup = parseMarkup(text, 'src/app.ts')
    expect(markup.regions).toEqual([{ ids: ['security.http'], start: 1, end: 6 }])
    expect(markup.fileBeacons).toEqual([])
    expect(markup.problems).toEqual([])
  })

  it('supports `#region` in hash-comment languages', () => {
    const markup = parseMarkup('#region [BEACON: jobs]\nrun()\n# endregion', 'tasks.py')
    expect(markup.regions).toEqual([{ ids: ['jobs'], start: 1, end: 3 }])
  })

  it('reports unbalanced beacon regions', () => {
    const unclosed = parseMarkup('// #region @beacon a\nx()\n', 'src/a.ts')
    expect(unclosed.regions).toEqual([{ ids: ['a'], start: 1, end: 3 }])
    expect(unclosed.problems[0]?.message).toContain('не закрыт')

    const stray = parseMarkup('// #region @beacon a\n// #endregion\n// #endregion', 'src/a.ts')
    expect(stray.problems[0]).toMatchObject({ line: 3 })
  })

  it('ignores unbalanced plain regions', () => {
    expect(parseMarkup('// #endregion\n// @beacon a', 'src/a.ts').problems).toEqual([])
  })
})
