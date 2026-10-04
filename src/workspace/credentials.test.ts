import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadCredential, removeCredential, saveCredential } from './credentials.js'

describe('credentials', () => {
  let dir: string
  const credential = {
    token: 'bvt_x',
    user: { email: 'ann@x.io', name: 'Ann' },
    savedAt: '2026-10-04T10:00:00.000Z',
  }

  beforeEach(() => {
    dir = path.join(mkdtempSync(path.join(tmpdir(), 'beacon-config-')), 'beacon')
  })

  afterEach(() => {
    rmSync(path.dirname(dir), { recursive: true, force: true })
  })

  it('keeps one token per server, readable by the user only', () => {
    saveCredential(dir, 'https://a.example.com', credential)
    saveCredential(dir, 'https://b.example.com', { ...credential, token: 'bvt_y' })

    expect(loadCredential(dir, 'https://a.example.com')).toEqual(credential)
    expect(loadCredential(dir, 'https://b.example.com')?.token).toBe('bvt_y')
    expect(loadCredential(dir, 'https://c.example.com')).toBeUndefined()

    expect(removeCredential(dir, 'https://a.example.com')).toBe(true)
    expect(removeCredential(dir, 'https://a.example.com')).toBe(false)
    expect(readFileSync(path.join(dir, 'credentials.json'), 'utf8')).not.toContain('bvt_x')
  })

  it.skipIf(process.platform === 'win32')('makes the file readable by the user only', () => {
    saveCredential(dir, 'https://a.example.com', credential)
    expect(statSync(path.join(dir, 'credentials.json')).mode & 0o777).toBe(0o600)
  })

  it('treats a missing or damaged file as no credentials', () => {
    expect(loadCredential(dir, 'https://a.example.com')).toBeUndefined()
    saveCredential(dir, 'https://a.example.com', credential)
    writeFileSync(path.join(dir, 'credentials.json'), '{ broken')
    expect(loadCredential(dir, 'https://a.example.com')).toBeUndefined()
  })
})
