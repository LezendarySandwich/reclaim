/**
 * The `ModelEngine` seam.
 *
 * Two backends with two different hosts (ADR-018): the Prompt API runs in the service worker,
 * WebLLM will run in the offscreen document. Everything upstream goes through
 * `classify(posts) → verdicts`, so neither the content script nor the verdict layer knows which
 * engine ran or where.
 */

import type { Axis, Post } from '../core/types'

export type EngineId = 'gemini-nano' | 'webllm-qwen3-0.6b' | 'webllm-qwen2.5-1.5b' | 'webllm-llama3.2-3b'

/** Mirrors the Prompt API's own availability states, which WebLLM is mapped onto. */
export type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

export interface DownloadProgress {
  /** 0-1. */
  fraction: number
  loadedBytes?: number
  totalBytes?: number
}

export interface EngineJudgement {
  scores: Partial<Record<Axis, number>>
  reason: string
  engineId: EngineId
  /** Wall-clock ms for the inference. Feeds the throughput budget. */
  elapsedMs: number
}

export interface ModelEngine {
  readonly id: EngineId

  availability(): Promise<Availability>

  /**
   * Prepare for inference. Must be called before `judge`.
   *
   * `onProgress` fires during a model download.
   *
   * NOTE: for the Prompt API this may need a transient user gesture — `create()` rejects with
   * NotAllowedError when availability is `"downloadable"` and the call comes from a Window that
   * has not been interacted with. A service worker is exempt (no Window), but we still route
   * first-time downloads through a click on an extension page. A multi-gigabyte download deserves
   * consent (ADR-018).
   */
  load(onProgress?: (p: DownloadProgress) => void): Promise<void>

  /** Judge one post. Must reject on abort rather than resolving with a partial result. */
  judge(post: Pick<Post, 'text'>, signal?: AbortSignal): Promise<EngineJudgement>

  /** Free the session. Safe to call when not loaded. */
  unload(): Promise<void>
}

/** Catalogue entry for the model picker. */
export interface ModelDescriptor {
  id: EngineId
  name: string
  /** Where it runs — different hosts, per ADR-018. */
  host: 'service-worker' | 'offscreen'
  /** Approximate download in MB. 0 when the model is shared with the browser. */
  downloadMB: number
  /** Approximate VRAM in MB, from WebLLM's own `vram_required_MB` where applicable. */
  vramMB: number
  quality: 'basic' | 'good' | 'better'
  /** Shown in the picker. Honest about the tradeoff, not marketing. */
  note: string
}

/**
 * Hardware readable from an extension.
 *
 * All of it is coarse and privacy-clamped by the browser — `deviceMemory` reports a rounded
 * power of two and caps at 8 even on a 64GB machine. Good enough to steer a recommendation,
 * nowhere near good enough to promise one will run well.
 */
export interface MachineSpecs {
  deviceMemoryGB: number | null
  hardwareConcurrency: number | null
  hasWebGPU: boolean
  /** From `GPUAdapter.info`, when available. Used to detect software rendering. */
  gpuDescription: string | null
  maxBufferMB: number | null
  storageQuotaMB: number | null
}
