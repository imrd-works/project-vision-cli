import picomatch from 'picomatch'

import type { Manifest } from './manifest.js'
import { byText } from './text.js'
import { depthOf, isAncestorOrSelf } from './zone-id.js'

export type PathZone =
  | { kind: 'none' }
  | { kind: 'zone'; zone: string }
  /** Unrelated zones claim the same path: a mistake in the zone map. */
  | { kind: 'conflict'; zones: string[] }

export type ZoneResolver = (path: string) => PathZone

/**
 * Maps a repository-relative POSIX path to its zone by `paths` in the zone map.
 * Zones of one branch of the hierarchy (`home`, `home.hero`) nest: the deepest wins.
 */
export function createZoneResolver(manifest: Manifest): ZoneResolver {
  const matchers = [...manifest.zones.values()]
    .filter((zone) => zone.paths.length > 0)
    .map((zone) => ({ id: zone.id, match: picomatch(zone.paths, { dot: true }) }))

  return (path) => {
    const matched = matchers.filter(({ match }) => match(path)).map(({ id }) => id)
    if (matched.length === 0) return { kind: 'none' }
    const deepest = matched.toSorted((a, b) => depthOf(b) - depthOf(a))
    const [candidate = ''] = deepest
    if (deepest.every((id) => isAncestorOrSelf(id, candidate))) {
      return { kind: 'zone', zone: candidate }
    }
    return { kind: 'conflict', zones: matched.toSorted(byText) }
  }
}
