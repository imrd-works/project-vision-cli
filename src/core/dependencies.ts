/**
 * Which files import which: relative paths and the aliases of `tsconfig` paths, for JavaScript
 * and TypeScript. The zones of the files then give the dependencies between modules.
 */

/** Files whose imports are read. */
export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte']

const IMPORT =
  /(?:\bimport|\bexport)\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g

/** `@/*` → `src/*`: an alias of tsconfig `paths`, its target relative to the repository. */
export interface Alias {
  prefix: string
  target: string
}

/** Module specifiers a file imports, in order, once each. */
export function parseImports(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(IMPORT)) {
    const spec = match[1] ?? match[2]
    if (spec !== undefined) found.add(spec)
  }
  return [...found]
}

/** Aliases of a tsconfig (`compilerOptions.paths` with `baseUrl`), at its folder in the repository. */
export function aliasesOf(tsconfig: string, folder: string): Alias[] {
  const config = parseJsonc(tsconfig) as {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
  } | null
  const options = config?.compilerOptions
  if (!options?.paths) return []
  const base = join(folder, options.baseUrl ?? '.')
  return Object.entries(options.paths).flatMap(([pattern, targets]) => {
    const [target] = targets
    if (target === undefined) return []
    return [{ prefix: pattern.replace(/\*$/, ''), target: join(base, target.replace(/\*$/, '')) }]
  })
}

/** The repository file an import points to, or undefined for packages and unknown paths. */
export function resolveImport(
  from: string,
  spec: string,
  files: ReadonlySet<string>,
  aliases: readonly Alias[]
): string | undefined {
  const base = spec.startsWith('.') ? join(dirname(from), spec) : aliasTarget(spec, aliases)
  if (base === undefined) return undefined
  const stem = base.replace(/\.[cm]?js$/, '')
  const candidates = [
    base,
    ...EXTENSIONS.map((extension) => `${stem}${extension}`),
    ...EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ]
  return candidates.find((candidate) => files.has(candidate))
}

function aliasTarget(spec: string, aliases: readonly Alias[]): string | undefined {
  const alias = aliases
    .filter((entry) => spec.startsWith(entry.prefix))
    .toSorted((a, b) => b.prefix.length - a.prefix.length)[0]
  return alias ? join(alias.target, spec.slice(alias.prefix.length)) : undefined
}

function dirname(file: string): string {
  const slash = file.lastIndexOf('/')
  return slash === -1 ? '' : file.slice(0, slash)
}

/** POSIX join with `.` and `..` folded; repository-relative, no leading slash. */
function join(...parts: string[]): string {
  const segments: string[] = []
  for (const segment of parts.join('/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/')
}

/** JSON with comments and trailing commas, as tsconfig files are. */
function parseJsonc(text: string): unknown {
  const stripped = text
    .replaceAll(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) =>
      match.startsWith('"') ? match : ''
    )
    .replaceAll(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(stripped) as unknown
  } catch {
    return null
  }
}

/** Dependencies between zones: how many imports lead from files of one to files of another. */
export function zoneDependencies(
  imports: Readonly<Record<string, readonly string[]>>,
  zonesOf: (file: string) => readonly string[]
): { from: string; to: string; imports: number }[] {
  const counts = new Map<string, number>()
  const add = (from: string, to: string): void => {
    if (from === to) return
    const key = `${from}\n${to}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [file, targets] of Object.entries(imports)) {
    const into = targets.flatMap((target) => zonesOf(target))
    for (const from of zonesOf(file)) for (const to of into) add(from, to)
  }
  return [...counts]
    .map(([key, count]) => {
      const [from = '', to = ''] = key.split('\n', 2)
      return { from, to, imports: count }
    })
    .toSorted((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
}
