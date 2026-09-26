/**
 * Dashboard metric panels.
 *
 * Separated from `main.ts` so the onboarding/consent flow and the analytics stay independently
 * readable — they have different failure modes and different reviewers.
 */

import { allAuthors, labelsForAxis, recentVerdicts } from '../../storage/db'
import { rankOffenders } from '../../storage/aggregates'
import {
  auditSamples,
  byAxis,
  dailySeries,
  estimateMissRate,
  feedbackByAxis,
  hasPlottableTrend,
  minutesSaved,
  overview,
  routerAgreement,
  thresholdView,
  withinWindow,
} from '../../storage/metrics'
import type { DayBucket } from '../../storage/metrics'
import { ALL_AXES } from '../../core/types'
import type { Axis, Settings } from '../../core/types'
import type { StoredLabel, StoredVerdict } from '../../storage/schema'

const AXIS_LABEL: Record<Axis, string> = {
  engagement_bait: 'Engagement bait',
  ai_written: 'Templated / AI-written',
  ai_image: 'AI images',
  sponsored: 'Promoted',
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.append(...children)
  return node
}

function stat(value: string, label: string): HTMLElement {
  return el('div', { className: 'stat' }, [
    el('div', { className: 'stat-value', textContent: value }),
    el('div', { className: 'stat-label', textContent: label }),
  ])
}

function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`
}

function ago(ms: number, now: number): string {
  const mins = Math.round((now - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export interface PanelData {
  rows: StoredVerdict[]
  labels: StoredLabel[]
  authors: Awaited<ReturnType<typeof allAuthors>>
  now: number
}

export async function loadPanelData(now: number): Promise<PanelData> {
  const [rows, authors, ...labelSets] = await Promise.all([
    // Enough to cover the 30-day window on an ordinary feed without loading everything.
    recentVerdicts(5000),
    allAuthors(),
    ...ALL_AXES.map((a) => labelsForAxis(a)),
  ])
  return { rows, authors, labels: labelSets.flat(), now }
}

function thresholdsOf(settings: Settings): Partial<Record<Axis, number>> {
  const out: Partial<Record<Axis, number>> = {}
  for (const axis of ALL_AXES) out[axis] = settings.axes[axis].threshold
  return out
}

/** Overview: counts across three windows. */
export function overviewPanel(data: PanelData): HTMLElement {
  const section = el('section')
  section.append(el('h2', { textContent: 'Overview' }))

  const windows: Array<[string, number]> = [['Today', 1], ['7 days', 7], ['30 days', 30]]
  const grid = el('div', { className: 'stats' })

  for (const [label, days] of windows) {
    const o = overview(withinWindow(data.rows, data.now, days))
    grid.append(stat(String(o.hidden), `hidden · ${label}`))
  }
  const month = overview(withinWindow(data.rows, data.now, 30))
  grid.append(stat(pct(month.hiddenRate), 'of posts seen (30d)'))

  section.append(grid)

  if (data.rows.length === 0) {
    section.append(
      el('p', {
        className: 'muted',
        textContent: 'Nothing recorded yet. Scroll your feed with a model installed and come back.',
      }),
    )
  } else if (month.hiddenRate === null) {
    section.append(
      el('p', {
        className: 'muted',
        textContent: 'Too few posts so far to quote a percentage honestly.',
      }),
    )
  }
  return section
}

/** Per-axis, with shadow-mode counts kept visually separate from real hides. */
export function axisPanel(data: PanelData, settings: Settings): HTMLElement {
  const section = el('section')
  section.append(el('h2', { textContent: 'What was hidden, and why' }))

  const rows = withinWindow(data.rows, data.now, 30)
  const breakdown = byAxis(rows, thresholdsOf(settings))

  if (breakdown.length === 0) {
    section.append(el('p', { className: 'muted', textContent: 'No posts scored yet.' }))
    return section
  }

  const table = el('table')
  table.append(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { textContent: 'Category' }),
        el('th', { textContent: 'Hidden' }),
        el('th', { textContent: 'Scored' }),
        el('th', { textContent: 'Avg score' }),
      ]),
    ]),
  )
  const body = el('tbody')
  for (const b of breakdown) {
    const mode = settings.axes[b.axis].mode
    const name = el('td')
    name.append(el('span', { textContent: AXIS_LABEL[b.axis] }))
    if (mode !== 'enabled') {
      name.append(el('span', { className: 'badge', textContent: mode === 'shadow' ? 'measuring only' : 'off' }))
    }
    body.append(
      el('tr', {}, [
        name,
        el('td', {
          className: 'num',
          textContent:
            mode === 'enabled'
              ? String(b.hidden)
              : b.wouldHaveHidden > 0
                ? `${b.wouldHaveHidden} would have`
                : '0',
        }),
        el('td', { className: 'num', textContent: String(b.scored) }),
        el('td', { className: 'num', textContent: b.meanScore === null ? '—' : String(Math.round(b.meanScore)) }),
      ]),
    )
  }
  table.append(body)
  section.append(table)

  const shadow = breakdown.find((b) => settings.axes[b.axis].mode === 'shadow' && b.wouldHaveHidden > 0)
  if (shadow) {
    section.append(
      el('p', {
        className: 'fineprint',
        textContent:
          `"${AXIS_LABEL[shadow.axis]}" is measuring only — it scores posts but never hides them. ` +
          `It would have hidden ${shadow.wouldHaveHidden} of the last ${rows.length} posts. ` +
          'Detecting machine-written text is unreliable at post length, and the published ' +
          'false-positive rates fall hardest on people writing in a second language, so it is off ' +
          'by default until these numbers give you a reason to trust it.',
      }),
    )
  }
  return section
}

/** Router vs model, with the unmeasurable gap stated rather than implied away. */
export function routerPanel(data: PanelData, settings: Settings): HTMLElement {
  const section = el('section')
  section.append(el('h2', { textContent: 'Fast check vs model' }))

  const rows = withinWindow(data.rows, data.now, 30)
  const agreement = routerAgreement(rows, thresholdsOf(settings))

  if (agreement.judged === 0) {
    section.append(el('p', { className: 'muted', textContent: 'Nothing judged yet.' }))
    return section
  }

  const grid = el('div', { className: 'stats' })
  grid.append(
    stat(String(agreement.counts.agreed), 'flagged, model agreed'),
    stat(String(agreement.counts.escalated), 'unsure, model flagged'),
    stat(String(agreement.counts.over_fired), 'flagged, model disagreed'),
    stat(String(agreement.counts.both_clear), 'unsure, model cleared'),
  )
  section.append(grid)

  // The miss estimate. Sampling a slice of cleared posts turns the router's invisible error
  // into an estimable one — the caveat below changes shape entirely once data exists.
  const est = estimateMissRate(auditSamples(data.rows, data.now, 30), thresholdsOf(settings))

  if (est.rate !== null && est.interval) {
    section.append(
      el('div', { className: 'stats' }, [
        stat(pct(est.rate), 'of cleared posts were missed'),
        stat(`${est.missed}/${est.sampled}`, 'audit sample'),
      ]),
      el('p', {
        className: 'fineprint',
        textContent:
          `A fast pattern check clears most posts without sending them to the model. Those ` +
          `decisions leave no record, so ${est.sampled} of them were sampled and judged anyway ` +
          `purely to measure. The model disagreed with ${est.missed} — an estimated miss rate of ` +
          `${pct(est.rate)}, somewhere between ${pct(est.interval.low)} and ` +
          `${pct(est.interval.high)} at 95% confidence. Sampled posts are never hidden.`,
      }),
    )
  } else {
    section.append(
      el('p', {
        className: 'fineprint',
        textContent:
          'A fast pattern check runs on every post and decides which are worth sending to the ' +
          'model; it never hides anything on its own. Posts it clears are not judged, so a ' +
          'mistake there leaves no record. A small share of cleared posts is now sampled and sent ' +
          'to the model anyway to estimate how often that happens — ' +
          (est.sampled === 0
            ? 'no samples collected yet.'
            : `${est.sampled} collected so far, not yet enough to quote a figure.`),
      }),
    )
  }
  return section
}

/** Recently hidden, with a way to disagree. */
export function historyPanel(data: PanelData, onDisagree: (row: StoredVerdict) => void): HTMLElement {
  const section = el('section')
  section.append(el('h2', { textContent: 'Recently hidden' }))

  const hidden = data.rows.filter((r) => r.action === 'collapse').slice(0, 25)
  if (hidden.length === 0) {
    section.append(el('p', { className: 'muted', textContent: 'Nothing has been hidden yet.' }))
    return section
  }

  for (const row of hidden) {
    const item = el('details', { className: 'entry' })
    const reasons = row.triggeredBy.map((a) => AXIS_LABEL[a]).join(', ')
    item.append(
      el('summary', {}, [
        el('span', { className: 'entry-author', textContent: row.authorName || 'Unknown author' }),
        el('span', { className: 'entry-reason', textContent: ` — ${reasons}` }),
        el('span', { className: 'entry-time', textContent: ago(row.at, data.now) }),
      ]),
      el('p', { className: 'excerpt', textContent: row.excerpt }),
    )

    const wrong = el('button', { textContent: 'This was wrong' })
    wrong.addEventListener('click', () => {
      wrong.disabled = true
      wrong.textContent = 'Noted — thank you'
      onDisagree(row)
    })
    item.append(el('div', { className: 'actions' }, [wrong]))
    section.append(item)
  }

  const feedback = feedbackByAxis(data.labels)
  const usable = feedback.filter((f) => f.usableForTuning && f.rate !== null)
  if (usable.length > 0) {
    section.append(
      el('p', {
        className: 'muted',
        textContent: usable
          .map((f) => `${AXIS_LABEL[f.axis]}: you agreed with ${pct(f.rate)} of ${f.total} judgements.`)
          .join(' '),
      }),
    )
  }
  return section
}

/** Repeat posters. An accusation surface by construction, so it is worded carefully. */
export function authorsPanel(data: PanelData): HTMLElement {
  const section = el('section')
  section.append(el('h2', { textContent: 'Who posts it most' }))

  const ranked = rankOffenders(data.authors, { limit: 10 })
  if (ranked.length === 0) {
    section.append(
      el('p', {
        className: 'muted',
        textContent:
          'Nobody yet. An author needs at least five posts before appearing here — one bad post ' +
          'is not a pattern.',
      }),
    )
    return section
  }

  const table = el('table')
  table.append(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { textContent: 'Author' }),
        el('th', { textContent: 'Flagged' }),
        el('th', { textContent: 'Seen' }),
        el('th', { textContent: 'Rate' }),
        el('th', { textContent: '' }),
      ]),
    ]),
  )
  const body = el('tbody')
  for (const author of ranked) {
    const link = el('a', {
      textContent: author.authorName || author.authorUrn,
      href: author.authorUrn.startsWith('/') ? `https://www.linkedin.com${author.authorUrn}` : author.authorUrn,
      target: '_blank',
      rel: 'noreferrer',
    })
    body.append(
      el('tr', {}, [
        el('td', {}, [link]),
        el('td', { className: 'num', textContent: String(author.postsFlagged) }),
        el('td', { className: 'num', textContent: String(author.postsSeen) }),
        el('td', { className: 'num', textContent: pct(author.flagRate) }),
        // Deliberately a link to their profile, not an unfollow button. Phase 4 is a separate
        // extension with per-action confirmation (ADR-011, ADR-016) — a one-click destructive
        // action driven by an uncalibrated classifier does not belong on a metrics page.
        el('td', {}, [el('span', { className: 'muted', textContent: 'open profile to unfollow' })]),
      ]),
    )
  }
  table.append(body)
  section.append(table)

  section.append(
    el('p', {
      className: 'fineprint',
      textContent:
        'Ranked by how often, not how much — someone who posts constantly will not top this list ' +
        'for that alone. These counts describe what Reclaim flagged, which is a judgement about ' +
        'writing style and can be wrong. It is not a claim about anyone.',
    }),
  )
  return section
}

// ── Trend ───────────────────────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg'

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/**
 * Inline SVG sparkline. No chart library — this is a polyline, and a dependency for it would be
 * bundle weight on an extension that has to justify its size.
 *
 * Plots the RATE, not the count. Counts over time mostly measure how much the user scrolled:
 * twenty hidden today against five yesterday may only mean four times as much feed.
 */
function sparkline(series: DayBucket[], label: string): SVGSVGElement {
  const W = 320
  const H = 48
  const PAD = 4
  const points = series.map((d, i) => ({ d, i }))
  const known = points.filter((p) => p.d.rate !== null)
  const max = Math.max(0.1, ...known.map((p) => p.d.rate ?? 0))

  const x = (i: number) => PAD + (i / Math.max(1, series.length - 1)) * (W - PAD * 2)
  const y = (rate: number) => H - PAD - (rate / max) * (H - PAD * 2)

  const chart = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: '100%',
    height: H,
    role: 'img',
    'aria-label': label,
    preserveAspectRatio: 'none',
  })

  // Segment-by-segment rather than one polyline, so days with no data leave a genuine gap
  // instead of a straight line implying continuity that did not happen.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    if (a.d.rate === null || b.d.rate === null) continue
    chart.append(
      svg('line', {
        x1: x(a.i), y1: y(a.d.rate), x2: x(b.i), y2: y(b.d.rate),
        stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round',
      }),
    )
  }
  for (const p of known) {
    chart.append(svg('circle', { cx: x(p.i), cy: y(p.d.rate ?? 0), r: 2.5, fill: 'currentColor' }))
  }
  return chart
}

export function trendPanel(data: PanelData): HTMLElement {
  const section = el('section')
  section.append(el('h2', { textContent: 'Trend' }))

  const series = dailySeries(data.rows, data.now, 30)

  if (!hasPlottableTrend(series)) {
    section.append(
      el('p', {
        className: 'muted',
        textContent:
          'Not enough days yet. A trend needs at least three days with a handful of posts each — ' +
          'anything less is a line drawn through noise.',
      }),
    )
    return section
  }

  const known = series.filter((d) => d.rate !== null)
  const first = known[0]!
  const last = known.at(-1)!
  const change = (last.rate ?? 0) - (first.rate ?? 0)

  section.append(
    el('div', { className: 'spark' }, [
      sparkline(
        series,
        `Share of posts hidden per day over ${known.length} active days, ` +
          `from ${pct(first.rate)} to ${pct(last.rate)}.`,
      ),
    ]),
    el('p', {
      className: 'muted',
      textContent:
        `Share of posts hidden per day · ${known.length} active days · ` +
        `${pct(first.rate)} → ${pct(last.rate)}` +
        (Math.abs(change) < 0.02 ? ' (flat)' : change > 0 ? ' (rising)' : ' (falling)'),
    }),
    el('p', {
      className: 'fineprint',
      textContent:
        'This plots the SHARE of posts hidden, not the number. A raw count mostly tracks how much ' +
        'you scrolled — twenty hidden today against five yesterday may just mean four times as ' +
        'much feed. Days with fewer than five posts are left blank rather than guessed at.',
    }),
  )

  const saved = minutesSaved(withinWindow(data.rows, data.now, 30))
  if (saved >= 1) {
    section.append(
      el('p', {
        className: 'muted',
        textContent:
          `Roughly ${Math.round(saved)} minutes of reading skipped in 30 days — a floor, not a ` +
          'measurement, since only a 400-character excerpt of each post is stored.',
      }),
    )
  }
  return section
}

// ── Threshold tuning ────────────────────────────────────────────────────────────────────────

/**
 * Score distribution against the current threshold.
 *
 * The most actionable panel here, and the reason is that every other metric is retrospective.
 * A count says what happened; this says what WOULD happen if the slider moved, which is the only
 * form in which a threshold can actually be reasoned about.
 */
export function thresholdPanel(data: PanelData, settings: Settings): HTMLElement {
  const section = el('section')
  section.append(el('h2', { textContent: 'Where the line sits' }))

  const rows = withinWindow(data.rows, data.now, 30)
  const enabled = ALL_AXES.filter((a) => settings.axes[a].mode !== 'off')
  let rendered = 0

  for (const axis of enabled) {
    const view = thresholdView(rows, axis, settings.axes[axis].threshold)
    if (view.total < 10) continue
    rendered++

    const max = Math.max(...view.bins.map((b) => b.count), 1)
    const bars = el('div', { className: 'hist' })
    for (const bin of view.bins) {
      const above = bin.from >= view.threshold
      const col = el('div', { className: `hist-col${above ? ' above' : ''}` })
      const fill = el('i')
      fill.style.height = `${(bin.count / max) * 100}%`
      col.append(fill)
      col.title = `${bin.from}-${bin.to}: ${bin.count} post${bin.count === 1 ? '' : 's'}`
      bars.append(col)
    }

    section.append(
      el('h3', { textContent: AXIS_LABEL[axis] }),
      bars,
      el('p', {
        className: 'muted',
        textContent:
          `Threshold ${view.threshold} · ${view.atOrAbove} of ${view.total} scored posts are at ` +
          'or above it. Bars right of the line are the ones hidden.',
      }),
    )

    // Only offer moves that would actually change something. A list of zeroes is noise.
    const meaningful = view.whatIf.filter((w) => w.delta !== 0).slice(0, 4)
    if (meaningful.length > 0) {
      section.append(
        el('p', {
          className: 'fineprint',
          textContent:
            'If you moved it: ' +
            meaningful
              .map(
                (w) =>
                  `${w.threshold} → ${w.delta > 0 ? '+' : ''}${w.delta} post${Math.abs(w.delta) === 1 ? '' : 's'}`,
              )
              .join(' · '),
        }),
      )
    }
  }

  if (rendered === 0) {
    section.append(
      el('p', {
        className: 'muted',
        textContent: 'Needs at least ten scored posts on an axis before a distribution says anything.',
      }),
    )
  }
  return section
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────

/** Ladder rung boundaries, so a threshold reads as a decision rather than a number. */
const RUNG_AT: Array<{ at: number; name: string }> = [
  { at: 0, name: 'anything' },
  { at: 15, name: 'a slight hint' },
  { at: 38, name: 'some markers' },
  { at: 65, name: 'clearly so' },
  { at: 85, name: 'heavily so' },
  { at: 97, name: 'almost nothing but' },
]

/**
 * Translate a threshold into the rung it actually admits.
 *
 * A bare "90" means nothing to a reader. The model answers on a six-rung ladder, so the honest
 * statement is which rung the setting lets through — "only posts the model calls almost nothing
 * but this".
 */
function describeThreshold(t: number): string {
  const admitted = RUNG_AT.filter((r) => r.at >= t)
  if (admitted.length === 0) return 'nothing will ever cross this'
  if (admitted.length === RUNG_AT.length) return 'hides essentially everything scored'
  return `hides posts the model calls "${admitted[0]!.name}" or stronger`
}

export interface SettingsHandlers {
  onChange: (next: Settings) => void
}

export function settingsPanel(settings: Settings, handlers: SettingsHandlers): HTMLElement {
  const section = el('section')
  section.append(el('h2', { textContent: 'Settings' }))

  for (const axis of ALL_AXES) {
    const setting = settings.axes[axis]
    const row = el('div', { className: 'setting' })

    const head = el('div', { className: 'setting-head' }, [
      el('span', { className: 'model-name', textContent: AXIS_LABEL[axis] }),
    ])

    const modeSelect = el('select')
    for (const [value, label] of [
      ['enabled', 'Hide these'],
      ['shadow', 'Measure only'],
      ['off', 'Ignore'],
    ] as const) {
      const opt = el('option', { value, textContent: label })
      if (setting.mode === value) opt.selected = true
      modeSelect.append(opt)
    }
    modeSelect.setAttribute('aria-label', `What to do with ${AXIS_LABEL[axis]}`)
    modeSelect.addEventListener('change', () => {
      const next = structuredClone(settings)
      next.axes[axis].mode = modeSelect.value as Settings['axes'][Axis]['mode']
      handlers.onChange(next)
    })
    head.append(modeSelect)
    row.append(head)

    if (setting.mode === 'enabled') {
      const slider = el('input', { type: 'range', min: '30', max: '97', step: '1' })
      slider.value = String(setting.threshold)
      slider.setAttribute('aria-label', `Confidence needed to hide ${AXIS_LABEL[axis]}`)

      const readout = el('div', {
        className: 'muted',
        textContent: `${setting.threshold} — ${describeThreshold(setting.threshold)}`,
      })
      // Live-update the label while dragging, but only persist on release — writing settings on
      // every pixel of a drag would thrash storage and re-render the page mid-gesture.
      slider.addEventListener('input', () => {
        readout.textContent = `${slider.value} — ${describeThreshold(Number(slider.value))}`
      })
      slider.addEventListener('change', () => {
        const next = structuredClone(settings)
        next.axes[axis].threshold = Number(slider.value)
        handlers.onChange(next)
      })
      row.append(slider, readout)

      if (axis === 'ai_written' && setting.threshold < 85) {
        row.append(
          el('p', {
            className: 'fineprint',
            textContent:
              'Below "heavily so", this axis starts hiding posts on a judgement the research does ' +
              'not support at post length. Published detectors score near chance on short text, and ' +
              'the measured false positives fall hardest on people writing in a second language. ' +
              'Lower it if your own numbers justify it, not on principle.',
          }),
        )
      }
    }
    section.append(row)
  }

  // Allowlist -------------------------------------------------------------------------------
  const allow = el('div', { className: 'setting' })
  allow.append(el('div', { className: 'setting-head' }, [el('span', { className: 'model-name', textContent: 'Never hide' })]))

  if (settings.allowlist.length === 0) {
    allow.append(el('p', { className: 'muted', textContent: 'Nobody yet. Add people from a collapsed post.' }))
  } else {
    const list = el('ul', { className: 'allowlist' })
    for (const urn of settings.allowlist) {
      const remove = el('button', { textContent: 'Remove' })
      remove.addEventListener('click', () => {
        const next = structuredClone(settings)
        next.allowlist = next.allowlist.filter((u) => u !== urn)
        handlers.onChange(next)
      })
      list.append(el('li', {}, [el('span', { textContent: urn }), remove]))
    }
    allow.append(list)
  }
  section.append(allow)

  // Retention -------------------------------------------------------------------------------
  const retention = el('div', { className: 'setting' })
  const days = el('select')
  for (const value of [7, 30, 90, 180]) {
    const opt = el('option', { value: String(value), textContent: `${value} days` })
    if (settings.retentionDays === value) opt.selected = true
    days.append(opt)
  }
  days.setAttribute('aria-label', 'How long to keep post history')
  days.addEventListener('change', () => {
    const next = structuredClone(settings)
    next.retentionDays = Number(days.value)
    handlers.onChange(next)
  })
  retention.append(
    el('div', { className: 'setting-head' }, [
      el('span', { className: 'model-name', textContent: 'Keep history for' }),
      days,
    ]),
    el('p', {
      className: 'muted',
      textContent: 'Excerpts of other people’s posts, stored on this device only. Shorter is kinder.',
    }),
  )
  section.append(retention)

  // Global pause ----------------------------------------------------------------------------
  const pause = el('div', { className: 'setting' })
  const toggle = el('button', {
    textContent: settings.shadowMode ? 'Resume hiding' : 'Pause hiding (keep measuring)',
  })
  toggle.addEventListener('click', () => {
    const next = structuredClone(settings)
    next.shadowMode = !next.shadowMode
    handlers.onChange(next)
  })
  pause.append(
    el('div', { className: 'actions' }, [toggle]),
    el('p', {
      className: 'muted',
      textContent: settings.shadowMode
        ? 'Paused. Posts are still being scored so the dashboard keeps filling, but nothing is hidden.'
        : 'Pausing keeps scoring and recording, so you can watch what it would do without it doing it.',
    }),
  )
  section.append(pause)

  return section
}
