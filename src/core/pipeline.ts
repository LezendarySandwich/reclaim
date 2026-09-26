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

/** What a cached verdict gives back. Deliberately minimal so `core/` stays storage-agnostic. */
export interface CachedVerdict {
  signals: Partial<Record<Axis, ContentSignal>>
}

export interface ClassifyDeps {
  engine: ModelEngine
  settings: Settings
  engineState: EngineState
  rulesVersion: string
  scheduler?: InferenceScheduler<ModelResult>
  /**
   * Look up an already-computed verdict by cache key.
   *
   * The whole point of keying on `postId + textHash + rulesVersion + engineId` (ADR-010) is that
   * a hit is guaranteed to be a verdict for THIS text under THESE rules and THIS model — so
   * re-running inference on a post you scrolled back past is pure waste. Optional, and a
   * lookup failure just means a cache miss: never let storage break classification.
   */
  lookupCached?: (cacheKey: string) => Promise<CachedVerdict | null>
  /**
   * How far a post currently is from the viewport, in screen-heights. Lower runs sooner.
   *
   * Read at DEQUEUE, not at submit — by the time a slot frees the user has scrolled, and the
   * ordering captured at submit time describes where they were, not where they are. This is
   * what lets the scheduler drop work for posts already scrolled past instead of grinding
   * through a backlog nobody is looking at any more.
   *
   * Without it, ordering falls back to batch position, which is only a proxy.
   */
  viewportDistance?: (postId: string) => number
}

/** Model output for one post: per-axis scores plus the model's own one-line reason. */
export interface ModelResult {
  scores: Partial<Record<Axis, number>>
  reason: string
}

export interface ClassifiedPost {
  verdict: Verdict
  cacheKey: string
  /** What the post was, so the caller can persist without re-deriving it. */
  source: TriagedPost
  /** The model's one-line explanation, when one was produced. */
  reason?: string
  /** True when this came from the verdict cache and no inference ran. */
  fromCache: boolean
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
    model: ModelResult | null,
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
      for (const [axis, score] of Object.entries(model.scores) as [Axis, number][]) {
        // Carry the model's own reason through. It was computed on every call and discarded,
        // which meant the stub could only ever say "Looks like engagement bait" when the model
        // had actually said "comment-gated lead magnet".
        out.push({
          axis,
          signal: { score, source: 'model', ...(model.reason ? { reason: model.reason } : {}) },
        })
      }
    }
    return out
  }

  const finish = (
    triaged: TriagedPost,
    model: ModelResult | null,
    cached = false,
  ): ClassifiedPost => {
    const key = buildVerdictKey({
      postId: triaged.post.id,
      text: triaged.post.text,
      rulesVersion,
      engineId: engine.id,
    })
    const merged = mergeVerdict({
      post: triaged.post,
      signals: buildSignals(triaged, model),
      settings,
      engineState,
      engineId: engine.id,
      rulesVersion,
    })

    // An audit sample is measurement, never enforcement. The router already cleared this post and
    // the user has seen it; collapsing it now because a sampling die came up differently would be
    // indefensible. The scores are still recorded, which is the entire point.
    const verdict = triaged.audit
      ? { ...merged.verdict, action: 'show' as const, triggeredBy: [] }
      : merged.verdict
    return {
      verdict,
      cacheKey: [key.postId, key.textHash, key.rulesVersion, key.engineId].join('␟'),
      source: triaged,
      ...(model?.reason ? { reason: model.reason } : {}),
      fromCache: cached,
    }
  }

  // No usable model: record the heuristic signals for the dashboard and shadow data, hide
  // nothing, and skip inference entirely.
  if (!canHide(engineState)) {
    return posts.map((p) => finish(p, null))
  }

  const scheduler = deps.scheduler ?? new InferenceScheduler<ModelResult>()

  const results = await Promise.all(
    posts.map(async (triaged, index) => {
      // Cache first. A hit is by construction a verdict for this exact text, under these exact
      // rules, from this exact model — so re-inferring is pure waste.
      if (deps.lookupCached) {
        const key = buildVerdictKey({
          postId: triaged.post.id,
          text: triaged.post.text,
          rulesVersion,
          engineId: engine.id,
        })
        const cacheKey = [key.postId, key.textHash, key.rulesVersion, key.engineId].join('␟')
        try {
          const hit = await deps.lookupCached(cacheKey)
          if (hit) {
            const scores: Partial<Record<Axis, number>> = {}
            let reason = ''
            for (const [axis, signal] of Object.entries(hit.signals) as [Axis, ContentSignal][]) {
              if (signal.source !== 'model') continue
              scores[axis] = signal.score
              if (!reason && signal.reason) reason = signal.reason
            }
            if (Object.keys(scores).length > 0) return finish(triaged, { scores, reason }, true)
          }
        } catch {
          // A storage failure is a cache miss, never a classification failure.
        }
      }

      const outcome = await scheduler.submit({
        key: triaged.post.id,
        // Real distance when the caller can measure it; batch position otherwise.
        priority: deps.viewportDistance
          ? () => deps.viewportDistance!(triaged.post.id)
          : () => index,
        run: async () => {
          const judged = await engine.judge(triaged.post)
          return { scores: judged.scores, reason: judged.reason }
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
