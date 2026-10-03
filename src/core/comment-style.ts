/** How to write a one-line comment in a file, chosen by its extension or name. */
export interface CommentStyle {
  open: string
  close?: string
}

const LINE = { open: '//' } satisfies CommentStyle
const HASH = { open: '#' } satisfies CommentStyle
const DASH = { open: '--' } satisfies CommentStyle
const BLOCK = { open: '/*', close: '*/' } satisfies CommentStyle
const MARKUP = { open: '<!--', close: '-->' } satisfies CommentStyle

const BY_EXTENSION: Record<string, CommentStyle> = {
  ...fill(
    'ts tsx mts cts js jsx mjs cjs java kt kts swift go rs c h cc cpp hpp cs scala dart php scss less groovy gradle proto zig sol',
    LINE
  ),
  ...fill('py rb sh bash zsh yml yaml toml r pl ex exs tf cmake nix graphql gql ps1 env', HASH),
  ...fill('sql lua hs elm', DASH),
  ...fill('css', BLOCK),
  ...fill('html htm vue svelte md mdx xml svg', MARKUP),
}

const BY_NAME: Record<string, CommentStyle> = {
  Dockerfile: HASH,
  Makefile: HASH,
  Containerfile: HASH,
}

export function commentStyleFor(path: string): CommentStyle | undefined {
  const name = path.split('/').at(-1) ?? ''
  const byName = BY_NAME[name]
  if (byName) return byName
  const dot = name.lastIndexOf('.')
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined
}

const ALL_OPENERS = ['<!--', '/**', '/*', '//', '--', '#'] as const
export type CommentOpener = (typeof ALL_OPENERS)[number]

const C_LIKE: readonly CommentOpener[] = ['/**', '/*', '//']
const OPENERS_BY_STYLE: Record<string, readonly CommentOpener[]> = {
  '//': C_LIKE,
  '#': ['#'],
  '--': ['--'],
  '/*': ['/**', '/*'],
  // HTML-like files embed scripts and styles.
  '<!--': ['<!--', ...C_LIKE],
}

/**
 * Comment openers that are real comments in this file, longest first. Markdown allows only
 * `<!-- -->`: a `// …` line there is a code sample, not a comment. Unknown types allow all.
 */
export function commentOpenersFor(path: string): readonly CommentOpener[] {
  if (/\.mdx?$/i.test(path)) return ['<!--']
  const style = commentStyleFor(path)
  if (path.toLowerCase().endsWith('.php')) return [...C_LIKE, '#']
  return style ? (OPENERS_BY_STYLE[style.open] ?? ALL_OPENERS) : ALL_OPENERS
}

/** Lines that must stay on top of a file: shebang, encoding, directives, doctype. */
const PROLOGUE = [
  /^#!/,
  /^#.*coding[:=]/,
  /^\s*(['"])use [a-z ]+\1;?\s*$/,
  /^<!doctype/i,
  /^<\?xml/,
  /^<\?php/,
]

/** Inserts a file beacon `@beacon <ids>` as a comment below the file's prologue. */
export function insertFileBeacon(
  text: string,
  style: CommentStyle,
  ids: readonly string[]
): string {
  const comment = [style.open, `@beacon ${ids.join(' ')}`, style.close].filter(Boolean).join(' ')
  const lines = text.split('\n')
  let at = 0
  while (at < lines.length && PROLOGUE.some((pattern) => pattern.test(lines[at] ?? ''))) at++
  lines.splice(at, 0, comment)
  return lines.join('\n')
}

function fill(extensions: string, style: CommentStyle): Record<string, CommentStyle> {
  return Object.fromEntries(extensions.split(' ').map((extension) => [extension, style]))
}
