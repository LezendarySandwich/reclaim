import { describe, expect, it } from 'vitest'
import { ALL_AXES, canHide } from './types'
import type { EngineState } from './types'

describe('canHide', () => {
  // ADR-005: fail open. This is the single gate that enforces it, so it gets exhaustive coverage —
  // a bug here means hiding posts with no working model, which is the one failure mode the whole
  // design exists to prevent.
  const nonReady: EngineState[] = [
    { status: 'uninitialized' },
    { status: 'checking' },
    { status: 'needs_setup' },
    { status: 'downloading', fraction: 0 },
    { status: 'downloading', fraction: 0.99 },
    { status: 'degraded', reason: 'no_webgpu' },
    { status: 'degraded', reason: 'unsupported_hardware_or_policy' },
    { status: 'degraded', reason: 'download_failed' },
    { status: 'degraded', reason: 'engine_error' },
  ]

  it.each(nonReady)('refuses to hide in state %j', (state) => {
    expect(canHide(state)).toBe(false)
  })

  it('permits hiding only when ready', () => {
    expect(canHide({ status: 'ready', engineId: 'gemini-nano' })).toBe(true)
  })

  it('narrows the type so engineId is reachable', () => {
    const state: EngineState = { status: 'ready', engineId: 'gemini-nano' }
    if (canHide(state)) {
      expect(state.engineId).toBe('gemini-nano')
    } else {
      expect.fail('expected ready state to narrow')
    }
  })

  it('a download at 100% still cannot hide — only an explicit ready transition can', () => {
    expect(canHide({ status: 'downloading', fraction: 1 })).toBe(false)
  })
})

describe('ALL_AXES', () => {
  it('has no duplicates', () => {
    expect(new Set(ALL_AXES).size).toBe(ALL_AXES.length)
  })

  it('includes the two axes v1 ships and the two it leaves seams for', () => {
    expect(ALL_AXES).toContain('ai_written')
    expect(ALL_AXES).toContain('engagement_bait')
    expect(ALL_AXES).toContain('ai_image')
    expect(ALL_AXES).toContain('sponsored')
  })
})
