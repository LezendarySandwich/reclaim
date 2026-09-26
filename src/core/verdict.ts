/**
 * The decision layer: signals in, show/collapse out.
 *
 * This is the safety-critical module. A bug here hides a post the user wanted to read, which is
 * the one failure mode the whole design exists to prevent. Every gate below traces to an ADR, and
 * `decide()` is deliberately written so the reasons for showing are checked FIRST and return
 * early — it should be hard to accidentally reach `collapse`.
 */

import { canHide } from './types'
import type {
  Axis,
  AxisMode,
  ContentSignal,
  EngineState,
  Post,
  Settings,
  SignalSource,
  Verdict,
} from './types'

/**
 * Which source wins when several describe the same axis.
 *
 * Heuristics are a router, never a judge (ADR-004), so a heuristic signal is recorded for the
 * dashboard but is never the value a threshold is tested against.
 */
const SOURCE_RANK: Record<SignalSource, number> = {
  model: 3,
  metadata: 2,
  heuristic: 1,
}

/** Sources permitted to drive a `collapse`. Note the deliberate absence of `heuristic`. */
const CAN_DECIDE: ReadonlySet<SignalSource> = new Set<SignalSource>(['model'])

export interface MergeInput {
  post: Pick<Post, 'id' | 'authorUrn'>
  /** All signals gathered for this post, in any order, possibly several per axis. */
  signals: ReadonlyArray<{ axis: Axis; signal: ContentSignal }>
  settings: Settings
  engineState: EngineState
  engineId: string
  rulesVersion: string
}

/** Why a post was shown. Recorded so the dashboard and tests can distinguish the cases. */
export type ShowReason =
  | 'collapsed'
  | 'no_model'
  | 'shadow_mode'
  | 'allowlisted'
  | 'below_threshold'
  | 'no_deciding_signal'

export interface MergeResult {
  verdict: Verdict
  reason: ShowReason
}

/** Highest-ranked signal per axis. Lower-ranked ones are dropped, not averaged. */
function strongestPerAxis(
  signals: MergeInput['signals'],
): Map<Axis, { signal: ContentSignal; rank: number }> {
  const best = new Map<Axis, { signal: ContentSignal; rank: number }>()
  for (const { axis, signal } of signals) {
    const rank = SOURCE_RANK[signal.source]
    const current = best.get(axis)
    if (!current || rank > current.rank) best.set(axis, { signal, rank })
  }
  return best
}

function effectiveMode(mode: AxisMode, globalShadow: boolean): AxisMode {
  // The global switch can only ever weaken an axis, never strengthen one.
  if (globalShadow && mode === 'enabled') return 'shadow'
  return mode
}

export function mergeVerdict(input: MergeInput): MergeResult {
  const { post, settings, engineState, engineId, rulesVersion } = input

  const strongest = strongestPerAxis(input.signals)

  // Record every signal for an axis that is scored at all. `off` axes are dropped entirely — we
  // do not store scores for something the user has switched off.
  const recorded: Partial<Record<Axis, ContentSignal>> = {}
  for (const [axis, { signal }] of strongest) {
    const setting = settings.axes[axis]
    if (setting && setting.mode !== 'off') recorded[axis] = signal
  }

  const show = (reason: Exclude<ShowReason, 'collapsed'>): MergeResult => ({
    verdict: {
      postId: post.id,
      signals: recorded,
      action: 'show',
      triggeredBy: [],
      engineId,
      rulesVersion,
    },
    reason,
  })

  // ---- Reasons to show, checked before any reason to hide. Order matters only for the
  // ---- reported reason; each is independently sufficient.

  // ADR-005. The single gate that makes fail-open real. Scores are still recorded, so shadow data
  // keeps accumulating while the model is unavailable — but nothing hides.
  if (!canHide(engineState)) return show('no_model')

  // ADR-006 / calibration. Global shadow computes everything and hides nothing.
  if (settings.shadowMode) return show('shadow_mode')

  // Allowlisted authors are still scored (see docs/features/002-core-verdict/plan.md): it keeps
  // the accuracy denominator unbiased and lets the user see what would have been hidden.
  if (settings.allowlist.includes(post.authorUrn)) return show('allowlisted')

  // ---- Now, and only now, consider hiding.

  const triggeredBy: Axis[] = []
  let sawDecidingSignal = false

  for (const [axis, { signal }] of strongest) {
    const setting = settings.axes[axis]
    if (!setting) continue

    // ADR-019: only `enabled` may collapse. `shadow` is recorded above and stops here.
    if (effectiveMode(setting.mode, settings.shadowMode) !== 'enabled') continue

    // ADR-004: a heuristic may route, never judge. It is already in `recorded`; it just cannot
    // be the thing that hides a post.
    if (!CAN_DECIDE.has(signal.source)) continue

    sawDecidingSignal = true
    if (signal.score >= setting.threshold) triggeredBy.push(axis)
  }

  if (triggeredBy.length === 0) {
    return show(sawDecidingSignal ? 'below_threshold' : 'no_deciding_signal')
  }

  return {
    verdict: {
      postId: post.id,
      signals: recorded,
      action: 'collapse',
      // Stable order, so the stub text does not reshuffle between renders.
      triggeredBy: triggeredBy.sort(),
      engineId,
      rulesVersion,
    },
    reason: 'collapsed',
  }
}

/**
 * Human-readable labels for the collapsed stub.
 *
 * ADR-019: never phrase these as a factual claim about a named person's post, and never render a
 * confidence percentage — detectors are badly calibrated out of distribution, and a number implies
 * a precision we have not measured. "Looks templated", not "AI-written, 87%".
 */
const AXIS_LABEL: Record<Axis, string> = {
  engagement_bait: 'Looks like engagement bait',
  ai_written: 'Looks templated',
  ai_image: 'Image may be generated',
  sponsored: 'Promoted',
}

export function explain(verdict: Verdict): string {
  if (verdict.action === 'show' || verdict.triggeredBy.length === 0) return ''
  return verdict.triggeredBy.map((a) => AXIS_LABEL[a]).join(' · ')
}
