/**
 * Post identity for LinkedIn.
 *
 * Its own module because it is the hardest unsolved problem in the adapter, and it gates history,
 * metrics and the leaderboard — everything that needs to recognise the same post twice.
 *
 * **The modern React feed exposes no post URN.** Not a missing attribute we have not found: in 10
 * captured fixtures from a maintained filter project there was not a single `data-urn`,
 * `data-id`, `data-activity-urn` or `data-chameleon-result-urn`. The attribute you would reach
 * for does not exist.
 *
 * So identity is derived, in strict preference order, and the derivation records WHICH strategy
 * produced it — a composite hash is far weaker than a real URN, and code consuming an id should
 * be able to tell.
 */

export type IdentityStrategy =
  /** A real activity URN from the DOM. Legacy feed only. Strongest. */
  | 'urn'
  /** Parsed out of the post's permalink. Strong, but the link is not always rendered. */
  | 'permalink'
  /** Author + normalised text + timestamp. Weakest — survives re-render, not an edit. */
  | 'composite'

export interface PostIdentity {
  id: string
  strategy: IdentityStrategy
}

const ACTIVITY_URN = /urn:li:(?:activity|ugcPost|share):(\d+)/u

/** FNV-1a. A cache key, not a security boundary — see src/core/cache.ts for why not SHA. */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** Pull an activity id out of any string that contains one (attribute value, href, JSON blob). */
export function extractUrn(value: string | null | undefined): string | null {
  if (!value) return null
  const m = ACTIVITY_URN.exec(value)
  return m ? `activity:${m[1]}` : null
}

export interface IdentityInput {
  /** Attribute values worth scanning for a URN, in preference order. */
  urnCandidates: ReadonlyArray<string | null | undefined>
  /** href of the post permalink, if one is rendered. */
  permalink?: string | null
  authorUrn: string
  text: string
  /** Post timestamp as displayed ("2h", "3d"). Coarse, but it disambiguates reposts. */
  timestamp?: string | null
}

/**
 * Derive an identity, preferring the strongest available strategy.
 *
 * Returns null when there is nothing to work with — no URN, no permalink, and no text. That is a
 * real case (an unfilled lazily-mounted row) and the caller must treat it as "not ready yet"
 * rather than inventing an id.
 */
export function deriveIdentity(input: IdentityInput): PostIdentity | null {
  for (const candidate of input.urnCandidates) {
    const urn = extractUrn(candidate)
    if (urn) return { id: urn, strategy: 'urn' }
  }

  const fromLink = extractUrn(input.permalink)
  if (fromLink) return { id: fromLink, strategy: 'permalink' }

  const text = input.text.replace(/\s+/gu, ' ').trim()
  if (!text) return null

  // Only the first 400 chars: a "see more" expansion changes the tail, and an id that changes
  // when the user expands a post would make every expansion look like a new post.
  const basis = `${input.authorUrn}|${text.slice(0, 400)}|${input.timestamp ?? ''}`
  return { id: `c:${hash(basis)}`, strategy: 'composite' }
}

/**
 * Whether an id is stable enough to persist in history and count toward the leaderboard.
 *
 * Composite ids are deliberately allowed — excluding them would mean the modern feed collects no
 * history at all, which is worse. But they are the weakest link in the leaderboard's evidence,
 * and the dashboard should not present a creator tally as more certain than its ids are.
 */
export function isDurable(strategy: IdentityStrategy): boolean {
  return strategy !== 'composite'
}
