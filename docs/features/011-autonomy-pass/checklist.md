# 011 — Closing the loop · checklist

- [x] Model reason threaded into the signal and persisted
- [x] `lookupCached` injected into `classifyBatch`; SW supplies it from IndexedDB
- [x] Settings panel: mode, threshold, allowlist, retention, global pause
- [x] Threshold described by ladder rung, with the ai_written warning below 85
- [x] Audit sampling at 5% of cleared posts
- [x] `estimateMissRate` with a Wilson interval
- [x] Audit rows excluded from `withinWindow` and from author aggregates
- [x] `pnpm verify` green — 442 tests

## Discovered while working

- [x] Sliders persist on `change`, not `input`. Writing settings on every pixel of a drag would
      thrash storage and re-render the page mid-gesture; the readout still updates live.
- [x] Audit samples had to be excluded from the author aggregate as well as from the windows.
      The leaderboard is an accusation surface and measurement traffic must not move it.
- [x] Wilson interval rather than a normal approximation: this proportion will usually be small,
      and the normal approximation misbehaves near zero — it happily produces negative lower
      bounds.

## Discovered — not done

- [ ] The audit sample is drawn uniformly from cleared posts. Stratifying by score band (sample
      more heavily just below the `clean` boundary) would find misses faster for the same cost.
- [ ] The 5% rate is not adaptive. Once the interval is tight it could fall to 1%, and rise again
      after a rules change invalidates the estimate.
- [ ] `RULES_VERSION` changing invalidates the verdict cache correctly but also silently
      invalidates the accumulated miss estimate, which is not surfaced anywhere.
- [ ] Settings changes do not invalidate cached verdicts. Lowering a threshold re-renders the
      dashboard but previously-classified posts keep their stored action until re-scored.
- [ ] No keyboard shortcut to pause, and no popup control for it — the pause lives only in the
      dashboard.
