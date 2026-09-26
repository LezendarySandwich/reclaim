/**
 * Dashboard metric panels.
 *
 * Separated from `main.ts` so the onboarding/consent flow and the analytics stay independently
 * readable — they have different failure modes and different reviewers.
 */

import { allAuthors, labelsForAxis, recentVerdicts } from '../../storage/db'
import { rankOffenders } from '../../storage/aggregates'
import { byAxis, feedbackByAxis, overview, routerAgreement, withinWindow } from '../../storage/metrics'
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

  section.append(
    el('p', {
      className: 'fineprint',
      textContent:
        'A fast pattern check runs on every post and decides which are worth sending to the ' +
        'model; it never hides anything on its own. Posts it judged obviously fine were never ' +
        'sent, so if it waved something through by mistake, that mistake does not appear ' +
        'here — and cannot be counted. These figures cover only the posts the model actually saw.',
    }),
  )
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
