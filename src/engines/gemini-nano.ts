/**
 * Gemini Nano engine, via Chrome's built-in Prompt API.
 *
 * Runs in the **service worker** (ADR-018). Chromium force-enables `AIPromptAPIForWorkers` for
 * any renderer launched with `--extension-process`, and the user-gesture check is skipped when
 * there is no Window — so this is the privileged context, and an offscreen document (a Window
 * that can never obtain user activation) is the handicapped one.
 *
 * Contract details that shape this file, all source-verified in technical-brief-addendum.md §4:
 *
 * - Prompts on ONE session are **queued, not concurrent**. `clone()` is the parallelism primitive.
 * - Context overflow **silently evicts** the oldest turns — including, eventually, the few-shot
 *   anchors doing the calibration. So: clone per post, destroy in a `finally`, accumulate nothing.
 * - `responseConstraint` schema text is charged against the context window unless
 *   `omitResponseConstraintInput` is set. It is set, and the format lives in the system prompt.
 * - `topK`/`temperature` survive in extensions but are gone from the open web. We take them.
 */

import {
  PROMPT_VERSION,
  RESPONSE_SCHEMA,
  buildInitialPrompts,
  buildPostPrompt,
  parseResponse,
} from './prompt'
import type { Availability, DownloadProgress, EngineJudgement, ModelEngine } from './types'
import type { Post } from '../core/types'

export { PROMPT_VERSION }

/**
 * Minimal shape of the global the Prompt API exposes. Declared locally rather than pulled from a
 * types package so it cannot silently drift from what we actually call.
 */
interface LanguageModelSession {
  prompt(
    input: string,
    options?: { responseConstraint?: object; omitResponseConstraintInput?: boolean; signal?: AbortSignal },
  ): Promise<string>
  clone(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>
  destroy(): void
}

interface LanguageModelStatic {
  availability(): Promise<Availability>
  create(options?: {
    initialPrompts?: Array<{ role: string; content: string }>
    temperature?: number
    topK?: number
    signal?: AbortSignal
    monitor?: (m: EventTarget) => void
  }): Promise<LanguageModelSession>
  params?(): Promise<{ defaultTopK: number; maxTopK: number; defaultTemperature: number } | null>
}

function getLanguageModel(): LanguageModelStatic | null {
  const g = globalThis as unknown as { LanguageModel?: LanguageModelStatic }
  return typeof g.LanguageModel === 'object' || typeof g.LanguageModel === 'function'
    ? (g.LanguageModel ?? null)
    : null
}

export class GeminiNanoEngine implements ModelEngine {
  readonly id = 'gemini-nano' as const

  /**
   * The long-lived session holding the system prompt and few-shot anchors. Tokenised once;
   * every clone inherits it. Never used for a prompt directly — that would accumulate state.
   */
  #base: LanguageModelSession | null = null
  #loading: Promise<void> | null = null

  async availability(): Promise<Availability> {
    const lm = getLanguageModel()
    if (!lm) return 'unavailable'
    try {
      return await lm.availability()
    } catch {
      // Enterprise policy (`GenAILocalFoundationalModelSettings`) and unsupported hardware are
      // indistinguishable from here — both surface as a permanent failure, so the UI copy has to
      // cover both causes.
      return 'unavailable'
    }
  }

  async load(onProgress?: (p: DownloadProgress) => void): Promise<void> {
    if (this.#base) return
    if (this.#loading) return this.#loading

    this.#loading = (async () => {
      const lm = getLanguageModel()
      if (!lm) throw new Error('LanguageModel is not available in this context')

      const state = await lm.availability()
      if (state === 'unavailable') {
        throw new Error('Gemini Nano is unavailable on this device')
      }

      this.#base = await lm.create({
        initialPrompts: buildInitialPrompts(),
        // Greedy decoding. We want the same post to get the same verdict every time — otherwise
        // the verdict cache is lying and threshold calibration is measuring noise. Only
        // extensions still get these knobs.
        temperature: 0,
        topK: 1,
        monitor: (m) => {
          if (!onProgress) return
          m.addEventListener('downloadprogress', (event) => {
            const e = event as Event & { loaded?: number; total?: number }
            const loaded = e.loaded ?? 0
            const total = e.total ?? 0
            onProgress({
              // Chrome has reported `loaded` as both a 0-1 fraction and a byte count across
              // versions, so normalise defensively rather than trusting either.
              fraction: total > 0 ? loaded / total : Math.min(1, loaded),
              ...(total > 0 ? { loadedBytes: loaded, totalBytes: total } : {}),
            })
          })
        },
      })
    })().finally(() => {
      this.#loading = null
    })

    return this.#loading
  }

  async judge(post: Pick<Post, 'text'>, signal?: AbortSignal): Promise<EngineJudgement> {
    if (!this.#base) throw new Error('Engine not loaded')
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const started = performance.now()

    // Clone per post. Two reasons, both load-bearing: prompts on one session queue rather than
    // run concurrently, and a shared session accumulates turns until context overflow silently
    // evicts the few-shot anchors — at which point calibration quietly degrades with no error.
    const session = await this.#base.clone(signal ? { signal } : undefined)
    try {
      const raw = await session.prompt(buildPostPrompt(post.text), {
        responseConstraint: RESPONSE_SCHEMA,
        // The schema is injected as literal prompt text and charged against the context window
        // unless omitted. The format is described in the system prompt instead.
        omitResponseConstraintInput: true,
        ...(signal ? { signal } : {}),
      })

      const parsed = parseResponse(raw)
      if (!parsed) {
        // A malformed response yields no signal, which fails open. Never guess a score — a
        // guessed score can hide a post the model never actually judged.
        return { scores: {}, reason: '', engineId: this.id, elapsedMs: performance.now() - started }
      }

      return {
        scores: parsed.scores,
        reason: parsed.reason,
        engineId: this.id,
        elapsedMs: performance.now() - started,
      }
    } finally {
      // In a `finally` so an abort or a throw cannot leak a session. Sessions hold real memory.
      try {
        session.destroy()
      } catch {
        // Already destroyed, or the context is tearing down. Nothing useful to do.
      }
    }
  }

  async unload(): Promise<void> {
    try {
      this.#base?.destroy()
    } catch {
      // Ignore — we are discarding it regardless.
    }
    this.#base = null
  }

  /** Test seam. Lets the suite assert lifecycle behaviour without a real model. */
  get isLoaded(): boolean {
    return this.#base !== null
  }
}
