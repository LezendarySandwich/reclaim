import { describe, expect, it } from 'vitest'
import { deriveIdentity, extractComponentKeyId, extractUrn, isDurable } from './identity'

describe('extractUrn', () => {
  it.each([
    ['urn:li:activity:7123456789', 'activity:7123456789'],
    ['urn:li:ugcPost:7123456789', 'activity:7123456789'],
    ['urn:li:share:7123456789', 'activity:7123456789'],
    ['/feed/update/urn:li:activity:7123456789/', 'activity:7123456789'],
    ['prefix urn:li:activity:999 suffix', 'activity:999'],
  ])('pulls an id out of %s', (input, expected) => {
    expect(extractUrn(input)).toBe(expected)
  })

  it.each([null, undefined, '', 'urn:li:person:abc', 'nothing here'])(
    'returns null for %s',
    (input) => {
      expect(extractUrn(input)).toBeNull()
    },
  )
})

describe('deriveIdentity — preference order', () => {
  const base = { authorUrn: 'urn:li:person:alice', text: 'Some post text here.' }

  it('prefers a real URN', () => {
    expect(
      deriveIdentity({
        ...base,
        urnCandidates: ['urn:li:activity:111'],
        permalink: '/feed/update/urn:li:activity:222/',
      }),
    ).toEqual({ id: 'activity:111', strategy: 'urn' })
  })

  it('falls back to the permalink', () => {
    expect(
      deriveIdentity({
        ...base,
        urnCandidates: [null, undefined, 'not-a-urn'],
        permalink: '/feed/update/urn:li:activity:222/',
      }),
    ).toEqual({ id: 'activity:222', strategy: 'permalink' })
  })

  it('falls back to a composite hash — the modern feed case', () => {
    const got = deriveIdentity({ ...base, urnCandidates: [] })
    expect(got?.strategy).toBe('composite')
    expect(got?.id).toMatch(/^c:/)
  })

  it('returns null when there is nothing to work with', () => {
    // An unfilled lazily-mounted feed row. Must be "not ready", never an invented id.
    expect(deriveIdentity({ urnCandidates: [], authorUrn: 'urn:li:person:alice', text: '   ' }))
      .toBeNull()
  })
})

describe('composite identity stability', () => {
  const base = { urnCandidates: [], authorUrn: 'urn:li:person:alice' }

  it('is stable across whitespace re-rendering', () => {
    const a = deriveIdentity({ ...base, text: 'Hello  world\n\nagain' })
    const b = deriveIdentity({ ...base, text: 'Hello world again' })
    expect(a?.id).toBe(b?.id)
  })

  it('does NOT change when a post is expanded past 400 chars', () => {
    // The critical property. If expanding "…see more" changed the id, every expansion would look
    // like a brand-new post and the leaderboard would double-count.
    const head = 'x'.repeat(400)
    const collapsed = deriveIdentity({ ...base, text: head })
    const expanded = deriveIdentity({ ...base, text: `${head} plus a great deal more text` })
    expect(collapsed?.id).toBe(expanded?.id)
  })

  it('differs between authors posting identical text', () => {
    const a = deriveIdentity({ ...base, text: 'Thrilled to announce!' })
    const b = deriveIdentity({
      urnCandidates: [],
      authorUrn: 'urn:li:person:bob',
      text: 'Thrilled to announce!',
    })
    expect(a?.id).not.toBe(b?.id)
  })

  it('differs between reposts of the same text at different times', () => {
    const a = deriveIdentity({ ...base, text: 'Same text', timestamp: '2h' })
    const b = deriveIdentity({ ...base, text: 'Same text', timestamp: '3d' })
    expect(a?.id).not.toBe(b?.id)
  })

  it('handles emoji and CJK without throwing', () => {
    expect(() =>
      deriveIdentity({ ...base, text: '🚀 很高兴宣布 مرحبا' }),
    ).not.toThrow()
  })
})

describe('isDurable', () => {
  it('treats URN and permalink ids as durable', () => {
    expect(isDurable('urn')).toBe(true)
    expect(isDurable('permalink')).toBe(true)
  })

  it('treats composite ids as not durable', () => {
    // Allowed in history — excluding them would mean the modern feed collects nothing — but the
    // dashboard must not present a tally built on them as more certain than it is.
    expect(isDurable('composite')).toBe(false)
  })
})

describe('componentkey identity — the modern feed’s only per-post id (S4)', () => {
  const REAL = 'expanded7cdbt_jwDmDtd5s0G2glmqfjUhVmI_JvbKvFl2n10wQFeedType_MAIN_FEED_RELEVANCE'

  it('extracts the opaque id from a real captured componentkey', () => {
    expect(extractComponentKeyId(REAL)).toBe('ck:7cdbt_jwDmDtd5s0G2glmqfjUhVmI_JvbKvFl2n10wQ')
  })

  it('handles the recent-feed variant too', () => {
    expect(extractComponentKeyId('expandedABCDEFGHIJKLMNOPQRFeedType_MAIN_FEED_RECENT')).toBe(
      'ck:ABCDEFGHIJKLMNOPQR',
    )
  })

  it('REJECTS shared template keys — the collision trap prior art fell into', () => {
    // A prior-art repo hashes componentkey blindly; values like `body-key` are identical on every
    // post, so every post on the page would share an id.
    for (const key of ['body-key', 'author-name-key', 'post-inner-key', 'social-proof-bar-key']) {
      expect(extractComponentKeyId(key)).toBeNull()
    }
  })

  it('rejects a key with too short an id to be real', () => {
    expect(extractComponentKeyId('expandedXFeedType_MAIN_FEED')).toBeNull()
  })

  it.each([null, undefined, '', 'nonsense'])('returns null for %s', (v) => {
    expect(extractComponentKeyId(v)).toBeNull()
  })

  it('is preferred over a composite hash', () => {
    const got = deriveIdentity({
      urnCandidates: [],
      componentKey: REAL,
      authorUrn: 'urn:li:person:alice',
      text: 'Some text',
    })
    expect(got?.strategy).toBe('componentkey')
  })

  it('still yields to a real URN if one ever appears', () => {
    const got = deriveIdentity({
      urnCandidates: ['urn:li:activity:999'],
      componentKey: REAL,
      authorUrn: 'urn:li:person:alice',
      text: 'Some text',
    })
    expect(got?.strategy).toBe('urn')
  })

  it('falls through to composite when the key is a template key', () => {
    const got = deriveIdentity({
      urnCandidates: [],
      componentKey: 'body-key',
      authorUrn: 'urn:li:person:alice',
      text: 'Some text',
    })
    expect(got?.strategy).toBe('composite')
  })

  it('counts as durable, unlike a composite hash', () => {
    expect(isDurable('componentkey')).toBe(true)
    expect(isDurable('composite')).toBe(false)
  })
})
