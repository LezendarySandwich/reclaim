import { describe, expect, it, vi } from 'vitest'
import { classifyBatch } from './pipeline'
import { DEFAULT_SETTINGS } from './types'
import type { EngineState, Post, Settings } from './types'
import type { TriagedPost } from './messages'
import type { EngineJudgement, ModelEngine } from '../engines/types'

const READY: EngineState = { status: 'ready', engineId: 'gemini-nano' }

function post(id: string, text = 'Some post text that is long enough.'): Post {
  return {
    id,
    authorUrn: `urn:li:person:${id}`,
    authorName: id,
    text,
    media: [],
    isPromoted: false,
    isRepost: false,
    site: 'linkedin',
  }
}

function triaged(id: string, heuristics: TriagedPost['heuristics'] = {}): TriagedPost {
  return { post: post(id), heuristics, band: 'ambiguous' }
}

function fakeEngine(scores: Record<string, number> | (() => never)): ModelEngine {
  return {
    id: 'gemini-nano',
    availability: async () => 'available',
    load: async () => {},
    unload: async () => {},
    judge: async (): Promise<EngineJudgement> => {
      if (typeof scores === 'function') scores()
      return { scores: scores as never, reason: 'because', engineId: 'gemini-nano', elapsedMs: 1 }
    },
  }
}

const base = (over: Partial<Settings> = {}) => ({
  settings: { ...structuredClone(DEFAULT_SETTINGS), ...over },
  engineState: READY,
  rulesVersion: 'r1',
})

describe('engine-state gate', () => {
  it.each([
    { status: 'needs_setup' },
    { status: 'downloading', fraction: 0.5 },
    { status: 'degraded', reason: 'no_webgpu' },
  ] as EngineState[])('skips inference entirely when engine is %j', async (engineState) => {
    const judge = vi.fn()
    const engine = { ...fakeEngine({}), judge }
    const out = await classifyBatch([triaged('a')], { ...base(), engine, engineState })
    expect(judge).not.toHaveBeenCalled()
    expect(out[0]!.verdict.action).toBe('show')
  })

  it('still records heuristics while failing open, so shadow data stays complete', async () => {
    const out = await classifyBatch([triaged('a', { engagement_bait: 55 })], {
      ...base(),
      engine: fakeEngine({}),
      engineState: { status: 'needs_setup' },
    })
    expect(out[0]!.verdict.signals.engagement_bait).toEqual({ score: 55, source: 'heuristic' })
  })
})

describe('with a working model', () => {
  it('collapses when the model scores above threshold', async () => {
    const out = await classifyBatch([triaged('a')], {
      ...base(),
      engine: fakeEngine({ engagement_bait: 97 }),
    })
    expect(out[0]!.verdict.action).toBe('collapse')
    expect(out[0]!.verdict.triggeredBy).toEqual(['engagement_bait'])
  })

  it('records both the heuristic and the model signal, model winning', async () => {
    const out = await classifyBatch([triaged('a', { engagement_bait: 20 })], {
      ...base(),
      engine: fakeEngine({ engagement_bait: 97 }),
    })
    // toMatchObject, not toEqual: the signal now also carries the model's reason.
    expect(out[0]!.verdict.signals.engagement_bait).toMatchObject({ score: 97, source: 'model' })
  })

  it('does not collapse on a shadow axis even at 100', async () => {
    // Tests the mechanism rather than the default — ai_written became `enabled` in ADR-025, but
    // shadow mode still has to work for whichever axis is set to it.
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.axes.ai_written.mode = 'shadow'
    const out = await classifyBatch([triaged('a')], {
      ...base(),
      settings,
      engine: fakeEngine({ ai_written: 100 }),
    })
    expect(out[0]!.verdict.action).toBe('show')
    expect(out[0]!.verdict.signals.ai_written?.score).toBe(100)
  })

  it('fails open when the engine throws', async () => {
    const engine = fakeEngine(() => {
      throw new Error('engine exploded')
    })
    const out = await classifyBatch([triaged('a', { engagement_bait: 99 })], { ...base(), engine })
    expect(out[0]!.verdict.action).toBe('show')
    expect(out[0]!.verdict.signals.engagement_bait?.source).toBe('heuristic')
  })
})

describe('cache keys', () => {
  it('differ per post and are stable per input', async () => {
    const deps = { ...base(), engine: fakeEngine({}) }
    const out = await classifyBatch([triaged('a'), triaged('b')], deps)
    expect(out[0]!.cacheKey).not.toBe(out[1]!.cacheKey)
    const again = await classifyBatch([triaged('a')], deps)
    expect(again[0]!.cacheKey).toBe(out[0]!.cacheKey)
  })

  it('change when the rules version moves', async () => {
    const a = await classifyBatch([triaged('a')], { ...base(), engine: fakeEngine({}) })
    const b = await classifyBatch([triaged('a')], {
      ...base(),
      engine: fakeEngine({}),
      rulesVersion: 'r2',
    })
    expect(a[0]!.cacheKey).not.toBe(b[0]!.cacheKey)
  })
})

describe('batching', () => {
  it('returns one result per input, in order', async () => {
    const out = await classifyBatch(
      [triaged('a'), triaged('b'), triaged('c')],
      { ...base(), engine: fakeEngine({}) },
    )
    expect(out.map((o) => o.verdict.postId)).toEqual(['a', 'b', 'c'])
  })

  it('handles an empty batch', async () => {
    expect(await classifyBatch([], { ...base(), engine: fakeEngine({}) })).toEqual([])
  })

  it('serialises inference through the scheduler', async () => {
    let concurrent = 0
    let peak = 0
    const engine: ModelEngine = {
      ...fakeEngine({}),
      judge: async () => {
        concurrent++
        peak = Math.max(peak, concurrent)
        await new Promise((r) => setTimeout(r, 2))
        concurrent--
        return { scores: {}, reason: '', engineId: 'gemini-nano', elapsedMs: 1 }
      },
    }
    await classifyBatch(
      Array.from({ length: 6 }, (_, i) => triaged(`p${i}`)),
      { ...base(), engine },
    )
    expect(peak).toBe(1)
  })
})

describe('verdict cache', () => {
  it('skips inference entirely on a cache hit', async () => {
    const judge = vi.fn()
    const engine: ModelEngine = { ...fakeEngine({}), judge }
    const out = await classifyBatch([triaged('a')], {
      ...base(),
      engine,
      lookupCached: async () => ({
        signals: { engagement_bait: { score: 97, source: 'model', reason: 'cached reason' } },
      }),
    })
    expect(judge).not.toHaveBeenCalled()
    expect(out[0]!.fromCache).toBe(true)
    expect(out[0]!.verdict.action).toBe('collapse')
    expect(out[0]!.reason).toBe('cached reason')
  })

  it('falls through to the model on a miss', async () => {
    const out = await classifyBatch([triaged('a')], {
      ...base(),
      engine: fakeEngine({ engagement_bait: 97 }),
      lookupCached: async () => null,
    })
    expect(out[0]!.fromCache).toBe(false)
    expect(out[0]!.verdict.action).toBe('collapse')
  })

  it('treats a storage failure as a miss, never a classification failure', async () => {
    const out = await classifyBatch([triaged('a')], {
      ...base(),
      engine: fakeEngine({ engagement_bait: 97 }),
      lookupCached: async () => {
        throw new Error('IndexedDB exploded')
      },
    })
    expect(out[0]!.verdict.action).toBe('collapse')
  })

  it('ignores a cached row that holds only heuristic signals', async () => {
    // A heuristic-only row is not a model verdict, so it must not stand in for one.
    const judge = vi.fn(async () => ({
      scores: { engagement_bait: 97 },
      reason: 'fresh',
      engineId: 'gemini-nano' as const,
      elapsedMs: 1,
    }))
    const engine: ModelEngine = { ...fakeEngine({}), judge }
    await classifyBatch([triaged('a')], {
      ...base(),
      engine,
      lookupCached: async () => ({
        signals: { engagement_bait: { score: 40, source: 'heuristic' } },
      }),
    })
    expect(judge).toHaveBeenCalledOnce()
  })
})

describe('the model reason reaches the verdict', () => {
  it('is attached to the model signal', async () => {
    const out = await classifyBatch([triaged('a')], {
      ...base(),
      engine: fakeEngine({ engagement_bait: 97 }),
    })
    // Previously computed on every call and thrown away, so the stub could only show a generic
    // label when the model had said something specific.
    expect(out[0]!.verdict.signals.engagement_bait?.reason).toBe('because')
    expect(out[0]!.reason).toBe('because')
  })
})
