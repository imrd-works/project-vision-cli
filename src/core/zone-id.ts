/**
 * Zone IDs are hierarchical product paths: `home`, `home.hero`, `payments.checkout.card`.
 * @see docs/beacon-format.md#id-зоны
 */
const SEGMENT = /^[a-z][a-z0-9-]*$/

/** Words with a special meaning in beacons that can never name a zone. */
const RESERVED_IDS = new Set(['none', 'completed'])

export type ZoneIdError = 'format' | 'reserved'

export function validateZoneId(id: string): ZoneIdError | undefined {
  if (id.split('.').some((segment) => !SEGMENT.test(segment))) return 'format'
  if (RESERVED_IDS.has(id)) return 'reserved'
  return undefined
}

/** Ancestors from the nearest: `a.b.c` → [`a.b`, `a`]. */
export function ancestorsOf(id: string): string[] {
  const segments = id.split('.')
  const result: string[] = []
  for (let length = segments.length - 1; length > 0; length--) {
    result.push(segments.slice(0, length).join('.'))
  }
  return result
}

/** True when `ancestor` is `id` itself or one of its ancestors. */
export function isAncestorOrSelf(ancestor: string, id: string): boolean {
  return id === ancestor || id.startsWith(`${ancestor}.`)
}

export function depthOf(id: string): number {
  return id.split('.').length
}
