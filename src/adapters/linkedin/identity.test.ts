import { describe, expect, it } from 'vitest'
import { deriveIdentity, extractUrn, isDurable } from './identity'

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
