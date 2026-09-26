/**
 * Creator leaderboard ranking.
 *
 * Pure functions over plain records, deliberately separate from `db.ts`, so the ranking rule —
 * the part with actual product judgement in it — is testable without IndexedDB.
 */

import type { AuthorAggregate } from './schema'

export interface RankedAuthor {
  authorUrn: string
  authorName: string
  postsSeen: number
  postsFlagged: number
  /** 0-1. */
  flagRate: number
  /** 0-100. */
  meanScore: number
  /** The sort key. Not shown to the user — a rank is easier to read than a contrived score. */
  weight: number
}

export interface RankOptions {
  /**
   * Below this, an author is excluded entirely.
   *
   * Without a floor, one flagged post out of one makes a 100% flag rate and tops the board. The
   * leaderboard is an accusation surface by construction (ADR-019), and "we saw one post from
   * this person and did not like it" is not a finding.
   */
  minPosts?: number
  limit?: number
}

const DEFAULT_MIN_POSTS = 5

/**
 * Rank by rate × volume.
 *
 * Neither component works alone. Raw flagged count ranks by how much someone posts, so a prolific
 * mostly-clean poster tops the list. Raw rate ranks 1-for-1 above 40-for-100. Multiplying by
 * `log1p(flagged)` keeps rate primary while letting sustained volume break ties — the difference
 * between someone having a bad week and someone doing it every day.
 */
export function rankOffenders(
  authors: readonly AuthorAggregate[],
  options: RankOptions = {},
): RankedAuthor[] {
  const minPosts = options.minPosts ?? DEFAULT_MIN_POSTS
  const limit = options.limit ?? 20

  return authors
    .filter((a) => a.postsSeen >= minPosts && a.postsFlagged > 0)
    .map((a) => {
      const flagRate = a.postsSeen > 0 ? a.postsFlagged / a.postsSeen : 0
      return {
        authorUrn: a.authorUrn,
        authorName: a.authorName,
        postsSeen: a.postsSeen,
        postsFlagged: a.postsFlagged,
        flagRate,
        meanScore: a.postsSeen > 0 ? a.scoreSum / a.postsSeen : 0,
        weight: flagRate * Math.log1p(a.postsFlagged),
      }
    })
    .sort((x, y) => y.weight - x.weight || y.postsFlagged - x.postsFlagged)
    .slice(0, limit)
}

export interface AccuracySummary {
  /** Labels the user gave. The denominator of any honest accuracy claim. */
  total: number
  agreed: number
  /** 0-1, or null when there is not enough data to say anything. */
  agreementRate: number | null
}

/**
 * Agreement between our verdicts and the user's thumbs.
 *
 * Called agreement rather than accuracy on purpose. For `engagement_bait` the user genuinely is
 * ground truth. For `ai_written` they are not — a 25M-comment study found human AI-accusations
 * uncorrelated with the actual statistical signal — so ADR-019 treats those thumbs as an
 * annoyance label and forbids closing the tuning loop on them.
 */
export function summarizeAgreement(
  labels: ReadonlyArray<{ userSays: boolean }>,
  minSample = 10,
): AccuracySummary {
  const total = labels.length
  const agreed = labels.filter((l) => l.userSays).length
  return {
    total,
    agreed,
    agreementRate: total >= minSample ? agreed / total : null,
  }
}
