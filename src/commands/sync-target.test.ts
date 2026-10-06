import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { syncTarget } from './sync.js'

const PROJECT = '54cc4d32-7588-4252-a186-832699730b5a'
let root: string

function withConfig(text: string): string {
  root = mkdtempSync(path.join(tmpdir(), 'beacon-target-'))
  mkdirSync(path.join(root, '.beacons'))
  writeFileSync(path.join(root, '.beacons', 'config.yml'), text)
  return root
}

describe('syncTarget', () => {
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reads the server block the dashboard gives', () => {
    const target = syncTarget(
      withConfig(`server:\n  url: https://vision.example.com/\n  project: ${PROJECT}\n`),
      {}
    )
    expect(target).toEqual({ server: 'https://vision.example.com', project: PROJECT })
  })

  it('shows what is wrong with the config instead of asking for a server', () => {
    const target = syncTarget(withConfig(`server:\n  url: ftp://x\n  project: ${PROJECT}\n`), {})
    expect(target).toMatchObject({ code: 2, json: { error: 'invalid-config' } })
    expect('text' in target ? target.text : '').toContain('server.url')
  })

  it('lets flags stand in for a broken config', () => {
    const target = syncTarget(withConfig('server: ['), {
      server: 'https://vision.example.com',
      project: PROJECT,
    })
    expect(target).toEqual({ server: 'https://vision.example.com', project: PROJECT })
  })
})
