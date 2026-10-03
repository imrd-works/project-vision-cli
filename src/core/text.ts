/** Stable, locale-aware order for IDs and paths. */
export function byText(a: string, b: string): number {
  return a.localeCompare(b)
}
