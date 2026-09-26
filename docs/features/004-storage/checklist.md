# 004 — Storage layer · checklist

Living. Tick on completion, **append on discovery**. See `../../../AGENTS.md`.

## Build

- [x] `src/storage/schema.ts` — stores, indexes, record types
- [x] `src/storage/db.ts` — open, write surface, transaction discipline
- [x] `src/storage/aggregates.ts` — pure ranking
- [x] `src/storage/settings.ts` — chrome.storage.local
- [x] `src/storage/index.ts`
- [x] Tests with fake-indexeddb 6.2.5

## Verification

- [x] `pnpm test` / `pnpm typecheck` green — 175 passing
- [x] Guarded by a test, not a grep-by-hand — `tests/invariants.test.ts`

## Discovered while working

_Append here. Strike through with a reason rather than deleting._

- [x] Added `tests/invariants.test.ts` — codebase-wide guards that no unit test would catch,
      because none of them is local to a module: no `chrome.storage.sync` (ADR-014), no network
      calls to LinkedIn (ADR-021), no site selectors outside `src/adapters/`, and `src/core` +
      `src/detect` free of platform calls. The last one immediately caught the doc comment in
      types.ts that *declares* the rule, so the guard now skips comment lines.
- [x] `withTx` takes a SYNCHRONOUS callback on purpose. IDB transactions auto-close the moment the
      task queue yields to a non-IDB promise, so making the callback async would make the footgun
      reachable through the public API. There is now nowhere to put a stray await.
- [x] `recordVerdict` does read-before-write so re-scoring the same cache key does not
      double-count the author aggregate. Tested — a re-render or second scroll past the same post
      would otherwise inflate the leaderboard.
- [x] Time is injected (`at`), never read inside the module. Keeps it pure and the tests
      deterministic.

## Discovered — not done

- [ ] **`recordVerdict` nests two callbacks inside one transaction** (verdict `get` →
      aggregate `get` → `put`). Correct and tested, including under 25 concurrent writes, but it
      is the least obvious code in the layer. If a third store ever joins the transaction,
      switch to `idb` rather than nesting further.
- [ ] `recentVerdicts(limit, onlyCollapsed)` filters AFTER the cursor read, so asking for 100
      collapsed posts walks the whole store when few are collapsed. Fine at 50k rows; add a
      compound `[action, at]` index if the timeline ever feels slow.
- [ ] **No storage-quota handling.** `navigator.storage.persist()` is not called and
      `QuotaExceededError` is not caught anywhere. ADR/brief say try `persist()` before ever
      requesting `unlimitedStorage`. Needs doing before launch.
- [ ] No migration path. `DB_VERSION` is 1 and `createStores` only creates. A v2 needs a real
      `onupgradeneeded` branch, and this is much easier to get right before there is user data.
- [ ] Retention is implemented but **nothing calls it yet** — it needs a `chrome.alarms` handler
      in the service worker. Until that exists, retention is theoretical.
- [ ] `summarizeAgreement` is deliberately not split by axis at the call site yet. ADR-019 forbids
      closing the tuning loop on `ai_written` thumbs; the dashboard must present those as an
      "annoyance" signal, and nothing enforces that separation in code yet.
- [ ] Labels are keyed `postId:axis`, but verdicts are keyed by the full cache key. A post
      re-scored under a new `rulesVersion` gets a new verdict row while keeping its old label.
      That is probably correct — the human's opinion did not change — but it means joining labels
      to verdicts needs care, and nothing does that join yet.
