/**
 * The architecture tree: the project's folders with how many files each holds and which zones
 * those files belong to. AI auditors compare structure against it instead of walking the disk.
 */
export interface DirNode {
  name: string
  /** Repository-relative path; '' for the root. */
  path: string
  /** Files in this folder and below. */
  files: number
  /** Of them, files that belong to at least one zone. */
  zonedFiles: number
  /** Zones of the files in this folder and below, sorted. */
  zones: string[]
  children: DirNode[]
}

class Folder {
  files = 0
  zonedFiles = 0
  readonly zones = new Set<string>()
  readonly children = new Map<string, Folder>()

  constructor(
    readonly name: string,
    readonly path: string
  ) {}

  add(zones: readonly string[]): void {
    this.files++
    if (zones.length > 0) this.zonedFiles++
    for (const zone of zones) this.zones.add(zone)
  }

  child(name: string, path: string): Folder {
    const existing = this.children.get(name)
    if (existing) return existing
    const created = new Folder(name, path)
    this.children.set(name, created)
    return created
  }

  freeze(): DirNode {
    return {
      name: this.name,
      path: this.path,
      files: this.files,
      zonedFiles: this.zonedFiles,
      zones: [...this.zones].toSorted((a, b) => a.localeCompare(b)),
      children: [...this.children.values()]
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((child) => child.freeze()),
    }
  }
}

export function buildArchitectureTree(
  files: readonly { path: string; zones: readonly string[] }[]
): DirNode {
  const root = new Folder('', '')
  for (const file of files) {
    root.add(file.zones)
    const dirs = file.path.split('/').slice(0, -1)
    let current = root
    for (const [index, dir] of dirs.entries()) {
      current = current.child(dir, dirs.slice(0, index + 1).join('/'))
      current.add(file.zones)
    }
  }
  return root.freeze()
}

/** A text tree for terminals and AI context; zones shown where they fit on a line. */
export function renderArchitectureTree(
  tree: DirNode,
  label: string,
  maxDepth = Infinity
): string[] {
  const lines = [`${label}/ (${String(tree.files)})`]
  const walk = (children: readonly DirNode[], prefix: string, depth: number): void => {
    for (const [index, child] of children.entries()) {
      const last = index === children.length - 1
      lines.push(
        `${prefix}${last ? '└── ' : '├── '}${child.name}/ (${String(child.files)})${zoneLabel(child)}`
      )
      if (depth < maxDepth)
        walk(child.children, `${prefix}${last ? ' '.repeat(4) : '│   '}`, depth + 1)
    }
  }
  walk(tree.children, '', 1)
  return lines
}

const MAX_LISTED_ZONES = 3

function zoneLabel(dir: DirNode): string {
  if (dir.zones.length === 0) return ''
  const coverage = dir.zonedFiles < dir.files ? `, в зонах ${String(dir.zonedFiles)}` : ''
  const zones =
    dir.zones.length <= MAX_LISTED_ZONES ? dir.zones.join(', ') : `зон: ${String(dir.zones.length)}`
  return `  — ${zones}${coverage}`
}
