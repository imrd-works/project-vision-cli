import { describe, expect, it } from 'vitest'

import { appendBeacons, parseCommitBeacons } from './commit-message.js'

describe('parseCommitBeacons', () => {
  it('reads beacons anywhere in the message, with the completed flag', () => {
    const { beacons, problems } = parseCommitBeacons(
      'feat(home): yearly toggle [BEACON: home.pricing]\n\n[BEACON: auth.session completed]'
    )
    expect(beacons).toEqual([
      { id: 'home.pricing', completed: false },
      { id: 'auth.session', completed: true },
    ])
    expect(problems).toEqual([])
  })

  it('ignores git comments and the verbose diff', () => {
    const message = [
      'fix: x',
      '# [BEACON: commented]',
      '# ------------------------ >8 ------------------------',
      '+ [BEACON: in-diff]',
    ].join('\n')
    expect(parseCommitBeacons(message).beacons).toEqual([])
  })

  it('reports empty and malformed beacons', () => {
    const { beacons, problems } = parseCommitBeacons('[BEACON: ] [BEACON: Bad] [BEACON: completed]')
    expect(beacons).toEqual([])
    expect(problems).toHaveLength(3)
  })
})

describe('appendBeacons', () => {
  it('keeps an empty first line for the subject in a fresh editor template', () => {
    const template = '\n# Please enter the commit message.\n#\n# On branch main\n'
    expect(appendBeacons(template, ['a', 'b'])).toBe(
      '\n\n[BEACON: a]\n[BEACON: b]\n\n# Please enter the commit message.\n#\n# On branch main\n'
    )
  })

  it('appends after a message given with -m', () => {
    expect(appendBeacons('feat(x): y\n', ['a'])).toBe('feat(x): y\n\n[BEACON: a]\n')
    expect(appendBeacons('feat(x): y', ['a'])).toBe('feat(x): y\n\n[BEACON: a]\n')
  })

  it('stays above git comments and the scissors line', () => {
    const message =
      'feat: x\n\nbody\n\n# comment\n# ------------------------ >8 ------------------------\ndiff'
    expect(appendBeacons(message, ['a'])).toBe(
      'feat: x\n\nbody\n\n[BEACON: a]\n\n# comment\n# ------------------------ >8 ------------------------\ndiff'
    )
  })

  it('leaves the message alone when there is nothing to add', () => {
    expect(appendBeacons('feat: x\n', [])).toBe('feat: x\n')
  })
})
