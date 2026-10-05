import { describe, expect, it } from 'vitest'

import type { ChangedFile } from './commit-check.js'
import {
  checkOwnership,
  editKind,
  governingOwner,
  grantTrailer,
  permission,
  skeleton,
  type ZoneOwnerRecord,
} from './ownership.js'
import type { Person } from './sync.js'

function person(name: string, emails: string[]): Person {
  return {
    userId: name,
    name,
    role: 'member',
    emails,
    contacts: { telegram: null, phone: null, email: null },
    identities: [],
  }
}

const ann = person('Ann Lee', ['ann@x.io', 'ann@work.io'])
const bob = person('Bob Kim', ['bob@x.io'])
const eve = person('Eve Ng', ['eve@x.io'])

const owners = new Map<string, ZoneOwnerRecord>([
  ['auth', { zone: 'auth', owner: 'ann@x.io', proxies: ['bob@x.io'] }],
  ['billing', { zone: 'billing', owner: null, proxies: [] }],
])

function change(path: string, before: string | undefined, after: string | undefined): ChangedFile {
  return {
    ...(before === undefined ? {} : { oldPath: path, oldText: before }),
    ...(after === undefined ? {} : { newPath: path, newText: after }),
    oldRanges: [],
    newRanges: [],
  }
}

describe('edit kinds', () => {
  it('sees only comments, string texts and whitespace as cosmetic', () => {
    const code = 'export function login(user) {\n  // check it\n  return check(user, "ok")\n}\n'
    expect(
      editKind(change('src/a.ts', code, code.replace('// check it', '// verify the user')))
    ).toBe('cosmetic')
    expect(editKind(change('src/a.ts', code, code.replace('"ok"', '"Signed in"')))).toBe('cosmetic')
    expect(editKind(change('src/a.ts', code, code.replace('  return', '    return')))).toBe(
      'cosmetic'
    )
    expect(editKind(change('src/a.ts', code, code.replace('check(user', 'verify(user')))).toBe(
      'logic'
    )
    expect(editKind(change('src/a.ts', undefined, code))).toBe('logic')
    expect(editKind(change('docs/auth.md', 'a', 'b'))).toBe('cosmetic')
    expect(editKind(change('src/locales/en.json', '{"a":1}', '{"a":2}'))).toBe('cosmetic')
  })

  it('keeps the code inside template literals', () => {
    const text = (inner: string) => `const a = \`Hello \${${inner}} and {braces}\` /* c */`
    expect(skeleton(text('name'), 'a.ts')).toBe(skeleton(text('name'), 'a.ts'))
    expect(skeleton(text('name'), 'a.ts')).not.toBe(skeleton(text('user.name'), 'a.ts'))
    expect(skeleton('const a = `x ${ {b: 1}.b } y`', 'a.ts')).toBe('const a = `${ {b: 1}.b }`')
    expect(skeleton("x = 'it\\'s' # note\n", 'a.py')).toBe("x = ''")
    expect(skeleton('a  b\n', 'Makefile')).toBe('a b')
  })
})

describe('permissions', () => {
  const today = '2026-10-05'
  const base = { owners, grants: [], today }

  it('lets the owner, proxies and grantees change the logic', () => {
    expect(permission({ ...base, zone: 'auth.passwords', person: ann })).toMatchObject({
      allowed: true,
      via: 'owner',
    })
    expect(permission({ ...base, zone: 'auth', person: bob })).toMatchObject({ via: 'proxy' })
    expect(permission({ ...base, zone: 'billing', person: eve })).toEqual({
      allowed: true,
      via: 'free',
    })
    expect(permission({ ...base, zone: 'auth', person: eve })).toMatchObject({ allowed: false })
    expect(permission({ ...base, zone: 'auth', person: undefined }).allowed).toBe(false)

    const grants = [
      { zone: 'auth', grantee: 'eve@x.io', until: '2026-10-05', grantedBy: 'ann@x.io' },
    ]
    expect(permission({ ...base, grants, zone: 'auth', person: eve })).toMatchObject({
      via: 'grant',
    })
    // A grant of a zone covers its subzones; an expired one covers nothing.
    expect(permission({ ...base, grants, zone: 'auth.old', person: eve }).allowed).toBe(true)
    const expired = [{ zone: 'auth', grantee: 'eve@x.io', until: '2026-10-04' }]
    expect(permission({ ...base, grants: expired, zone: 'auth', person: eve }).allowed).toBe(false)
    expect(grantTrailer(grants[0] ?? { zone: '', grantee: '' })).toBe(
      'Beacon-Grant: auth for eve@x.io by ann@x.io until 2026-10-05'
    )
    expect(grantTrailer({ zone: 'auth', grantee: 'eve@x.io' })).toBe(
      'Beacon-Grant: auth for eve@x.io'
    )
  })

  it('takes the owner of the nearest zone above that has one', () => {
    expect(governingOwner(owners, 'auth.passwords.hash')?.owner).toBe('ann@x.io')
    expect(governingOwner(owners, 'billing')).toBeUndefined()
  })

  it('collects the foreign zones whose logic a change touches', () => {
    const logic = change('src/auth/login.ts', 'a()', 'b()')
    const text = change('src/auth/copy.ts', '"a"', '"b"')
    const files = [
      { file: logic, zones: ['auth', 'billing'] },
      { file: text, zones: ['auth'] },
    ]
    expect(checkOwnership({ ...base, files, person: eve })).toEqual({
      denied: [
        {
          zone: 'auth',
          owner: { zone: 'auth', owner: 'ann@x.io', proxies: ['bob@x.io'] },
          files: ['src/auth/login.ts'],
        },
      ],
      grants: [],
    })
    const grants = [{ zone: 'auth', grantee: 'eve@x.io' }]
    expect(checkOwnership({ ...base, grants, files, person: eve })).toEqual({
      denied: [],
      grants,
    })
  })
})
