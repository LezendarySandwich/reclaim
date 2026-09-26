# 010 — Dashboard metrics · checklist

Living. Tick on completion, **append on discovery**. See `../../../AGENTS.md`.

## Build

- [x] Persist verdicts from the service worker after classification
- [x] Router-band recorded on the verdict, so agreement is computable
- [x] `src/storage/metrics.ts` — pure aggregation, 19 tests
- [x] Dashboard panels — overview, by-axis, router agreement, history, authors

## Verification

- [x] `pnpm verify` green — 377 tests

## Discovered while working

_Append here. Strike through with a reason rather than deleting._

- [x] Persistence responds to the content script FIRST, then writes. Storage is a dashboard
      nicety; blocking a classification on it would cost the user their feed to save a history row.
- [x] Retention is now actually enforced — a `chrome.alarms` handler purges past the window every
      12 hours. It existed as a function nothing called, which is the same as not existing.
- [x] `wouldHaveHidden` counts only MODEL signals. A high heuristic score could never have hidden
      the post anyway (ADR-004), so counting it would overstate the case for enabling an axis.
- [x] Rates are withheld below a 10-post sample. "50% of your feed hidden" off two posts is noise
      presented as a finding.
- [x] The authors table links to a profile rather than offering an unfollow button. A one-click
      destructive action driven by an uncalibrated classifier does not belong on a metrics page
      (ADR-011, ADR-016).

## Discovered — not done

- [ ] **The router panel's most important number is unmeasurable and always will be.** Posts
      routed `clean` never reach the model, so a silent miss leaves no trace. The panel says so
      in plain words, but the only real fix is periodically sampling `clean` posts through the
      model anyway to estimate the miss rate. Worth doing once there is enough traffic.
- [ ] `loadPanelData` reads the most recent 5000 verdicts and filters in memory. Fine at feed
      volumes; becomes wrong if retention is ever raised well past 30 days.
- [ ] No verdict-cache read still. Scrolling back over a post re-runs inference even though the
      row is now in IndexedDB under a key we could look up first.
- [ ] Feedback is write-only in the UI sense: `putLabel` is called but the page does not re-render
      to reflect it, so the agreement figure only updates on reload.
- [ ] The history panel shows the last 25 hidden posts with no paging and no filtering by axis or
      author.

## Time series and threshold tuning — 2026-09-26

- [x] `dailySeries` — daily buckets in LOCAL time, including empty days. A sparkline that omits
      quiet days compresses time and implies continuous use that did not happen.
- [x] **Plots the RATE, not the count.** A count over time mostly measures how much the user
      scrolled: twenty hidden today against five yesterday may only mean four times as much feed.
      The count is available but the rate is what is charted, and the panel says why.
- [x] Daily rates are withheld below five posts, and no trend line is drawn below three active
      days. A line through two points is decoration.
- [x] Sparkline is inline SVG drawn segment-by-segment, so gaps stay gaps. No chart library —
      it is a polyline, and a dependency would be bundle weight on an extension that has to
      justify its size. Carries an `aria-label` with the actual numbers.
- [x] **`thresholdView` — the one genuinely actionable metric.** Every other panel is
      retrospective: a count says what happened. This says what WOULD happen if the slider moved
      ("85 → +12 posts"), which is the only form in which a threshold can be reasoned about.
      Counts model scores only, since a heuristic score is not something the threshold controls.
- [x] `minutesSaved`, labelled a floor rather than a measurement — excerpts are capped at 400
      characters, so long posts are undercounted.

## Discovered — not done

- [ ] The what-if numbers are retrospective too: they say what the threshold would have done to
      posts already scored, which is not the same as what it will do next week. Honest for
      tuning, misleading if read as a forecast.
- [ ] No way to change a threshold from the dashboard yet. It tells you exactly what moving the
      slider would do and then offers no slider.
- [ ] `minutesSaved` assumes 230 wpm for everyone.
- [ ] The trend panel only plots the overall hidden rate. Per-axis trends would show whether
      `ai_written` at 90 is drifting, which is the question most likely to need answering.
