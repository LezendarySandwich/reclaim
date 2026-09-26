import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeminiNanoEngine } from './gemini-nano'

/**
 * A stand-in for Chrome's `LanguageModel`, faithful to the contract details that actually shape
 * our code: prompts queue on one session, `clone()` is the parallelism primitive, and sessions
 * must be destroyed.
 */
function installFakeLanguageModel(options: {
  availability?: string
  respond?: (input: string) => string | Promise<string>
  failCreate?: Error
} = {}) {
  const state = {
    created: 0,
    clones: 0,
    destroyed: 0,
    prompts: [] as string[],
    lastPromptOptions: null as Record<string, unknown> | null,
    initialPrompts: null as unknown,
    createOptions: null as Record<string, unknown> | null,
  }

  const makeSession = (): Record<string, unknown> => ({
    prompt: async (input: string, opts?: Record<string, unknown>) => {
      state.prompts.push(input)
      state.lastPromptOptions = opts ?? null
      if (opts?.signal && (opts.signal as AbortSignal).aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      return options.respond
        ? await options.respond(input)
        : '{"bait":"clear","ai":"some","reason":"tacked-on question"}'
    },
    clone: async () => {
      state.clones++
      return makeSession()
    },
    destroy: () => {
      state.destroyed++
    },
  })

  ;(globalThis as Record<string, unknown>).LanguageModel = {
    availability: async () => options.availability ?? 'available',
    create: async (opts?: Record<string, unknown>) => {
      if (options.failCreate) throw options.failCreate
      state.created++
      state.createOptions = opts ?? null
      state.initialPrompts = opts?.initialPrompts
      return makeSession()
    },
  }

  return state
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).LanguageModel
  vi.restoreAllMocks()
})

describe('availability', () => {
  it('reports unavailable when the global is missing entirely', async () => {
    delete (globalThis as Record<string, unknown>).LanguageModel
    expect(await new GeminiNanoEngine().availability()).toBe('unavailable')
  })

  it('passes through the browser state', async () => {
    installFakeLanguageModel({ availability: 'downloadable' })
    expect(await new GeminiNanoEngine().availability()).toBe('downloadable')
  })

  it('treats a throwing availability() as unavailable rather than propagating', async () => {
    ;(globalThis as Record<string, unknown>).LanguageModel = {
      availability: async () => {
        throw new Error('policy blocked')
      },
    }
    // Enterprise policy and unsupported hardware are indistinguishable from here; both must
    // resolve to a state the fail-open path understands.
    expect(await new GeminiNanoEngine().availability()).toBe('unavailable')
  })
})

describe('load', () => {
  it('creates exactly one base session', async () => {
    const fake = installFakeLanguageModel()
    const engine = new GeminiNanoEngine()
    await engine.load()
    expect(fake.created).toBe(1)
    expect(engine.isLoaded).toBe(true)
  })

  it('is idempotent', async () => {
    const fake = installFakeLanguageModel()
    const engine = new GeminiNanoEngine()
    await engine.load()
    await engine.load()
    expect(fake.created).toBe(1)
  })

  it('does not create twice under concurrent callers', async () => {
    const fake = installFakeLanguageModel()
    const engine = new GeminiNanoEngine()
    await Promise.all([engine.load(), engine.load(), engine.load()])
    expect(fake.created).toBe(1)
  })

  it('requests greedy decoding, so the same post always gets the same verdict', async () => {
    const fake = installFakeLanguageModel()
    await new GeminiNanoEngine().load()
    expect(fake.createOptions?.temperature).toBe(0)
    expect(fake.createOptions?.topK).toBe(1)
  })

  it('puts the system prompt and few-shot anchors in initialPrompts', async () => {
    const fake = installFakeLanguageModel()
    await new GeminiNanoEngine().load()
    const prompts = fake.initialPrompts as Array<{ role: string; content: string }>
    expect(prompts[0]?.role).toBe('system')
    expect(prompts.length).toBeGreaterThan(1)
    expect(prompts.some((p) => p.role === 'assistant')).toBe(true)
  })

  it('refuses when the device reports unavailable', async () => {
    installFakeLanguageModel({ availability: 'unavailable' })
    await expect(new GeminiNanoEngine().load()).rejects.toThrow(/unavailable/i)
  })

  it('allows a retry after a failed load', async () => {
    installFakeLanguageModel({ failCreate: new Error('transient') })
    const engine = new GeminiNanoEngine()
    await expect(engine.load()).rejects.toThrow('transient')
    installFakeLanguageModel()
    await expect(engine.load()).resolves.toBeUndefined()
  })
})

describe('judge', () => {
  it('rejects when not loaded', async () => {
    installFakeLanguageModel()
    await expect(new GeminiNanoEngine().judge({ text: 'hi' })).rejects.toThrow(/not loaded/i)
  })

  it('clones per post rather than reusing the base session', async () => {
    // Load-bearing: prompts on one session queue, and a shared session accumulates turns until
    // context overflow silently evicts the few-shot anchors.
    const fake = installFakeLanguageModel()
    const engine = new GeminiNanoEngine()
    await engine.load()
    await engine.judge({ text: 'a post' })
    await engine.judge({ text: 'another post' })
    expect(fake.clones).toBe(2)
  })

  it('destroys every clone, including when the prompt throws', async () => {
    const fake = installFakeLanguageModel({
      respond: () => {
        throw new Error('model exploded')
      },
    })
    const engine = new GeminiNanoEngine()
    await engine.load()
    await expect(engine.judge({ text: 'x' })).rejects.toThrow('model exploded')
    expect(fake.destroyed).toBe(1)
  })

  it('maps ladder rungs to scores', async () => {
    installFakeLanguageModel({
      respond: () => '{"bait":"blatant","ai":"none","reason":"comment gate"}',
    })
    const engine = new GeminiNanoEngine()
    await engine.load()
    const out = await engine.judge({ text: 'Comment GUIDE below' })
    expect(out.scores.engagement_bait).toBe(97)
    expect(out.scores.ai_written).toBe(0)
    expect(out.reason).toBe('comment gate')
  })

  it('returns NO signal on a malformed response rather than guessing', async () => {
    // A guessed score can hide a post the model never actually judged. No signal fails open.
    installFakeLanguageModel({ respond: () => 'I think this post is quite baity, honestly.' })
    const engine = new GeminiNanoEngine()
    await engine.load()
    const out = await engine.judge({ text: 'x' })
    expect(out.scores).toEqual({})
  })

  it('tolerates a model that wraps its JSON in prose', async () => {
    installFakeLanguageModel({
      respond: () => 'Here is my answer:\n```json\n{"bait":"some","ai":"clear","reason":"generic"}\n```',
    })
    const engine = new GeminiNanoEngine()
    await engine.load()
    const out = await engine.judge({ text: 'x' })
    expect(out.scores.engagement_bait).toBe(38)
    expect(out.scores.ai_written).toBe(65)
  })

  it('drops an unrecognised rung instead of coercing it', async () => {
    installFakeLanguageModel({ respond: () => '{"bait":"extremely","ai":"clear","reason":"x"}' })
    const engine = new GeminiNanoEngine()
    await engine.load()
    const out = await engine.judge({ text: 'x' })
    expect(out.scores.engagement_bait).toBeUndefined()
    expect(out.scores.ai_written).toBe(65)
  })

  it('omits the schema from the prompt input, which would otherwise cost context', async () => {
    const fake = installFakeLanguageModel()
    const engine = new GeminiNanoEngine()
    await engine.load()
    await engine.judge({ text: 'x' })
    expect(fake.lastPromptOptions?.omitResponseConstraintInput).toBe(true)
    expect(fake.lastPromptOptions?.responseConstraint).toBeDefined()
  })

  it('rejects immediately on an already-aborted signal', async () => {
    installFakeLanguageModel()
    const engine = new GeminiNanoEngine()
    await engine.load()
    const ac = new AbortController()
    ac.abort()
    await expect(engine.judge({ text: 'x' }, ac.signal)).rejects.toThrow()
  })

  it('reports elapsed time', async () => {
    installFakeLanguageModel()
    const engine = new GeminiNanoEngine()
    await engine.load()
    expect((await engine.judge({ text: 'x' })).elapsedMs).toBeGreaterThanOrEqual(0)
  })
})

describe('unload', () => {
  it('destroys the base session and allows a reload', async () => {
    const fake = installFakeLanguageModel()
    const engine = new GeminiNanoEngine()
    await engine.load()
    await engine.unload()
    expect(engine.isLoaded).toBe(false)
    await engine.load()
    expect(fake.created).toBe(2)
  })

  it('is safe when never loaded', async () => {
    installFakeLanguageModel()
    await expect(new GeminiNanoEngine().unload()).resolves.toBeUndefined()
  })
})
