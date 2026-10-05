import { validateZoneId } from './zone-id.js'

/**
 * Beacons in the cards of task trackers (Jira, ClickUp…): the same `[BEACON: zone]` as in code
 * and commits, in the card's title or description — no custom fields. A word beside the zone
 * says what the card is to its checkpoint: `[BEACON: auth stopper]`, `[BEACON: auth debt]`;
 * without one it is a task of the zone.
 * @see docs/beacon-format.md#карточки-трекеров
 */

export const CARD_LINKS = ['task', 'stopper', 'debt'] as const
export type CardLink = (typeof CARD_LINKS)[number]

export interface CardBeacon {
  zone: string
  link: CardLink
}

const BRACKET = /\[BEACON:([^\]]*)\]/gi
const KEYWORDS = new Set<string>(['stopper', 'debt'])

/** Every zone a card names, once, with the strongest link it is given (stopper over debt). */
export function parseCardBeacons(text: string): CardBeacon[] {
  const found = new Map<string, CardLink>()
  for (const match of text.matchAll(BRACKET)) {
    const words = (match[1] ?? '').split(/[\s,]+/).filter(Boolean)
    const link = linkOf(words)
    for (const zone of words.filter(isZone)) {
      const current = found.get(zone)
      if (current === undefined || rank(link) > rank(current)) found.set(zone, link)
    }
  }
  return [...found].map(([zone, link]) => ({ zone, link }))
}

function linkOf(words: readonly string[]): CardLink {
  const keyword = words.map((word) => word.toLowerCase()).find((word) => KEYWORDS.has(word))
  return keyword === 'stopper' || keyword === 'debt' ? keyword : 'task'
}

function isZone(word: string): boolean {
  return !KEYWORDS.has(word.toLowerCase()) && validateZoneId(word) === undefined
}

function rank(link: CardLink): number {
  return CARD_LINKS.indexOf(link)
}
