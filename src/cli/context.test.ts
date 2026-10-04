import { describe, expect, it } from 'vitest'

import { result } from '../commands/result.js'

import { type Io, print } from './context.js'

function io(color: boolean): Io & { output: string[]; errors: string[] } {
  const output: string[] = []
  const errors: string[] = []
  return {
    cwd: '/',
    out: (text) => output.push(text),
    err: (text) => errors.push(text),
    readStdin: () => '',
    color,
    configDir: '/tmp',
    openUrl: () => undefined,
    deviceName: 'test',
    output,
    errors,
  }
}

describe('print', () => {
  it('colors marked lines for a terminal and leaves the rest alone', () => {
    const terminal = io(true)
    print(result(0, ['✓ done', '  plain', '⚠ careful'], {}), terminal, false)
    const [text] = terminal.output
    expect(text).toContain('\u{1B}[32m✓ done')
    expect(text).toContain('\n  plain\n')
    expect(text).toContain('\u{1B}[33m⚠ careful')
  })

  it('sends failures to stderr, JSON as is and nothing for empty text', () => {
    const plain = io(false)
    print(result(1, ['✖ broken'], { error: 'x' }), plain, false)
    print(result(0, [], {}), plain, false)
    print(result(0, ['ignored'], { ok: true }), plain, true)
    expect(plain.errors).toEqual(['✖ broken'])
    expect(plain.output).toEqual([JSON.stringify({ ok: true }, null, 2)])
  })
})
