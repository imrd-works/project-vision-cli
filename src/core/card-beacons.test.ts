import { describe, expect, it } from 'vitest'

import { parseCardBeacons } from './card-beacons.js'

describe('beacons in tracker cards', () => {
  it('reads zones and what the card is to them', () => {
    expect(
      parseCardBeacons(
        'Login fails on Safari [BEACON: auth.session stopper]\n\nAlso see [beacon: billing, auth.session]'
      )
    ).toEqual([
      { zone: 'auth.session', link: 'stopper' },
      { zone: 'billing', link: 'task' },
    ])
    expect(parseCardBeacons('[BEACON: auth debt] and [BEACON: auth]')).toEqual([
      { zone: 'auth', link: 'debt' },
    ])
  })

  it('ignores what is not a zone', () => {
    expect(parseCardBeacons('No beacon here')).toEqual([])
    expect(parseCardBeacons('[BEACON: Not_A_Zone stopper] [BEACON: ]')).toEqual([])
  })
})
