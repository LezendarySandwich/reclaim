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
  // Audit samples are measurement traffic — posts the router cleared, sent to the model only to
  // estimate its miss rate. Including them would inflate "posts seen" with traffic the user's
  // scrolling did not generate and distort every rate computed from it.
  return rows.filter((r) => r.at >= cutoff && !r.auditSample)
}

/** Audit samples only. */
export function auditSamples(rows: readonly StoredVerdict[], now: number, days: number): StoredVerdict[] {
  const cutoff = since(now, days)
  return rows.filter((r) => r.at >= cutoff && r.auditSample === true)
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

// ── Time series ─────────────────────────────────────────────────────────────────────────────

export interface DayBucket {
  /** Local-time day key, YYYY-MM-DD. */
  day: string
  /** Midnight local time for that day, epoch ms. */
  at: number
  seen: number
  hidden: number
  /**
   * hidden / seen, or null when too few posts that day to mean anything.
   *
   * The rate is the honest series and the count is the misleading one: hiding 20 posts today and
   * 5 yesterday may only mean you scrolled four times as far. Anything plotting counts over time
   * is really plotting how much the user scrolled.
   */
  rate: number | null
}

const MIN_PER_DAY_FOR_RATE = 5

function dayKey(at: number): string {
  const d = new Date(at)
  // Local time, not UTC: a user's sense of "yesterday" is their own midnight.
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function startOfDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Daily buckets, including days with no activity.
 *
 * Gaps matter: a sparkline that silently omits empty days compresses time and implies continuous
 * use that did not happen.
 */
export function dailySeries(
  rows: readonly StoredVerdict[],
  now: number,
  days: number,
): DayBucket[] {
  const buckets = new Map<string, { seen: number; hidden: number; at: number }>()

  const todayStart = startOfDay(now)
  for (let i = days - 1; i >= 0; i--) {
    const at = todayStart - i * 24 * 60 * 60 * 1000
    buckets.set(dayKey(at), { seen: 0, hidden: 0, at })
  }

  for (const row of rows) {
    const key = dayKey(row.at)
    const bucket = buckets.get(key)
    if (!bucket) continue // outside the window
    bucket.seen++
    if (row.action === 'collapse') bucket.hidden++
  }

  return [...buckets.entries()].map(([day, b]) => ({
    day,
    at: b.at,
    seen: b.seen,
    hidden: b.hidden,
    rate: b.seen >= MIN_PER_DAY_FOR_RATE ? b.hidden / b.seen : null,
  }))
}

/** Days with enough activity to plot. Fewer than three and a trend line is decoration. */
export function hasPlottableTrend(series: readonly DayBucket[]): boolean {
  return series.filter((d) => d.rate !== null).length >= 3
}

// ── Score distribution ──────────────────────────────────────────────────────────────────────

export interface HistogramBin {
  /** Inclusive lower bound. */
  from: number
  /** Exclusive upper bound, except the final bin which is inclusive of 100. */
  to: number
  count: number
}

export interface ThresholdView {
  axis: Axis
  threshold: number
  bins: HistogramBin[]
  /** Posts at or above the current threshold. */
  atOrAbove: number
  total: number
  /**
   * What moving the threshold would do, relative to now.
   *
   * This is the actionable number. A count tells you what happened; this tells you what WOULD
   * happen, which is the only form in which a threshold setting can be reasoned about.
   */
  whatIf: Array<{ threshold: number; delta: number }>
}

const BIN_WIDTH = 10
const WHAT_IF_POINTS = [50, 60, 65, 70, 75, 80, 85, 90, 95]

/**
 * Score distribution for one axis, with the threshold marked.
 *
 * Only MODEL scores are counted. A heuristic score can never hide a post (ADR-004), so including
 * it would make the histogram describe a decision the threshold does not actually control.
 */
export function thresholdView(
  rows: readonly StoredVerdict[],
  axis: Axis,
  threshold: number,
): ThresholdView {
  const scores: number[] = []
  for (const row of rows) {
    const signal = row.signals[axis]
    if (signal && signal.source === 'model') scores.push(signal.score)
  }

  const bins: HistogramBin[] = []
  for (let from = 0; from < 100; from += BIN_WIDTH) {
    const to = from + BIN_WIDTH
    bins.push({
      from,
      to,
      count: scores.filter((s) => (to === 100 ? s >= from && s <= 100 : s >= from && s < to)).length,
    })
  }

  const atOrAbove = scores.filter((s) => s >= threshold).length

  return {
    axis,
    threshold,
    bins,
    atOrAbove,
    total: scores.length,
    whatIf: WHAT_IF_POINTS.filter((t) => t !== threshold).map((t) => ({
      threshold: t,
      delta: scores.filter((s) => s >= t).length - atOrAbove,
    })),
  }
}

// ── Time saved ──────────────────────────────────────────────────────────────────────────────

/** Adult silent reading speed, words per minute. Deliberately conservative. */
const WPM = 230
/** Words in an excerpt are capped at EXCERPT_CHARS, so estimate from characters instead. */
const CHARS_PER_WORD = 5.5

/**
 * Rough reading time avoided, in minutes.
 *
 * An estimate and labelled as one. Excerpts are truncated at 400 characters, so a long post is
 * undercounted — the figure is a floor, not a measurement, and the UI should not imply otherwise.
 */
export function minutesSaved(rows: readonly StoredVerdict[]): number {
  const chars = rows
    .filter((r) => r.action === 'collapse')
    .reduce((sum, r) => sum + r.excerpt.length, 0)
  return chars / CHARS_PER_WORD / WPM
}

// ── Router miss rate (the estimate for the unmeasurable) ────────────────────────────────────

export interface MissRateEstimate {
  /** Cleared posts that were sampled and sent to the model anyway. */
  sampled: number
  /** Of those, how many the model would have flagged. */
  missed: number
  /** 0-1, or null below a usable sample. */
  rate: number | null
  /**
   * Wilson 95% interval. A point estimate off 40 samples invites more confidence than it earns,
   * and the honest form of "about 8%" is "somewhere between 3% and 18%".
   */
  interval: { low: number; high: number } | null
}

const MIN_AUDIT_SAMPLE = 20

/**
 * Estimate how often the triage router clears a post the model would have flagged.
 *
 * This is the number the agreement panel previously had to declare unmeasurable. It still cannot
 * be counted directly — a post the model never saw leaves no verdict — but sampling the cleared
 * population makes it estimable, which is a different and much better position.
 */
export function estimateMissRate(
  rows: readonly StoredVerdict[],
  thresholds: Partial<Record<Axis, number>>,
): MissRateEstimate {
  const sampled = rows.length
  const missed = rows.filter((row) =>
    (Object.entries(row.signals) as Array<[Axis, { score: number; source: string }]>).some(
      ([axis, s]) => s.source === 'model' && s.score >= (thresholds[axis] ?? 70),
    ),
  ).length

  if (sampled < MIN_AUDIT_SAMPLE) return { sampled, missed, rate: null, interval: null }

  const p = missed / sampled
  // Wilson score interval — behaves sensibly near 0, which a normal approximation does not, and
  // this proportion will usually be small.
  const z = 1.96
  const denom = 1 + (z * z) / sampled
  const centre = (p + (z * z) / (2 * sampled)) / denom
  const spread =
    (z * Math.sqrt((p * (1 - p)) / sampled + (z * z) / (4 * sampled * sampled))) / denom

  return {
    sampled,
    missed,
    rate: p,
    interval: { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) },
  }
}
