import { describe, expect, it } from 'vitest'

import { parseManifest } from './manifest.js'
import { ancestorsOf, isAncestorOrSelf, validateZoneId } from './zone-id.js'
import { createZoneResolver } from './zone-resolver.js'

function resolver(zones: string) {
  const result = parseManifest(`version: 1\nzones:\n${zones}`)
  if (!result.ok) throw new Error('invalid test manifest')
  return createZoneResolver(result.manifest)
}

describe('zone IDs', () => {
  it('validates segments and reserved words', () => {
    expect(validateZoneId('payments.checkout-v2')).toBeUndefined()
    expect(validateZoneId('Payments')).toBe('format')
    expect(validateZoneId('a..b')).toBe('format')
    expect(validateZoneId('2fa')).toBe('format')
    expect(validateZoneId('none')).toBe('reserved')
  })

  it('walks the hierarchy', () => {
    expect(ancestorsOf('a.b.c')).toEqual(['a.b', 'a'])
    expect(isAncestorOrSelf('home', 'home.hero')).toBe(true)
    expect(isAncestorOrSelf('home', 'homepage')).toBe(false)
  })
})

describe('createZoneResolver', () => {
  const resolve = resolver(`
  home:
    title: Главная
    paths: [src/pages/home/**]
  home.hero:
    title: Первый экран
    paths: [src/pages/home/hero/**, src/widgets/hero/**]
  payments:
    title: Оплата
    paths: [src/widgets/**/pay*.ts]
`)

  it('maps paths to zones, the deepest zone of a branch wins', () => {
    expect(resolve('src/pages/home/HomePage.tsx')).toEqual({ kind: 'zone', zone: 'home' })
    expect(resolve('src/pages/home/hero/Hero.tsx')).toEqual({ kind: 'zone', zone: 'home.hero' })
    expect(resolve('src/shared/ui/Button.tsx')).toEqual({ kind: 'none' })
  })

  it('reports unrelated zones that claim one path', () => {
    expect(resolve('src/widgets/hero/payment.ts')).toEqual({
      kind: 'conflict',
      zones: ['home.hero', 'payments'],
    })
  })

  it('matches dotfiles too', () => {
    const dot = resolver('  ci:\n    title: CI\n    paths: [.github/**]\n')
    expect(dot('.github/workflows/ci.yml')).toEqual({ kind: 'zone', zone: 'ci' })
  })
})
