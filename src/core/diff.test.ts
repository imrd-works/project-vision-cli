import { describe, expect, it } from 'vitest'

import { buildFileChanges, intersects, parseNameStatus } from './diff.js'

describe('parseNameStatus', () => {
  it('reads every status of `git diff --name-status -z -M`', () => {
    const output = [
      'M',
      'src/a.ts',
      'A',
      'src/b.ts',
      'D',
      'src/c.ts',
      'R087',
      'old.ts',
      'new.ts',
      'T',
      'run.sh',
      '',
    ].join('\0')
    expect(parseNameStatus(output)).toEqual([
      { oldPath: 'src/a.ts', newPath: 'src/a.ts' },
      { newPath: 'src/b.ts' },
      { oldPath: 'src/c.ts' },
      { oldPath: 'old.ts', newPath: 'new.ts' },
      { oldPath: 'run.sh', newPath: 'run.sh' },
    ])
  })
})

const PATCH = String.raw`diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3 +3 @@ export const a = 1
-old
+new
@@ -10,2 +9,0 @@
-x
-y
@@ -20,0 +19,3 @@
+one
+++ two
+three
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
diff --git "a/src/\321\217 file.ts" "b/src/\321\217 file.ts"
--- "a/src/\321\217 file.ts"
+++ "b/src/\321\217 file.ts"
@@ -1 +1 @@
-a
+b
diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`

describe('buildFileChanges', () => {
  it('attaches changed line ranges to each file', () => {
    const nameStatus = [
      'M',
      'src/a.ts',
      'D',
      'src/gone.ts',
      'M',
      'src/я file.ts',
      'R100',
      'old.ts',
      'new.ts',
      '',
    ].join('\0')
    expect(buildFileChanges(nameStatus, PATCH)).toEqual([
      {
        oldPath: 'src/a.ts',
        newPath: 'src/a.ts',
        oldRanges: [
          { start: 3, end: 3 },
          { start: 10, end: 11 },
        ],
        newRanges: [
          { start: 3, end: 3 },
          { start: 19, end: 21 },
        ],
      },
      { oldPath: 'src/gone.ts', oldRanges: [{ start: 1, end: 2 }], newRanges: [] },
      {
        oldPath: 'src/я file.ts',
        newPath: 'src/я file.ts',
        oldRanges: [{ start: 1, end: 1 }],
        newRanges: [{ start: 1, end: 1 }],
      },
      { oldPath: 'old.ts', newPath: 'new.ts', oldRanges: [], newRanges: [] },
    ])
  })
})

describe('intersects', () => {
  it('checks inclusive overlap', () => {
    const ranges = [{ start: 5, end: 7 }]
    expect(intersects(ranges, 7, 9)).toBe(true)
    expect(intersects(ranges, 1, 4)).toBe(false)
  })
})
