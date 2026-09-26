/**
 * The triage router.
 *
 * Decides what is worth sending to the model. It routes; it does not judge (ADR-004). Nothing in
 * this file may import anything capable of hiding a post, and `route()` returns a band — never an
 * action, never a verdict, never a user-visible score.
 *
 * See docs/features/003-triage-router/plan.md for why `clean` is the only expensive mistake.
 */

import { extractFeatures } from './features'
import type { Features } from './features'
import type { TriageBand } from '../core/types'

/**
 * Bumped whenever features or thresholds change. Load-bearing: it is part of the verdict cache
 * key (ADR-010), so bumping it invalidates every cached verdict automatically.
 */
export const RULES_VERSION = 'triage-2026.09.26c-listicle-uncalibrated'

/**
 * Below this, every rate feature is noise — one em-dash in a twelve-word post is a rate of 8 per
 * 100 words and means nothing. Short posts go straight to `ambiguous`; they are cheap to classify
 * anyway, so routing them to the model costs almost nothing and avoids inventing a signal.
 */
export const MIN_WORDS = 25

/**
 * PROVISIONAL AND UNCALIBRATED. Do not cite these anywhere as if they were measured.
 *
 * An earlier research pass published 0.12 / 0.62. Those came from instrumentation with a confirmed
 * dead-code bug and a sweep that replayed hardcoded scores instead of calling this function; they
 * are non-citable and are deliberately not used.
 *
 * These are set conservatively, not accurately: `CLEAN_BELOW` is low so we rarely skip the model,
 * because a wrong `clean` is a silent miss and a wrong `ambiguous` costs one inference. Calibrate
 * from shadow-mode data (ADR-019), not by guessing harder.
 */
export const PROVISIONAL_CLEAN_BELOW = 0.18
export const PROVISIONAL_SLOP_ABOVE = 0.55

/**
 * Bait weights. These features are near-unambiguous — a post asking you to "comment GUIDE below"
 * is telling you what it is, so this side can carry real weight without the fairness problems
 * that make the ai side untrustworthy.
 */
const BAIT_WEIGHTS: Partial<Record<keyof Features, number>> = {
  commentGate: 0.85,
  questionCloser: 0.35,
  timeContrast: 0.3,
  humbleOpener: 0.3,
  oneLineParaRatio: 0.25,
  emojiBulletRate: 0.25,
  slopEmojiRate: 0.3,
  emojiDensity: 0.15,
  allCapsHookRate: 0.2,
  // A listicle that ends by asking you something is fishing for comments. Weighted on both
  // sides because the shape serves bait and signals templating equally.
  labelledListicle: 0.3,
  bulletRate: 0.15,
}

/**
 * AI-register weights, deliberately small and spread thin.
 *
 * ADR-019 and the literature: every lexical proxy for "AI-sounding" is also a proxy for
 * "non-native or formal writer" — Liang et al. measured a 61.22% false-positive rate on TOEFL
 * essays. The em-dash in particular is a population-level shift with a per-document likelihood
 * ratio near 1. So no single feature here can move a post far, and this side exists to nudge
 * borderline text into `ambiguous` so the MODEL looks at it — never to reach `likely_slop` alone.
 */
const AI_WEIGHTS: Partial<Record<keyof Features, number>> = {
  abstractness: 0.3,
  // Structural templating. Independent of vocabulary, so unlike the lexical tells it is not a
  // proxy for non-native or formal writing — a second-language writer telling you about their
  // week does not produce twelve `Term: description` lines.
  labelledListicle: 0.35,
  bulletRate: 0.15,
  sentenceUniformity: 0.22,
  antithesisRate: 0.22,
  // The 🚀/💡/✅/👉 vocabulary carries real weight on this side. Unlike the lexical tells, it is
  // not a proxy for formal or non-native writing — it is a proxy for a generated listicle, and
  // it is what makes an emoji-bulleted post distinguishable from a careful human one. Raw emoji
  // density is weighted much lower, because using emoji is not evidence of anything.
  slopEmojiRate: 0.25,
  emojiBulletRate: 0.18,
  paragraphUniformity: 0.15,
  tricolonRate: 0.15,
  hedgingRate: 0.12,
  emojiDensity: 0.1,
  emDashRate: 0.1,
  curlyPunctRate: 0.08,
}

/**
 * Concrete, specific writing is a counter-signal — but a weaker one than it first appeared.
 *
 * Was 0.3. An HTTP-status-codes explainer scored concreteness 1.00 purely on digit density, which
 * zeroed its abstractness AND cut its remaining score by a third, so a thoroughly formulaic post
 * routed `clean` and never reached the model. Being full of numbers is not the same as being
 * about something.
 */
const CONCRETENESS_DISCOUNT = 0.15

/**
 * Combine signals as independent evidence, not as a weighted average.
 *
 * Noisy-OR: `1 - Π(1 - wᵢvᵢ)`. Each signal gets a chance to raise the score on its own, and a
 * single near-certain marker is enough.
 *
 * The first version divided by the SUM of all weights, which was a modelling error rather than a
 * tuning problem. `BAIT_WEIGHTS` sums to ~2.95, so a post firing only `commentGate` — the
 * strongest single signal at 0.85 — scored 0.85/2.95 ≈ 0.29, and a post had to fire most markers
 * simultaneously to score highly. In practice nothing ever reached `likely_slop` on a real feed:
 * the band was dead and the agreement panel read 0 in both of its rows.
 *
 * These markers are genuinely independent — "comment GUIDE below" is bait whether or not the post
 * also has emoji bullets — so treating them as competing components of an average was simply the
 * wrong shape.
 */
function combineEvidence(
  features: Features,
  weights: Partial<Record<keyof Features, number>>,
): number {
  let survive = 1
  for (const [key, weight] of Object.entries(weights) as [keyof Features, number][]) {
    const value = features[key]
    if (typeof value !== 'number' || value <= 0) continue
    survive *= 1 - Math.min(1, Math.max(0, value * weight))
  }
  return Math.min(1, 1 - survive)
}

export interface TriageResult {
  band: TriageBand
  /** 0-1. Internal only — never shown to the user, never used as a verdict score. */
  score: number
  /** Per-axis sub-scores, kept separate because ADR-019 treats the axes differently. */
  bait: number
  ai: number
  features: Features
  /** True when the post was too short to score and was routed on length alone. */
  shortCircuited: boolean
}

export function route(text: string): TriageResult {
  const features = extractFeatures(text)

  if (features.wordCount === 0) {
    // Nothing to classify. Extends the fail-open rule: no text => do not triage yet. The adapter
    // will re-evaluate when LinkedIn fills the lazily-mounted row.
    return { band: 'clean', score: 0, bait: 0, ai: 0, features, shortCircuited: true }
  }

  if (features.wordCount < MIN_WORDS) {
    return { band: 'ambiguous', score: 0, bait: 0, ai: 0, features, shortCircuited: true }
  }

  const rawBait = combineEvidence(features, BAIT_WEIGHTS)
  const rawAi = combineEvidence(features, AI_WEIGHTS)

  // Concreteness discounts the AI side only. A bait post full of real numbers is still bait —
  // "I made £47,000 in 3 months, comment MONEY for the playbook" should not be discounted.
  const ai = Math.max(0, rawAi * (1 - features.concreteness * CONCRETENESS_DISCOUNT))
  const bait = rawBait

  // Max, not sum: if either axis finds the post interesting, the model should see it.
  const score = Math.max(bait, ai)

  const band: TriageBand =
    score >= PROVISIONAL_SLOP_ABOVE
      ? 'likely_slop'
      : score < PROVISIONAL_CLEAN_BELOW
        ? 'clean'
        : 'ambiguous'

  return { band, score, bait, ai, features, shortCircuited: false }
}

/** Whether a band warrants spending inference. The only reason this module exists. */
export function needsModel(band: TriageBand): boolean {
  return band !== 'clean'
}
