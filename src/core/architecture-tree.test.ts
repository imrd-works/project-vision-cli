import { describe, expect, it } from 'vitest'

import { buildArchitectureTree, renderArchitectureTree } from './architecture-tree.js'

const tree = buildArchitectureTree([
  { path: 'README.md', zones: [] },
  { path: 'src/modules/auth/login.ts', zones: ['auth'] },
  { path: 'src/modules/auth/password.ts', zones: ['auth.passwords'] },
  { path: 'src/modules/users/users.ts', zones: ['users'] },
  { path: 'src/core/log.ts', zones: [] },
  { path: 'src/app.ts', zones: ['a', 'b', 'c', 'd'] },
])

describe('buildArchitectureTree', () => {
  it('counts files and collects zones per folder', () => {
    expect(tree).toMatchObject({ path: '', files: 6, zonedFiles: 4 })
    const [src] = tree.children
    expect(src).toMatchObject({ name: 'src', files: 5, zonedFiles: 4 })
    expect(src?.children.map((child) => child.name)).toEqual(['core', 'modules'])
    expect(src?.children[1]?.children[0]).toMatchObject({
      path: 'src/modules/auth',
      files: 2,
      zones: ['auth', 'auth.passwords'],
    })
  })
})

describe('renderArchitectureTree', () => {
  it('draws folders with counts and fitting zone lists', () => {
    expect(renderArchitectureTree(tree, 'demo')).toEqual([
      'demo/ (6)',
      '└── src/ (5)  — зон: 7, в зонах 4',
      '    ├── core/ (1)',
      '    └── modules/ (3)  — auth, auth.passwords, users',
      '        ├── auth/ (2)  — auth, auth.passwords',
      '        └── users/ (1)  — users',
    ])
    expect(renderArchitectureTree(tree, 'demo', 1)).toHaveLength(2)
  })
})
