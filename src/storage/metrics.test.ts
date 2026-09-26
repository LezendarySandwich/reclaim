import { describe, expect, it } from 'vitest'
import { byAxis, feedbackByAxis, overview, routerAgreement, since, withinWindow } from './metrics'
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
