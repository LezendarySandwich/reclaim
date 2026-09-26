import { describe, expect, it } from 'vitest'
import { GATE_COPY, gateState, mayReadPosts } from './consent'

describe('gateState', () => {
  it('requires consent before anything else', () => {
    expect(gateState({ hasConsent: false, hasHostPermission: true }).status).toBe('needs_consent')
    expect(gateState({ hasConsent: false, hasHostPermission: false }).status).toBe('needs_consent')
  })

  it('names the permission once consent exists', () => {
    expect(gateState({ hasConsent: true, hasHostPermission: false }).status).toBe(
      'needs_permission',
    )
  })

  it('is active only when both hold', () => {
    expect(gateState({ hasConsent: true, hasHostPermission: true }).status).toBe('active')
  })
})

describe('mayReadPosts', () => {
  it.each([
    [{ hasConsent: false, hasHostPermission: false }, false],
    [{ hasConsent: false, hasHostPermission: true }, false],
    [{ hasConsent: true, hasHostPermission: false }, false],
    [{ hasConsent: true, hasHostPermission: true }, true],
  ] as const)('%j -> %s', (input, expected) => {
    expect(mayReadPosts(gateState(input))).toBe(expected)
  })

  it('treats a revoked permission as immediately closing the gate', () => {
    // A user can revoke in chrome://extensions without touching our settings. Consent alone is
    // never sufficient.
    expect(mayReadPosts(gateState({ hasConsent: true, hasHostPermission: false }))).toBe(false)
  })
})

describe('GATE_COPY', () => {
  it('covers every state, so a new state cannot ship without user-facing copy', () => {
    for (const status of ['needs_consent', 'needs_permission', 'active'] as const) {
      expect(GATE_COPY[status].title.length).toBeGreaterThan(0)
      expect(GATE_COPY[status].detail.length).toBeGreaterThan(0)
    }
  })

  it('tells the user what is read and where it stays', () => {
    const detail = GATE_COPY.needs_consent.detail
    expect(detail).toMatch(/reads the text/i)
    expect(detail).toMatch(/on your device/i)
    expect(detail).toMatch(/delete/i)
  })
})
