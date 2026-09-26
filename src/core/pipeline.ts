/**
 * The classification pipeline: triaged posts in, verdicts out.
 *
 * This is the `classify(posts) → verdicts` boundary the architecture is built around. Nothing
 * upstream knows which engine ran or where it ran, so relocating the model host — which the
 * research already forced once (ADR-018) — stays a change to one call site.
 *
 * Pure of platform concerns: it takes the engine and settings as arguments rather than reaching
 * for globals, so the whole thing is testable in plain node.
 */

import { buildVerdictKey } from './cache'
import { InferenceScheduler } from './scheduler'
import { mergeVerdict } from './verdict'
import { canHide } from './types'
import type { Axis, ContentSignal, EngineState, Settings, Verdict } from './types'
import type { TriagedPost } from './messages'
import type { ModelEngine } from '../engines/types'

export interface ClassifyDeps {
  engine: ModelEngine
  settings: Settings
  engineState: EngineState
  rulesVersion: string
  scheduler?: InferenceScheduler<Partial<Record<Axis, number>>>
}

export interface ClassifiedPost {
  verdict: Verdict
  cacheKey: string
  /** What the post was, so the caller can persist without re-deriving it. */
  source: TriagedPost
  /** Present only when the model actually ran. */
  reason?: string
}

/**
 * Classify a batch.
 *
 * Order matters here. The engine-state gate is checked FIRST and short-circuits the whole batch,
 * so a machine with no working model never spends anything on inference — and, more importantly,
 * cannot produce a `collapse` by any path (ADR-005). `mergeVerdict` enforces the same rule again
 * independently; this is the cheap check, not the authoritative one.
 */
export async function classifyBatch(
  posts: readonly TriagedPost[],
  deps: ClassifyDeps,
): Promise<ClassifiedPost[]> {
  const { engine, settings, engineState, rulesVersion } = deps

  const buildSignals = (
    triaged: TriagedPost,
    model: Partial<Record<Axis, number>> | null,
  ): Array<{ axis: Axis; signal: ContentSignal }> => {
    const out: Array<{ axis: Axis; signal: ContentSignal }> = []
    for (const [axis, score] of Object.entries(triaged.heuristics) as [Axis, number][]) {
      out.push({ axis, signal: { score, source: 'heuristic' } })
    }

    // The page said so itself. A structural fact, not a judgement — hence source 'metadata',
    // which `mergeVerdict` allows to decide for this axis alone, and which works with no model
    // at all (ADR-026).
    if (triaged.post.isPromoted) {
      out.push({
        axis: 'sponsored',
        signal: { score: 100, source: 'metadata', reason: 'LinkedIn labelled this Promoted' },
      })
    }

    if (model) {
      for (const [axis, score] of Object.entries(model) as [Axis, number][]) {
        out.push({ axis, signal: { score, source: 'model' } })
      }
    }
    return out
  }

  const finish = (
    triaged: TriagedPost,
    model: Partial<Record<Axis, number>> | null,
    reason?: string,
  ): ClassifiedPost => {
    const key = buildVerdictKey({
      postId: triaged.post.id,
      text: triaged.post.text,
      rulesVersion,
      engineId: engine.id,
    })
    const { verdict } = mergeVerdict({
      post: triaged.post,
      signals: buildSignals(triaged, model),
      settings,
      engineState,
      engineId: engine.id,
      rulesVersion,
    })
    return {
      verdict,
      cacheKey: [key.postId, key.textHash, key.rulesVersion, key.engineId].join('␟'),
      source: triaged,
      ...(reason ? { reason } : {}),
    }
  }

  // No usable model: record the heuristic signals for the dashboard and shadow data, hide
  // nothing, and skip inference entirely.
  if (!canHide(engineState)) {
    return posts.map((p) => finish(p, null))
  }

  const scheduler =
    deps.scheduler ?? new InferenceScheduler<Partial<Record<Axis, number>>>()

  const results = await Promise.all(
    posts.map(async (triaged, index) => {
      const outcome = await scheduler.submit({
        key: triaged.post.id,
        // Batch order is a reasonable proxy for viewport distance: the content script sends
        // nearest-first. A live caller supplies a real measurement instead.
        priority: () => index,
        run: async () => {
          const judged = await engine.judge(triaged.post)
          return judged.scores
        },
      })

      if (outcome.status === 'done') return finish(triaged, outcome.value)

      // Dropped, replaced, cancelled or failed all mean the same thing downstream: no model
      // signal, so nothing hides. Recording the heuristics keeps shadow data complete.
      return finish(triaged, null)
    }),
  )

  return results
}

export { InferenceScheduler }
