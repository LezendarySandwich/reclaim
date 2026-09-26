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
