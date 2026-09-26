import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  allAuthors,
  getVerdict,
  labelsForAxis,
  purgeAll,
  purgeOlderThan,
  putLabel,
  recentVerdicts,
  recordVerdict,
  resetDbHandleForTests,
} from './db'
import { EXCERPT_CHARS } from './schema'
import type { Verdict } from '../core/types'

beforeEach(() => {
  // Fresh database per test. Without this, records leak between tests and the aggregate
  // assertions become order-dependent.
  globalThis.indexedDB = new IDBFactory()
  resetDbHandleForTests()
})

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    postId: 'p1',
    signals: { engagement_bait: { score: 80, source: 'model' } },
    action: 'collapse',
    triggeredBy: ['engagement_bait'],
    engineId: 'gemini-nano',
    rulesVersion: 'r1',
    ...over,
  }
}

function record(over: Partial<Parameters<typeof recordVerdict>[0]> = {}) {
  return recordVerdict({
    verdict: verdict(),
    cacheKey: 'k1',
    authorUrn: 'urn:alice',
    authorName: 'Alice',
    text: 'Comment GUIDE below and I will send it.',
    at: 1_000,
    ...over,
  })
}

describe('verdict round-trip', () => {
  it('stores and retrieves by cache key', async () => {
    await record()
    const got = await getVerdict('k1')
    expect(got?.postId).toBe('p1')
    expect(got?.action).toBe('collapse')
    expect(got?.topScore).toBe(80)
  })

  it('returns undefined for an unknown key', async () => {
    expect(await getVerdict('nope')).toBeUndefined()
  })

  it('truncates the excerpt rather than storing the whole post', async () => {
    await record({ text: 'x'.repeat(5000) })
    const got = await getVerdict('k1')
    expect(got!.excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS)
  })

  it('derives topScore from the highest signal', async () => {
    await record({
      verdict: verdict({
        signals: {
          engagement_bait: { score: 40, source: 'model' },
          ai_written: { score: 91, source: 'model' },
        },
      }),
    })
    expect((await getVerdict('k1'))!.topScore).toBe(91)
  })

  it('handles a verdict with no signals at all', async () => {
    await record({ verdict: verdict({ signals: {}, action: 'show', triggeredBy: [] }) })
    expect((await getVerdict('k1'))!.topScore).toBe(0)
  })
})

describe('author aggregates update atomically with the verdict', () => {
  it('creates an aggregate on first sight', async () => {
    await record()
    const [a] = await allAuthors()
    expect(a).toMatchObject({ authorUrn: 'urn:alice', postsSeen: 1, postsFlagged: 1 })
  })

  it('accumulates across posts', async () => {
    await record({ cacheKey: 'k1', at: 1 })
    await record({
      cacheKey: 'k2',
      at: 2,
      verdict: verdict({ postId: 'p2', action: 'show', triggeredBy: [] }),
    })
    await record({ cacheKey: 'k3', at: 3, verdict: verdict({ postId: 'p3' }) })
    const [a] = await allAuthors()
    expect(a!.postsSeen).toBe(3)
    expect(a!.postsFlagged).toBe(2)
    expect(a!.lastSeen).toBe(3)
    expect(a!.firstSeen).toBe(1)
  })

  it('does NOT double-count when the same cache key is written twice', async () => {
    // A re-render or a second scroll past the same post must not inflate the leaderboard.
    await record({ cacheKey: 'same' })
    await record({ cacheKey: 'same' })
    const [a] = await allAuthors()
    expect(a!.postsSeen).toBe(1)
    expect(a!.postsFlagged).toBe(1)
  })

  it('keeps separate authors separate', async () => {
    await record({ cacheKey: 'k1', authorUrn: 'urn:alice', authorName: 'Alice' })
    await record({ cacheKey: 'k2', authorUrn: 'urn:bob', authorName: 'Bob' })
    const authors = await allAuthors()
    expect(authors.map((a) => a.authorUrn).sort()).toEqual(['urn:alice', 'urn:bob'])
  })

  it('updates a changed display name', async () => {
    await record({ cacheKey: 'k1', authorName: 'Alice' })
    await record({ cacheKey: 'k2', authorName: 'Alice Smith' })
    expect((await allAuthors())[0]!.authorName).toBe('Alice Smith')
  })
})

describe('recentVerdicts', () => {
  it('returns newest first', async () => {
    await record({ cacheKey: 'old', at: 100, verdict: verdict({ postId: 'old' }) })
    await record({ cacheKey: 'new', at: 200, verdict: verdict({ postId: 'new' }) })
    const rows = await recentVerdicts()
    expect(rows.map((r) => r.postId)).toEqual(['new', 'old'])
  })

  it('can filter to collapsed only', async () => {
    await record({ cacheKey: 'shown', at: 1, verdict: verdict({ postId: 's', action: 'show' }) })
    await record({ cacheKey: 'hidden', at: 2, verdict: verdict({ postId: 'h' }) })
    const rows = await recentVerdicts(100, true)
    expect(rows.map((r) => r.postId)).toEqual(['h'])
  })

  it('honours the limit', async () => {
    for (let i = 0; i < 10; i++) {
      await record({ cacheKey: `k${i}`, at: i, verdict: verdict({ postId: `p${i}` }) })
    }
    expect(await recentVerdicts(3)).toHaveLength(3)
  })
})

describe('labels', () => {
  it('stores and reads back by axis', async () => {
    await putLabel({ postId: 'p1', axis: 'engagement_bait', userSays: true, verdictAtTime: 80, at: 1 })
    const labels = await labelsForAxis('engagement_bait')
    expect(labels).toHaveLength(1)
    expect(labels[0]!.userSays).toBe(true)
  })

  it('a re-vote on the same post and axis overwrites rather than duplicating', async () => {
    await putLabel({ postId: 'p1', axis: 'engagement_bait', userSays: true, verdictAtTime: 80, at: 1 })
    await putLabel({ postId: 'p1', axis: 'engagement_bait', userSays: false, verdictAtTime: 80, at: 2 })
    const labels = await labelsForAxis('engagement_bait')
    expect(labels).toHaveLength(1)
    expect(labels[0]!.userSays).toBe(false)
  })

  it('keeps axes independent for the same post', async () => {
    await putLabel({ postId: 'p1', axis: 'engagement_bait', userSays: true, verdictAtTime: 80, at: 1 })
    await putLabel({ postId: 'p1', axis: 'ai_written', userSays: false, verdictAtTime: 70, at: 1 })
    expect(await labelsForAxis('engagement_bait')).toHaveLength(1)
    expect(await labelsForAxis('ai_written')).toHaveLength(1)
  })
})

describe('retention', () => {
  it('purges old verdicts and keeps new ones', async () => {
    await record({ cacheKey: 'old', at: 100, verdict: verdict({ postId: 'old' }) })
    await record({ cacheKey: 'new', at: 5_000, verdict: verdict({ postId: 'new' }) })
    const deleted = await purgeOlderThan(1_000)
    expect(deleted).toBe(1)
    expect(await getVerdict('old')).toBeUndefined()
    expect(await getVerdict('new')).toBeDefined()
  })

  it('keeps a record exactly on the boundary', async () => {
    await record({ cacheKey: 'edge', at: 1_000 })
    await purgeOlderThan(1_000)
    expect(await getVerdict('edge')).toBeDefined()
  })

  it('purging an empty store is a no-op', async () => {
    expect(await purgeOlderThan(Number.MAX_SAFE_INTEGER)).toBe(0)
  })

  it('purgeAll empties every store', async () => {
    await record()
    await putLabel({ postId: 'p1', axis: 'engagement_bait', userSays: true, verdictAtTime: 8, at: 1 })
    await purgeAll()
    expect(await getVerdict('k1')).toBeUndefined()
    expect(await allAuthors()).toEqual([])
    expect(await labelsForAxis('engagement_bait')).toEqual([])
  })
})

describe('transaction discipline', () => {
  it('commits the verdict and the aggregate together under concurrent writes', async () => {
    // If the aggregate write were in a separate transaction, interleaving would lose updates.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        record({ cacheKey: `k${i}`, at: i, verdict: verdict({ postId: `p${i}` }) }),
      ),
    )
    const [a] = await allAuthors()
    expect(a!.postsSeen).toBe(25)
    expect(a!.postsFlagged).toBe(25)
    expect(await recentVerdicts(100)).toHaveLength(25)
  })
})
