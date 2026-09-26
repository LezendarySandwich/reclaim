# 008 — Scheduler and pipeline · checklist

Living. Tick on completion, **append on discovery**. See `../../../AGENTS.md`.

## Build

- [x] `src/core/scheduler.ts` — single-slot, re-ranking, drop-not-abort
- [x] `src/core/scheduler.test.ts` — 15 tests including the scroll-while-queued case
- [x] `src/core/pipeline.ts` — `classifyBatch`
- [x] `src/core/pipeline.test.ts` — 13 tests
- [x] `TriagedPost` in the message contract, carrying heuristic scores for recording
- [x] Wire into the service worker's `CLASSIFY_BATCH`

## Verification

- [x] `pnpm verify` green — 268 tests, both builds, typecheck

## Discovered while working

- [x] **Removed the `offscreen` permission and the offscreen document entirely.** Once the Prompt
      API moved to the service worker (ADR-018), nothing called `ensureOffscreen()` — so we were
      shipping a permission that widens the install warning, with no code behind it and no answer
      for a store reviewer who asks. Both return with the WebLLM tier that justifies them
      (ADR-022). Asserted in `tests/manifest.test.ts` so it cannot creep back.
- [x] The engine and scheduler live at module scope in the worker, not per-message: backpressure
      that does not span tabs is not backpressure, and the base session is expensive.
- [x] `loadEngine()` deliberately STOPS at `needs_setup` when availability is `downloadable`. The
      worker could start a 4.27 GB download with no user gesture — which is precisely why it must
      not.

## Discovered — not done

- [ ] **Priority is batch index, not real viewport distance.** The content script sends
      nearest-first, so index is a serviceable proxy, but the scheduler's whole re-ranking design
      is wasted until a live caller passes a real measurement. Do this with the feed observer.
- [ ] Nothing persists the verdicts yet. `classifyBatch` returns `cacheKey` and `source` precisely
      so the caller can write them, and the caller does not. Storage exists; the wire does not.
- [ ] No verdict cache read. Every classify re-runs inference even for a post already scored under
      the same rules and engine, which is the entire point of the cache key. Cheap to add, and it
      needs deciding whether the SW or the dashboard owns the IndexedDB read.
- [ ] `dropBeyond` defaults to 4 viewport-heights and `maxQueue` to 40. Both invented, neither
      measured.
- [ ] The scheduler has no timeout. A model call that hangs forever blocks the single slot
      permanently. Needs a watchdog once real inference latency is known.
