import { describe, expect, it } from 'vitest'

import { draftZones, renderDraft } from './init-draft.js'
import { parseManifest } from './manifest.js'

describe('draftZones', () => {
  it('turns module folders and FSD slices into zones, merging slices across layers', () => {
    const zones = draftZones([
      'src/modules/auth/auth.service.ts',
      'src/modules/users/users.service.ts',
      'src/pages/login/ui/LoginPage.tsx',
      'src/features/login/model.ts',
      'src/features/index.ts',
      'src/shared/ui/Button.tsx',
      'src/widgets/PriceTable/index.ts',
    ])
    expect(zones).toEqual([
      { id: 'auth', title: 'auth', paths: ['src/modules/auth/**'] },
      { id: 'login', title: 'login', paths: ['src/features/login/**', 'src/pages/login/**'] },
      { id: 'price-table', title: 'price-table', paths: ['src/widgets/PriceTable/**'] },
      { id: 'users', title: 'users', paths: ['src/modules/users/**'] },
    ])
  })
})

describe('renderDraft', () => {
  it('renders a valid zone map, empty or not', () => {
    for (const zones of [[], draftZones(['src/modules/auth/a.ts'])]) {
      const result = parseManifest(renderDraft(zones))
      expect(result.ok ? result.manifest.zones.size : 'invalid').toBe(zones.length)
    }
  })
})
