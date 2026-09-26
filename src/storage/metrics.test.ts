import { describe, expect, it } from 'vitest'
import {
  byAxis,
  dailySeries,
  feedbackByAxis,
  hasPlottableTrend,
  minutesSaved,
  overview,
  routerAgreement,
  since,
  thresholdView,
  withinWindow,
  auditSamples,
  estimateMissRate,
} from './metrics'
import type { StoredLabel, StoredVerdict } from './schema'
import type { Axis, TriageBand } from '../core/types'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function row(over: Partial<StoredVerdict> = {}): StoredVerdict {
  return {
    key: `k${Math.round((over.at ?? NOW) + (over.topScore ?? 0))}`,
    postId: 'p',
    authorUrn: '/in/alice',
    authorName: 'Alice',
    excerpt: 'x',
    action: 'show',
    triggeredBy: [],
    topScore: 0,
    signals: {},
    engineId: 'gemini-nano',
    rulesVersion: 'r1',
    at: NOW,
    ...over,
  }
}

const model = (score: number) => ({ score, source: 'model' })
const heur = (score: number) => ({ score, source: 'heuristic' })
const THRESH: Partial<Record<Axis, number>> = { engagement_bait: 70, ai_written: 80 }

describe('windows', () => {
  it('keeps rows inside and drops rows outside', () => {
    const rows = [row({ at: NOW }), row({ at: NOW - 3 * DAY }), row({ at: NOW - 20 * DAY })]
    expect(withinWindow(rows, NOW, 7)).toHaveLength(2)
    expect(withinWindow(rows, NOW, 1)).toHaveLength(1)
    expect(withinWindow(rows, NOW, 30)).toHaveLength(3)
  })

  it('computes the cutoff correctly', () => {
    expect(since(NOW, 7)).toBe(NOW - 7 * DAY)
  })
})

describe('overview', () => {
  it('counts scored and hidden', () => {
    const rows = [row({ action: 'collapse' }), row({ action: 'collapse' }), row()]
    expect(overview(rows)).toMatchObject({ scored: 3, hidden: 2 })
  })

  it('withholds a rate below the minimum sample', () => {
    // "50% of your feed hidden" off two posts is noise dressed as a finding.
    expect(overview([row({ action: 'collapse' }), row()]).hiddenRate).toBeNull()
  })

  it('reports a rate once there is enough data', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => row({ action: 'collapse' })),
      ...Array.from({ length: 6 }, () => row()),
    ]
    expect(overview(rows).hiddenRate).toBeCloseTo(0.4)
  })

  it('handles an empty set', () => {
    expect(overview([])).toEqual({ scored: 0, hidden: 0, hiddenRate: null })
  })
})

describe('byAxis', () => {
  it('counts what each axis actually hid', () => {
    const rows = [
      row({ action: 'collapse', triggeredBy: ['engagement_bait'], signals: { engagement_bait: model(90) } }),
      row({ signals: { engagement_bait: model(20) } }),
    ]
    const bait = byAxis(rows, THRESH).find((a) => a.axis === 'engagement_bait')!
    expect(bait.hidden).toBe(1)
    expect(bait.scored).toBe(2)
    expect(bait.meanScore).toBeCloseTo(55)
  })

  it('counts wouldHaveHidden for a shadow axis — the number that decides whether to enable it', () => {
    const rows = [
      row({ signals: { ai_written: model(95) } }),
      row({ signals: { ai_written: model(88) } }),
      row({ signals: { ai_written: model(10) } }),
    ]
    const ai = byAxis(rows, THRESH).find((a) => a.axis === 'ai_written')!
    expect(ai.hidden).toBe(0)
    expect(ai.wouldHaveHidden).toBe(2)
  })

  it('does NOT count a high heuristic score as wouldHaveHidden', () => {
    // A heuristic could never have hidden it (ADR-004), so counting it would overstate the case
    // for switching the axis on.
    const rows = [row({ signals: { ai_written: heur(99) } })]
    expect(byAxis(rows, THRESH).find((a) => a.axis === 'ai_written')!.wouldHaveHidden).toBe(0)
  })

  it('does not double-count a post that actually hid', () => {
    const rows = [
      row({ action: 'collapse', triggeredBy: ['engagement_bait'], signals: { engagement_bait: model(99) } }),
    ]
    const bait = byAxis(rows, THRESH).find((a) => a.axis === 'engagement_bait')!
    expect(bait.hidden).toBe(1)
    expect(bait.wouldHaveHidden).toBe(0)
  })

  it('returns nothing for axes never scored', () => {
    expect(byAxis([row()], THRESH)).toEqual([])
  })
})

describe('routerAgreement', () => {
  const band = (b: TriageBand, score: number): StoredVerdict =>
    row({ triageBand: b, signals: { engagement_bait: model(score) } })

  it('classifies the four buckets', () => {
    const rows = [
      band('likely_slop', 90), // agreed
      band('ambiguous', 90),   // escalated
      band('likely_slop', 10), // over-fired
      band('ambiguous', 10),   // both clear
    ]
    const out = routerAgreement(rows, THRESH)
    expect(out.counts).toEqual({ agreed: 1, escalated: 1, over_fired: 1, both_clear: 1 })
    expect(out.judged).toBe(4)
  })

  it('excludes clean-routed posts entirely — they were never judged', () => {
    const rows = [band('clean', 0), band('ambiguous', 90)]
    expect(routerAgreement(rows, THRESH).judged).toBe(1)
  })

  it('always flags that clean misses are unmeasurable', () => {
    // The one error that matters — the router waving through real slop — leaves no trace in
    // stored data. The UI must say so rather than implying these numbers are complete.
    expect(routerAgreement([], THRESH).cleanMissesUnmeasurable).toBe(true)
  })

  it('ignores rows written before the band was recorded', () => {
    expect(routerAgreement([row({ signals: { engagement_bait: model(90) } })], THRESH).judged).toBe(0)
  })
})

describe('feedbackByAxis', () => {
  const label = (axis: Axis, userSays: boolean): StoredLabel => ({
    key: `${axis}-${Math.random()}`,
    postId: 'p',
    axis,
    userSays,
    verdictAtTime: 80,
    at: NOW,
  })

  it('marks engagement_bait as usable for tuning', () => {
    const out = feedbackByAxis([label('engagement_bait', true)], 1)
    expect(out[0]!.usableForTuning).toBe(true)
  })

  it('marks ai_written as NOT usable for tuning', () => {
    // Human AI-accusations are uncorrelated with the statistical signal; tuning on them would
    // train a "posts I find annoying" classifier and mislabel it (ADR-019).
    const out = feedbackByAxis([label('ai_written', true)], 1)
    expect(out[0]!.usableForTuning).toBe(false)
  })

  it('withholds a rate below the minimum sample', () => {
    expect(feedbackByAxis([label('engagement_bait', true)], 10)[0]!.rate).toBeNull()
  })

  it('computes a rate once there is enough', () => {
    const labels = [
      ...Array.from({ length: 7 }, () => label('engagement_bait', true)),
      ...Array.from({ length: 3 }, () => label('engagement_bait', false)),
    ]
    expect(feedbackByAxis(labels, 10)[0]!.rate).toBeCloseTo(0.7)
  })
})

describe('dailySeries', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  it('includes days with no activity — gaps are information', () => {
    // A sparkline that omits empty days compresses time and implies continuous use.
    const rows = [row({ at: NOW }), row({ at: NOW - 6 * DAY_MS })]
    const series = dailySeries(rows, NOW, 7)
    expect(series).toHaveLength(7)
    expect(series.filter((d) => d.seen === 0).length).toBe(5)
  })

  it('withholds a daily rate below the minimum sample', () => {
    // Hiding 1 of 2 posts is not "50% of your feed".
    const rows = [row({ at: NOW, action: 'collapse' }), row({ at: NOW })]
    expect(dailySeries(rows, NOW, 1)[0]!.rate).toBeNull()
  })

  it('reports a rate once a day has enough posts', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => row({ at: NOW, action: 'collapse' })),
      ...Array.from({ length: 7 }, () => row({ at: NOW })),
    ]
    expect(dailySeries(rows, NOW, 1)[0]!.rate).toBeCloseTo(0.3)
  })

  it('is ordered oldest to newest', () => {
    const series = dailySeries([], NOW, 5)
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!.at).toBeGreaterThan(series[i - 1]!.at)
    }
  })

  it('drops rows outside the window rather than misattributing them', () => {
    expect(dailySeries([row({ at: NOW - 40 * DAY_MS })], NOW, 7).every((d) => d.seen === 0)).toBe(true)
  })

  it('needs three days of real data before a trend is plottable', () => {
    const twoDays = [
      ...Array.from({ length: 6 }, () => row({ at: NOW })),
      ...Array.from({ length: 6 }, () => row({ at: NOW - DAY_MS })),
    ]
    expect(hasPlottableTrend(dailySeries(twoDays, NOW, 7))).toBe(false)
    const threeDays = [...twoDays, ...Array.from({ length: 6 }, () => row({ at: NOW - 2 * DAY_MS }))]
    expect(hasPlottableTrend(dailySeries(threeDays, NOW, 7))).toBe(true)
  })
})

describe('thresholdView — the only actionable metric', () => {
  const scored = (score: number, source = 'model') =>
    row({ signals: { engagement_bait: { score, source } } })

  it('bins model scores', () => {
    const v = thresholdView([scored(5), scored(15), scored(95)], 'engagement_bait', 70)
    expect(v.total).toBe(3)
    expect(v.bins.find((b) => b.from === 0)!.count).toBe(1)
    expect(v.bins.find((b) => b.from === 10)!.count).toBe(1)
    expect(v.bins.find((b) => b.from === 90)!.count).toBe(1)
  })

  it('excludes heuristic scores — the threshold does not control them', () => {
    const v = thresholdView([scored(95, 'heuristic')], 'engagement_bait', 70)
    expect(v.total).toBe(0)
  })

  it('counts what the current threshold catches', () => {
    const v = thresholdView([scored(65), scored(85), scored(97)], 'engagement_bait', 70)
    expect(v.atOrAbove).toBe(2)
  })

  it('says what LOWERING the threshold would do', () => {
    // The actionable part: not "47 hidden" but "12 more if you moved the slider".
    const v = thresholdView([scored(65), scored(85), scored(97)], 'engagement_bait', 90)
    expect(v.atOrAbove).toBe(1)
    expect(v.whatIf.find((w) => w.threshold === 60)!.delta).toBe(2)
  })

  it('says what RAISING it would do', () => {
    const v = thresholdView([scored(65), scored(85), scored(97)], 'engagement_bait', 60)
    expect(v.whatIf.find((w) => w.threshold === 95)!.delta).toBe(-2)
  })

  it('never lists the current threshold as a what-if', () => {
    const v = thresholdView([scored(80)], 'engagement_bait', 70)
    expect(v.whatIf.some((w) => w.threshold === 70)).toBe(false)
  })

  it('puts a perfect 100 in the top bin', () => {
    const v = thresholdView([scored(100)], 'engagement_bait', 70)
    expect(v.bins.at(-1)!.count).toBe(1)
  })
})

describe('minutesSaved', () => {
  it('counts only hidden posts', () => {
    const long = 'x'.repeat(1100)
    expect(minutesSaved([row({ action: 'collapse', excerpt: long })])).toBeGreaterThan(0)
    expect(minutesSaved([row({ action: 'show', excerpt: long })])).toBe(0)
  })

  it('is zero for an empty set', () => {
    expect(minutesSaved([])).toBe(0)
  })
})

describe('audit samples are measurement, not enforcement', () => {
  it('are excluded from ordinary windows', () => {
    // Including them would inflate "posts seen" with traffic the user's scrolling did not
    // generate, distorting every rate computed from it.
    const rows = [row(), row({ auditSample: true })]
    expect(withinWindow(rows, NOW, 30)).toHaveLength(1)
    expect(auditSamples(rows, NOW, 30)).toHaveLength(1)
  })
})

describe('estimateMissRate — the previously unmeasurable number', () => {
  const audited = (score: number) =>
    row({ auditSample: true, signals: { engagement_bait: { score, source: 'model' } } })

  it('withholds an estimate below a usable sample', () => {
    const est = estimateMissRate([audited(90), audited(10)], THRESH)
    expect(est.rate).toBeNull()
    expect(est.interval).toBeNull()
    expect(est.sampled).toBe(2)
  })

  it('estimates once there is enough', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => audited(90)),
      ...Array.from({ length: 36 }, () => audited(10)),
    ]
    const est = estimateMissRate(rows, THRESH)
    expect(est.sampled).toBe(40)
    expect(est.missed).toBe(4)
    expect(est.rate).toBeCloseTo(0.1)
  })

  it('reports an interval, because a point estimate off 40 samples overclaims', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => audited(90)),
      ...Array.from({ length: 36 }, () => audited(10)),
    ]
    const { interval } = estimateMissRate(rows, THRESH)
    expect(interval).not.toBeNull()
    expect(interval!.low).toBeLessThan(0.1)
    expect(interval!.high).toBeGreaterThan(0.1)
    expect(interval!.low).toBeGreaterThanOrEqual(0)
  })

  it('handles a clean sweep without producing a nonsensical interval', () => {
    const rows = Array.from({ length: 30 }, () => audited(5))
    const est = estimateMissRate(rows, THRESH)
    expect(est.rate).toBe(0)
    expect(est.interval!.low).toBe(0)
    expect(est.interval!.high).toBeLessThan(0.2)
  })

  it('ignores heuristic scores — the router is being measured against the MODEL', () => {
    const rows = Array.from({ length: 30 }, () =>
      row({ auditSample: true, signals: { engagement_bait: { score: 99, source: 'heuristic' } } }),
    )
    expect(estimateMissRate(rows, THRESH).missed).toBe(0)
  })
})
