/**
 * Model catalogue and the "recommended for your machine" logic.
 *
 * Sizes and VRAM figures come from WebLLM's own `prebuiltAppConfig` (see
 * technical-brief-addendum.md §4). The Gemini Nano figures were measured on disk: `weights.bin`
 * is 4,269,932,544 bytes, plus a separate ~120 MB safety classifier.
 */

import type { EngineId, MachineSpecs, ModelDescriptor } from './types'

export const MODELS: readonly ModelDescriptor[] = [
  {
    id: 'gemini-nano',
    name: "Chrome's built-in model (Gemini Nano)",
    host: 'service-worker',
    // Not zero. Nano is a component download shared across all of Chrome's AI features, so it may
    // already be present — but if it is not, it is the largest download on this list.
    downloadMB: 4390,
    vramMB: 4096,
    quality: 'good',
    note:
      'Shared with Chrome, so it costs no extra space if you already have it. Needs >4 GB VRAM ' +
      'and 22 GB free disk, and your organisation can disable it.',
  },
  {
    id: 'webllm-qwen3-0.6b',
    name: 'Qwen3 0.6B',
    host: 'offscreen',
    downloadMB: 350,
    vramMB: 1403,
    quality: 'basic',
    note: 'Smallest and fastest. Good enough for obvious engagement bait; misses subtler cases.',
  },
  {
    id: 'webllm-qwen2.5-1.5b',
    name: 'Qwen2.5 1.5B',
    host: 'offscreen',
    downloadMB: 950,
    vramMB: 1630,
    quality: 'good',
    note: 'The balanced choice if Chrome’s built-in model is unavailable to you.',
  },
  {
    id: 'webllm-llama3.2-3b',
    name: 'Llama 3.2 3B',
    host: 'offscreen',
    downloadMB: 1900,
    vramMB: 2264,
    quality: 'better',
    note: 'Best judgement of the downloadable options. Noticeably slower on a busy feed.',
  },
]

export function findModel(id: EngineId): ModelDescriptor | undefined {
  return MODELS.find((m) => m.id === id)
}

export interface Recommendation {
  /** null when nothing on the list can be expected to run. */
  recommended: EngineId | null
  /** Shown beside the recommendation. Plain language, no hedging. */
  rationale: string
  /** Models this machine probably cannot run, with the reason. */
  unsupported: Array<{ id: EngineId; why: string }>
}

/**
 * Pick a default for the model picker.
 *
 * Deliberately conservative. Every readable signal is coarse — `deviceMemory` is a rounded power
 * of two capped at 8, and WebGPU buffer limits are a weak proxy for VRAM — so this steers rather
 * than promises, and the picker shows the real numbers so the user can overrule it.
 */
export function recommendModel(
  specs: MachineSpecs,
  nanoAvailable: boolean,
): Recommendation {
  const unsupported: Array<{ id: EngineId; why: string }> = []

  // Software rendering is not viable for a WebGPU model — it will technically run and be far too
  // slow to use on a scrolling feed.
  const software = /swiftshader|llvmpipe|software/i.test(specs.gpuDescription ?? '')

  for (const m of MODELS) {
    if (m.id === 'gemini-nano') {
      if (!nanoAvailable) {
        unsupported.push({
          id: m.id,
          why: 'Chrome reports this model as unavailable on this device, or your organisation has disabled it.',
        })
      }
      continue
    }
    if (!specs.hasWebGPU) {
      unsupported.push({ id: m.id, why: 'This browser does not have WebGPU enabled.' })
      continue
    }
    if (software) {
      unsupported.push({ id: m.id, why: 'No hardware GPU detected — this would be far too slow.' })
      continue
    }
    if (specs.maxBufferMB !== null && specs.maxBufferMB * 4 < m.vramMB) {
      // ×4 because maxBufferSize bounds a SINGLE allocation, not total VRAM. A rough,
      // deliberately generous proxy — being wrong here should mean offering a model that turns
      // out slow, not refusing one that would have worked.
      unsupported.push({ id: m.id, why: 'Your GPU likely does not have enough memory.' })
    }
  }

  const blocked = new Set(unsupported.map((u) => u.id))

  if (nanoAvailable) {
    return {
      recommended: 'gemini-nano',
      rationale:
        "Chrome's built-in model is ready on this device, so there is nothing extra to download.",
      unsupported,
    }
  }

  const roomy = (specs.deviceMemoryGB ?? 0) >= 8 && (specs.hardwareConcurrency ?? 0) >= 8
  const ladder: EngineId[] = roomy
    ? ['webllm-qwen2.5-1.5b', 'webllm-qwen3-0.6b', 'webllm-llama3.2-3b']
    : ['webllm-qwen3-0.6b', 'webllm-qwen2.5-1.5b']

  const pick = ladder.find((id) => !blocked.has(id)) ?? null

  if (!pick) {
    return {
      recommended: null,
      rationale:
        'This device cannot run any of the available models. Reclaim will not hide anything — ' +
        'your feed stays exactly as it is.',
      unsupported,
    }
  }

  const model = findModel(pick)
  return {
    recommended: pick,
    rationale: roomy
      ? `This machine has room for ${model?.name}, a ${model?.downloadMB} MB download.`
      : `Recommending the smallest model, ${model?.name}, because this machine looks memory-constrained.`,
    unsupported,
  }
}
