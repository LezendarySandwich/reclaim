/**
 * Verdict cache identity (ADR-010).
 *
 * The point of keying on rulesVersion and engineId, rather than postId alone, is that shipping new
 * heuristics or switching model invalidates every stale verdict automatically. There is no manual
 * cache bust to forget.
 */

import type { VerdictKey } from './types'

/**
 * FNV-1a, 32-bit, over UTF-16 code units.
 *
 * This is a CACHE KEY, not a security boundary — nothing downstream trusts it, and a collision
 * costs one wrongly-reused verdict on a post the user can expand. Do not "upgrade" it to SHA-256:
 * this runs on every post in the feed on the scroll path, and Web Crypto is async, which would
 * push an await into the hot loop for no benefit.
 */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    // 32-bit FNV prime multiply, via Math.imul to avoid float precision loss.
    h = Math.imul(h, 0x01000193)
  }
  // >>> 0 coerces to unsigned; base36 keeps the key short in IndexedDB.
  return (h >>> 0).toString(36)
}

/**
 * Normalise before hashing so cosmetically-identical posts share a verdict.
 *
 * LinkedIn re-renders posts with varying whitespace (and the "…see more" expansion changes
 * trailing content), so raw text would miss the cache constantly. Deliberately NOT lowercasing:
 * casing is a real signal for the triage router (TITLE CASE HEADERS, ALL-CAPS hooks), so two posts
 * differing only in case are genuinely different inputs.
 */
export function normalizeForHash(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** Stable identity for a cached verdict. Same inputs always produce the same key. */
export function verdictCacheKey(key: VerdictKey): string {
  // Unit separator, not a printable character, so it cannot appear in a component and forge a
  // collision between e.g. {postId: "a:b", ...} and {postId: "a", textHash: "b", ...}.
  return [key.postId, key.textHash, key.rulesVersion, key.engineId].join('␟')
}

/** Build a key from raw post text, applying normalisation and hashing. */
export function buildVerdictKey(args: {
  postId: string
  text: string
  rulesVersion: string
  engineId: string
}): VerdictKey {
  return {
    postId: args.postId,
    textHash: hashText(normalizeForHash(args.text)),
    rulesVersion: args.rulesVersion,
    engineId: args.engineId,
  }
}

/**
 * True when a cached verdict was produced by different rules or a different model and must be
 * recomputed. The text hash is deliberately not checked here — a changed text hash produces a
 * different key, so a stale-text entry is never found in the first place.
 */
export function isStale(
  cached: Pick<VerdictKey, 'rulesVersion' | 'engineId'>,
  currentRulesVersion: string,
  currentEngineId: string,
): boolean {
  return cached.rulesVersion !== currentRulesVersion || cached.engineId !== currentEngineId
}
