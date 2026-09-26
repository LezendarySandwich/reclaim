/**
 * IndexedDB schema. Pure declarations — no platform calls, so this is importable anywhere.
 */

import type { Axis, TriageBand, VerdictAction } from '../core/types'

export const DB_NAME = 'reclaim'
export const DB_VERSION = 1

export const STORE = {
  verdicts: 'verdicts',
  authors: 'authors',
  labels: 'labels',
} as const

/**
 * Longest post excerpt we keep.
 *
 * We store an excerpt rather than the body because we deliberately do not request
 * `unlimitedStorage` (it widens the install warning), and because retaining the full text of
 * thousands of other people's posts is more than the product needs. The dashboard shows enough to
 * judge a verdict; it is not an archive.
 */
export const EXCERPT_CHARS = 400

export interface StoredVerdict {
  /** Cache key from src/core/cache.ts — postId + textHash + rulesVersion + engineId. */
  key: string
  postId: string
  authorUrn: string
  authorName: string
  /** Truncated to EXCERPT_CHARS. Never the full body. */
  excerpt: string
  action: VerdictAction
  triggeredBy: Axis[]
  /** Flattened for indexing; the full signal map lives in `signals`. */
  topScore: number
  signals: Partial<Record<Axis, { score: number; source: string }>>
  engineId: string
  rulesVersion: string
  /**
   * What the triage router said before the model looked. Enables the agreement panel.
   * Absent on rows written before this field existed.
   */
  triageBand?: TriageBand
  /** Epoch ms. Passed in by the caller — this module never reads the clock, so it stays pure. */
  at: number
}

export interface AuthorAggregate {
  authorUrn: string
  authorName: string
  postsSeen: number
  postsFlagged: number
  /** Sum of top scores, so mean is derivable without storing every score. */
  scoreSum: number
  firstSeen: number
  lastSeen: number
}

export interface StoredLabel {
  /** `${postId}:${axis}` — one label per post per axis; a re-vote overwrites. */
  key: string
  postId: string
  axis: Axis
  /** true = the user agrees the axis applies. */
  userSays: boolean
  /** The score at the time they voted, so calibration drift is measurable. */
  verdictAtTime: number
  at: number
}

/** Applied by `onupgradeneeded`. Kept declarative so a v2 migration is a visible diff. */
export function createStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE.verdicts)) {
    const s = db.createObjectStore(STORE.verdicts, { keyPath: 'key' })
    s.createIndex('at', 'at') // retention purge
    s.createIndex('authorUrn', 'authorUrn') // per-creator drill-down
    s.createIndex('action', 'action') // "what did it hide" timeline
    s.createIndex('triageBand', 'triageBand') // router-vs-model agreement
  }
  if (!db.objectStoreNames.contains(STORE.authors)) {
    const s = db.createObjectStore(STORE.authors, { keyPath: 'authorUrn' })
    s.createIndex('lastSeen', 'lastSeen')
  }
  if (!db.objectStoreNames.contains(STORE.labels)) {
    const s = db.createObjectStore(STORE.labels, { keyPath: 'key' })
    s.createIndex('at', 'at')
    s.createIndex('axis', 'axis')
  }
}

export function toExcerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS - 1)}…`
}
