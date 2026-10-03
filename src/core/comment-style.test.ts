import { describe, expect, it } from 'vitest'

import { commentOpenersFor, commentStyleFor, insertFileBeacon } from './comment-style.js'

describe('commentStyleFor', () => {
  it('picks the comment syntax by extension or file name', () => {
    expect(commentStyleFor('src/a.tsx')).toEqual({ open: '//' })
    expect(commentStyleFor('app/main.py')).toEqual({ open: '#' })
    expect(commentStyleFor('Dockerfile')).toEqual({ open: '#' })
    expect(commentStyleFor('src/Hero.vue')).toEqual({ open: '<!--', close: '-->' })
    expect(commentStyleFor('package.json')).toBeUndefined()
    expect(commentStyleFor('.env')).toBeUndefined()
  })
})

describe('commentOpenersFor', () => {
  it('allows only real comments of the file type', () => {
    expect(commentOpenersFor('README.md')).toEqual(['<!--'])
    expect(commentOpenersFor('src/a.ts')).toEqual(['/**', '/*', '//'])
    expect(commentOpenersFor('index.php')).toContain('#')
    expect(commentOpenersFor('Jenkinsfile')).toHaveLength(6)
  })
})

describe('insertFileBeacon', () => {
  it('puts the beacon on the first line', () => {
    expect(insertFileBeacon('export {}\n', { open: '//' }, ['a'])).toBe('// @beacon a\nexport {}\n')
  })

  it('keeps shebangs, directives and doctypes on top', () => {
    expect(
      insertFileBeacon("#!/usr/bin/env node\n'use strict'\nrun()", { open: '//' }, ['a'])
    ).toBe("#!/usr/bin/env node\n'use strict'\n// @beacon a\nrun()")
    expect(insertFileBeacon('"use client";\nexport {}', { open: '//' }, ['a'])).toBe(
      '"use client";\n// @beacon a\nexport {}'
    )
    expect(
      insertFileBeacon('<!DOCTYPE html>\n<html>', { open: '<!--', close: '-->' }, ['a', 'b'])
    ).toBe('<!DOCTYPE html>\n<!-- @beacon a b -->\n<html>')
  })
})
