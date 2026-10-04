import { homedir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { configDir, deviceName, type Launch, openUrl } from './environment.js'

describe('configDir', () => {
  it('prefers BEACON_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(configDir({ BEACON_CONFIG_DIR: '/tmp/beacon' })).toBe('/tmp/beacon')
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' })).toBe(path.join('/xdg', 'beacon'))
    expect(configDir({})).toBe(path.join(homedir(), '.config', 'beacon'))
  })
})

describe('openUrl', () => {
  it('uses the platform opener in the background', () => {
    for (const [platform, command] of [
      ['darwin', 'open'],
      ['win32', 'cmd'],
      ['linux', 'xdg-open'],
    ] as const) {
      const run = vi.fn<Launch>()
      openUrl('https://vision.example.com', platform, run)
      expect(run).toHaveBeenCalledWith(
        command,
        expect.arrayContaining(['https://vision.example.com'])
      )
    }
  })

  it('never fails: the URL is printed anyway', () => {
    const run = vi.fn<Launch>(() => {
      throw new Error('no browser')
    })
    expect(() => {
      openUrl('https://vision.example.com', 'linux', run)
    }).not.toThrow()
    expect(deviceName()).not.toBe('')
  })
})
