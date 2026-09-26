import { describe, expect, it } from 'vitest'
import { explain, mergeVerdict } from './verdict'
import type { MergeInput } from './verdict'
import { DEFAULT_SETTINGS } from './types'
import type { Axis, ContentSignal, EngineState, Settings, SignalSource } from './types'

const READY: EngineState = { status: 'ready', engineId: 'gemini-nano' }

function sig(score: number, source: SignalSource = 'model'): ContentSignal {
  return { score, source }
}

function input(over: Partial<MergeInput> = {}): MergeInput {
  return {
    post: { id: 'p1', authorUrn: 'urn:li:person:alice' },
    signals: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    engineState: READY,
    engineId: 'gemini-nano',
    rulesVersion: 'r1',
    ...over,
  }
}

/** engagement_bait is the only default-enabled axis (ADR-019), so it is the baseline hide case. */
function baitAt(score: number, source: SignalSource = 'model') {
  return [{ axis: 'engagement_bait' as Axis, signal: sig(score, source) }]
}

describe('fail open (ADR-005)', () => {
  const notReady: EngineState[] = [
    { status: 'uninitialized' },
    { status: 'checking' },
    { status: 'needs_setup' },
    { status: 'downloading', fraction: 0 },
    { status: 'downloading', fraction: 1 },
    { status: 'degraded', reason: 'no_webgpu' },
    { status: 'degraded', reason: 'unsupported_hardware_or_policy' },
    { status: 'degraded', reason: 'download_failed' },
    { status: 'degraded', reason: 'engine_error' },
  ]

  it.each(notReady)('shows even at score 100 when engine is %j', (engineState) => {
    const r = mergeVerdict(input({ engineState, signals: baitAt(100) }))
    expect(r.verdict.action).toBe('show')
    expect(r.reason).toBe('no_model')
    expect(r.verdict.triggeredBy).toEqual([])
  })

  it('still records the signal while failing open, so shadow data keeps accumulating', () => {
    const r = mergeVerdict(
      input({ engineState: { status: 'needs_setup' }, signals: baitAt(95) }),
    )
    expect(r.verdict.signals.engagement_bait?.score).toBe(95)
  })
})

describe('heuristics route but never judge (ADR-004)', () => {
  it('will not collapse on a heuristic signal alone, however high', () => {
    const r = mergeVerdict(input({ signals: baitAt(100, 'heuristic') }))
    expect(r.verdict.action).toBe('show')
    expect(r.reason).toBe('no_deciding_signal')
  })

  it('still records the heuristic signal for the dashboard', () => {
    const r = mergeVerdict(input({ signals: baitAt(100, 'heuristic') }))
    expect(r.verdict.signals.engagement_bait).toEqual({ score: 100, source: 'heuristic' })
  })

  it('lets the model decide when both a model and a heuristic signal exist', () => {
    // The heuristic screams; the model disagrees. The model governs.
    const r = mergeVerdict(
      input({
        signals: [
          { axis: 'engagement_bait', signal: sig(99, 'heuristic') },
          { axis: 'engagement_bait', signal: sig(10, 'model') },
        ],
      }),
    )
    expect(r.verdict.action).toBe('show')
    expect(r.verdict.signals.engagement_bait?.source).toBe('model')
    expect(r.verdict.signals.engagement_bait?.score).toBe(10)
  })

  it('collapses when the model agrees, regardless of signal order', () => {
    const r = mergeVerdict(
      input({
        signals: [
          { axis: 'engagement_bait', signal: sig(90, 'model') },
          { axis: 'engagement_bait', signal: sig(5, 'heuristic') },
        ],
      }),
    )
    expect(r.verdict.action).toBe('collapse')
  })

  it('does not let a metadata signal hide on its own in v1', () => {
    // Deliberate: a second path to collapse that bypasses the model is the shape of bug ADR-005
    // exists to prevent. Revisit in phase 3 when a real metadata source ships.
    const r = mergeVerdict(input({ signals: baitAt(100, 'metadata') }))
    expect(r.verdict.action).toBe('show')
  })
})

describe('axis modes (ADR-019)', () => {
  it('a shadow axis never collapses, even at 100', () => {
    // Tests the MECHANISM, not the default. ai_written was shadow by default until ADR-025;
    // the mode still has to work for any axis set to it.
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.axes.ai_written.mode = 'shadow'
    const r = mergeVerdict(input({ settings, signals: [{ axis: 'ai_written', signal: sig(100) }] }))
    expect(r.verdict.action).toBe('show')
    expect(r.verdict.signals.ai_written?.score).toBe(100)
  })

  it('engagement_bait is enabled by default and does collapse', () => {
    const r = mergeVerdict(input({ signals: baitAt(100) }))
    expect(r.verdict.action).toBe('collapse')
    expect(r.verdict.triggeredBy).toEqual(['engagement_bait'])
  })

  it('an off axis is neither recorded nor able to trigger', () => {
    const r = mergeVerdict(input({ signals: [{ axis: 'sponsored', signal: sig(100) }] }))
    expect(r.verdict.action).toBe('show')
    expect(r.verdict.signals.sponsored).toBeUndefined()
  })

  it('global shadowMode downgrades an enabled axis', () => {
    const settings: Settings = { ...structuredClone(DEFAULT_SETTINGS), shadowMode: true }
    const r = mergeVerdict(input({ settings, signals: baitAt(100) }))
    expect(r.verdict.action).toBe('show')
    expect(r.reason).toBe('shadow_mode')
  })

  it('global shadowMode cannot promote a shadow axis', () => {
    const settings: Settings = { ...structuredClone(DEFAULT_SETTINGS), shadowMode: true }
    const r = mergeVerdict(input({ settings, signals: [{ axis: 'ai_written', signal: sig(100) }] }))
    expect(r.verdict.action).toBe('show')
  })
})

describe('thresholds', () => {
  it('collapses exactly at the threshold, not just above it', () => {
    const t = DEFAULT_SETTINGS.axes.engagement_bait.threshold
    expect(mergeVerdict(input({ signals: baitAt(t) })).verdict.action).toBe('collapse')
  })

  it('shows one point below the threshold', () => {
    const t = DEFAULT_SETTINGS.axes.engagement_bait.threshold
    const r = mergeVerdict(input({ signals: baitAt(t - 1) }))
    expect(r.verdict.action).toBe('show')
    expect(r.reason).toBe('below_threshold')
  })

  it('honours a user-raised threshold', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.axes.engagement_bait.threshold = 95
    expect(mergeVerdict(input({ settings, signals: baitAt(90) })).verdict.action).toBe('show')
  })
})

describe('allowlist', () => {
  it('never collapses an allowlisted author', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.allowlist = ['urn:li:person:alice']
    const r = mergeVerdict(input({ settings, signals: baitAt(100) }))
    expect(r.verdict.action).toBe('show')
    expect(r.reason).toBe('allowlisted')
  })

  it('still scores them, so the accuracy denominator stays unbiased', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.allowlist = ['urn:li:person:alice']
    const r = mergeVerdict(input({ settings, signals: baitAt(100) }))
    expect(r.verdict.signals.engagement_bait?.score).toBe(100)
  })

  it('does not match a different author', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.allowlist = ['urn:li:person:bob']
    expect(mergeVerdict(input({ settings, signals: baitAt(100) })).verdict.action).toBe('collapse')
  })
})

describe('multi-axis', () => {
  it('reports every enabled axis that fired, in stable order', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.axes.ai_written.mode = 'enabled'
    settings.axes.ai_written.threshold = 50
    const r = mergeVerdict(
      input({
        settings,
        signals: [
          { axis: 'engagement_bait', signal: sig(90) },
          { axis: 'ai_written', signal: sig(90) },
        ],
      }),
    )
    expect(r.verdict.triggeredBy).toEqual(['ai_written', 'engagement_bait'])
  })

  it('a shadow axis is excluded from triggeredBy even when a sibling fires', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.axes.ai_written.mode = 'shadow'
    const r = mergeVerdict(
      input({
        settings,
        signals: [
          { axis: 'engagement_bait', signal: sig(90) },
          { axis: 'ai_written', signal: sig(100) },
        ],
      }),
    )
    expect(r.verdict.triggeredBy).toEqual(['engagement_bait'])
  })
})

describe('edge cases', () => {
  it('shows when there are no signals at all', () => {
    const r = mergeVerdict(input())
    expect(r.verdict.action).toBe('show')
    expect(r.reason).toBe('no_deciding_signal')
  })

  it('carries engineId and rulesVersion through for cache invalidation', () => {
    const r = mergeVerdict(input({ engineId: 'qwen3-0.6b', rulesVersion: 'r9' }))
    expect(r.verdict.engineId).toBe('qwen3-0.6b')
    expect(r.verdict.rulesVersion).toBe('r9')
  })
})

describe('explain', () => {
  it('is empty for a shown post', () => {
    expect(explain(mergeVerdict(input()).verdict)).toBe('')
  })

  it('never renders a confidence number (ADR-019)', () => {
    const text = explain(mergeVerdict(input({ signals: baitAt(87) })).verdict)
    expect(text).not.toMatch(/\d/)
  })

  it('does not assert authorship as fact', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.axes.ai_written.mode = 'enabled'
    const r = mergeVerdict(input({ settings, signals: [{ axis: 'ai_written', signal: sig(99) }] }))
    const text = explain(r.verdict)
    expect(text).toBe('Looks templated')
    expect(text.toLowerCase()).not.toContain('ai-written')
  })

  it('joins multiple axes', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.axes.ai_written.mode = 'enabled'
    const r = mergeVerdict(
      input({
        settings,
        signals: [
          { axis: 'engagement_bait', signal: sig(99) },
          { axis: 'ai_written', signal: sig(99) },
        ],
      }),
    )
    expect(explain(r.verdict)).toBe('Looks templated · Looks like engagement bait')
  })
})

describe('ai_written at high confidence only (ADR-025)', () => {
  // The ladder: none=0, slight=15, some=38, clear=65, strong=85, blatant=97. A threshold of 90
  // means exactly one rung qualifies, and "strong" deliberately does not.
  it('hides on blatant', () => {
    const r = mergeVerdict(input({ signals: [{ axis: 'ai_written', signal: sig(97) }] }))
    expect(r.verdict.action).toBe('collapse')
    expect(r.verdict.triggeredBy).toEqual(['ai_written'])
  })

  it('does NOT hide on strong — one rung is the entire safety margin', () => {
    const r = mergeVerdict(input({ signals: [{ axis: 'ai_written', signal: sig(85) }] }))
    expect(r.verdict.action).toBe('show')
  })

  it.each([0, 15, 38, 65, 85])('does not hide at rung score %i', (score) => {
    expect(
      mergeVerdict(input({ signals: [{ axis: 'ai_written', signal: sig(score) }] })).verdict.action,
    ).toBe('show')
  })

  it('still refuses a heuristic signal however high', () => {
    // ADR-004 is unaffected by enabling the axis: regex-grade rules for AI authorship are a
    // proxy for "non-native or formal writer", which is the whole reason they may never hide.
    const r = mergeVerdict(input({ signals: [{ axis: 'ai_written', signal: sig(100, 'heuristic') }] }))
    expect(r.verdict.action).toBe('show')
  })

  it('still fails open with no model', () => {
    const r = mergeVerdict(
      input({ engineState: { status: 'needs_setup' }, signals: [{ axis: 'ai_written', signal: sig(97) }] }),
    )
    expect(r.verdict.action).toBe('show')
  })

  it('is far stricter than engagement_bait, which hides from 70', () => {
    expect(DEFAULT_SETTINGS.axes.ai_written.threshold).toBeGreaterThan(
      DEFAULT_SETTINGS.axes.engagement_bait.threshold,
    )
  })
})
