import { describe, expect, it } from 'vitest'
import { rankOffenders, summarizeAgreement } from './aggregates'
import type { AuthorAggregate } from './schema'

function author(over: Partial<AuthorAggregate> & { authorUrn: string }): AuthorAggregate {
  return {
    authorName: over.authorUrn,
    postsSeen: 10,
    postsFlagged: 0,
    scoreSum: 0,
    firstSeen: 0,
    lastSeen: 0,
    ...over,
  }
}

describe('rankOffenders', () => {
  it('ranks a sustained 40-of-100 above a one-off 1-of-1', () => {
    // The case the ranking rule exists for. A 100% rate on a single post is not a finding.
    const ranked = rankOffenders(
      [
        author({ authorUrn: 'sustained', postsSeen: 100, postsFlagged: 40 }),
        author({ authorUrn: 'oneoff', postsSeen: 1, postsFlagged: 1 }),
      ],
      { minPosts: 1 },
    )
    expect(ranked[0]?.authorUrn).toBe('sustained')
  })

  it('excludes authors below the minimum-post floor entirely', () => {
    const ranked = rankOffenders([author({ authorUrn: 'oneoff', postsSeen: 1, postsFlagged: 1 })])
    expect(ranked).toHaveLength(0)
  })

  it('does not let a prolific clean poster onto the board', () => {
    const ranked = rankOffenders([
      author({ authorUrn: 'prolific-clean', postsSeen: 500, postsFlagged: 0 }),
      author({ authorUrn: 'bad', postsSeen: 20, postsFlagged: 15 }),
    ])
    expect(ranked.map((r) => r.authorUrn)).toEqual(['bad'])
  })

  it('prefers the higher rate when volume is equal', () => {
    const ranked = rankOffenders([
      author({ authorUrn: 'low', postsSeen: 100, postsFlagged: 10 }),
      author({ authorUrn: 'high', postsSeen: 20, postsFlagged: 10 }),
    ])
    expect(ranked[0]?.authorUrn).toBe('high')
  })

  it('breaks a rate tie by sustained volume', () => {
    const ranked = rankOffenders([
      author({ authorUrn: 'few', postsSeen: 10, postsFlagged: 5 }),
      author({ authorUrn: 'many', postsSeen: 100, postsFlagged: 50 }),
    ])
    expect(ranked[0]?.authorUrn).toBe('many')
  })

  it('computes flagRate and meanScore', () => {
    const ranked = rankOffenders([
      author({ authorUrn: 'a', postsSeen: 10, postsFlagged: 4, scoreSum: 600 }),
    ])
    expect(ranked[0]?.flagRate).toBeCloseTo(0.4)
    expect(ranked[0]?.meanScore).toBeCloseTo(60)
  })

  it('honours the limit', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      author({ authorUrn: `a${i}`, postsSeen: 10, postsFlagged: 5 }),
    )
    expect(rankOffenders(many, { limit: 7 })).toHaveLength(7)
  })

  it('returns an empty list for no authors', () => {
    expect(rankOffenders([])).toEqual([])
  })

  it('does not divide by zero on a zero-post record', () => {
    expect(() => rankOffenders([author({ authorUrn: 'z', postsSeen: 0 })], { minPosts: 0 })).not.toThrow()
  })
})

describe('summarizeAgreement', () => {
  it('withholds a rate below the minimum sample rather than reporting a misleading one', () => {
    const s = summarizeAgreement([{ userSays: true }, { userSays: false }])
    expect(s.agreementRate).toBeNull()
    expect(s.total).toBe(2)
  })

  it('reports a rate once there is enough data', () => {
    const labels = [
      ...Array.from({ length: 8 }, () => ({ userSays: true })),
      ...Array.from({ length: 2 }, () => ({ userSays: false })),
    ]
    expect(summarizeAgreement(labels).agreementRate).toBeCloseTo(0.8)
  })

  it('handles an empty label set', () => {
    expect(summarizeAgreement([])).toEqual({ total: 0, agreed: 0, agreementRate: null })
  })
})
