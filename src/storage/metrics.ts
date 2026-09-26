/**
 * Dashboard aggregations.
 *
 * Pure functions over stored rows, so the reasoning — which is where the judgement lives — is
 * testable without IndexedDB.
 *
 * The recurring theme here is refusing to imply completeness we do not have. Several of these
 * numbers have a population we cannot see, and each one says so rather than quietly reporting a
 * percentage of the part we happen to know about.
 */

import type { Axis, TriageBand } from '../core/types'
import type { StoredLabel, StoredVerdict } from './schema'

export const WINDOWS = {
  today: 1,
  week: 7,
  month: 30,
} as const

export type WindowKey = keyof typeof WINDOWS

export function since(now: number, days: number): number {
  return now - days * 24 * 60 * 60 * 1000
}

export function withinWindow(rows: readonly StoredVerdict[], now: number, days: number): StoredVerdict[] {
  const cutoff = since(now, days)
  return rows.filter((r) => r.at >= cutoff)
}

// ── Overview ────────────────────────────────────────────────────────────────────────────────

export interface OverviewCounts {
  scored: number
  hidden: number
  /** 0-1, or null when too few posts to be worth a percentage. */
  hiddenRate: number | null
}

const MIN_FOR_RATE = 10

export function overview(rows: readonly StoredVerdict[]): OverviewCounts {
  const scored = rows.length
  const hidden = rows.filter((r) => r.action === 'collapse').length
  return {
    scored,
    hidden,
    // A "50% hidden" headline off two posts is noise dressed as a finding.
    hiddenRate: scored >= MIN_FOR_RATE ? hidden / scored : null,
  }
}

// ── Per axis ────────────────────────────────────────────────────────────────────────────────

export interface AxisBreakdown {
  axis: Axis
  /** Posts this axis actually collapsed. Zero for a shadow axis, by definition. */
  hidden: number
  /**
   * Posts where this axis scored at or above the threshold but did NOT hide — because the axis is
   * in shadow mode. This is the number that answers "should I turn ai_written on?".
   */
  wouldHaveHidden: number
  /** Posts where this axis was scored at all. */
  scored: number
  meanScore: number | null
}

export function byAxis(
  rows: readonly StoredVerdict[],
  thresholds: Partial<Record<Axis, number>>,
): AxisBreakdown[] {
  const axes = new Set<Axis>()
  for (const row of rows) {
    for (const axis of Object.keys(row.signals) as Axis[]) axes.add(axis)
  }

  return [...axes].map((axis) => {
    let hidden = 0
    let wouldHaveHidden = 0
    let scored = 0
    let sum = 0
    const threshold = thresholds[axis] ?? 70

    for (const row of rows) {
      const signal = row.signals[axis]
      if (!signal) continue
      scored++
      sum += signal.score

      if (row.triggeredBy.includes(axis)) {
        hidden++
      } else if (signal.score >= threshold && signal.source === 'model') {
        // Scored high enough to hide but did not — the axis is shadow or off, or the author is
        // allowlisted. Only model signals count: a heuristic could never have hidden it anyway
        // (ADR-004), so counting those would overstate the case for switching the axis on.
        wouldHaveHidden++
      }
    }

    return {
      axis,
      hidden,
      wouldHaveHidden,
      scored,
      meanScore: scored > 0 ? sum / scored : null,
    }
  })
}

// ── Router vs model ─────────────────────────────────────────────────────────────────────────

export type AgreementBucket =
  /** Router flagged it, model agreed. The router is doing its job. */
  | 'agreed'
  /** Router was unsure, model flagged it. Correct escalation — the router's main purpose. */
  | 'escalated'
  /** Router flagged it, model disagreed. Costs one inference; harmless. */
  | 'over_fired'
  /** Router unsure, model also said no. The common, boring case. */
  | 'both_clear'

export interface AgreementSummary {
  counts: Record<AgreementBucket, number>
  /** Posts that reached the model at all. */
  judged: number
  /**
   * ALWAYS TRUE, and the reason this panel needs a caveat in the UI.
   *
   * Posts the router called `clean` never reach the model, so there is no verdict row for them
   * and no way to know whether the router was right. The one error that matters — a silent miss —
   * is structurally unmeasurable from stored data.
   */
  cleanMissesUnmeasurable: true
}

export function routerAgreement(
  rows: readonly StoredVerdict[],
  thresholds: Partial<Record<Axis, number>>,
): AgreementSummary {
  const counts: Record<AgreementBucket, number> = {
    agreed: 0,
    escalated: 0,
    over_fired: 0,
    both_clear: 0,
  }

  for (const row of rows) {
    const band: TriageBand | undefined = row.triageBand
    if (!band || band === 'clean') continue // never judged; see cleanMissesUnmeasurable

    const modelFlagged = (Object.entries(row.signals) as Array<[Axis, { score: number; source: string }]>)
      .some(([axis, s]) => s.source === 'model' && s.score >= (thresholds[axis] ?? 70))

    if (band === 'likely_slop') counts[modelFlagged ? 'agreed' : 'over_fired']++
    else counts[modelFlagged ? 'escalated' : 'both_clear']++
  }

  return {
    counts,
    judged: counts.agreed + counts.escalated + counts.over_fired + counts.both_clear,
    cleanMissesUnmeasurable: true,
  }
}

// ── Feedback ────────────────────────────────────────────────────────────────────────────────

export interface AxisAgreement {
  axis: Axis
  total: number
  agreed: number
  rate: number | null
  /**
   * Whether this rate may be used to tune thresholds.
   *
   * False for `ai_written`. A 25M-comment study found human AI-accusations uncorrelated with the
   * actual statistical signal, so auto-tuning on those thumbs would train a "posts I find
   * annoying" classifier and then label its output "AI-written" (ADR-019). For
   * `engagement_bait` the user genuinely is ground truth.
   */
  usableForTuning: boolean
}

const TUNABLE: ReadonlySet<Axis> = new Set<Axis>(['engagement_bait', 'sponsored'])

export function feedbackByAxis(labels: readonly StoredLabel[], minSample = 10): AxisAgreement[] {
  const byAxisMap = new Map<Axis, { total: number; agreed: number }>()
  for (const label of labels) {
    const entry = byAxisMap.get(label.axis) ?? { total: 0, agreed: 0 }
    entry.total++
    if (label.userSays) entry.agreed++
    byAxisMap.set(label.axis, entry)
  }

  return [...byAxisMap.entries()].map(([axis, { total, agreed }]) => ({
    axis,
    total,
    agreed,
    rate: total >= minSample ? agreed / total : null,
    usableForTuning: TUNABLE.has(axis),
  }))
}
