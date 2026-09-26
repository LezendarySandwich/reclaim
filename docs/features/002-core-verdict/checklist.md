# 002 — Core verdict logic · checklist

Living. Tick on completion, **append on discovery**. See `../../../AGENTS.md`.

## Build

- [x] `src/core/cache.ts` — FNV-1a text hash, `verdictCacheKey`, `isStale`
- [x] `src/core/cache.test.ts`
- [x] Extend `Settings`/`AxisSetting` in types.ts for axis modes (ADR-019)
- [x] `src/core/verdict.ts` — `mergeVerdict`, `explain`
- [x] `src/core/verdict.test.ts` — exhaustive fail-open coverage

## Verification

- [x] `pnpm test` green — 84 passed
- [x] `pnpm typecheck` clean

## Discovered while working

_Append here. Strike through with a reason rather than deleting._

- [x] Added a `ShowReason` to the merge result. Not in the original design, but "why is this post
      visible?" has six distinct answers (no model / shadow / allowlisted / below threshold / no
      deciding signal / it collapsed) and collapsing them into a boolean makes the dashboard
      unable to explain itself and the tests unable to distinguish a correct show from a
      coincidentally-correct one.
- [x] Chose a non-printable separator (U+241F) in the cache key. Without it,
      `{postId:'a:b', textHash:'c'}` and `{postId:'a', textHash:'b:c'}` collide. Tested.
- [x] `normalizeForHash` deliberately does NOT lowercase — casing is a real triage signal
      (TITLE CASE HEADERS, ALL-CAPS hooks), so case-differing posts are genuinely different inputs.
- [ ] `mergeVerdict` takes the whole `Settings`. Once settings live in storage this becomes a
      read on every post; consider passing a narrowed, pre-resolved view instead.
- [ ] `explain()` returns English only. The stub is the most-rendered surface in the product and
      LinkedIn is heavily non-English — i18n needs a decision before launch, not after.
- [ ] Per-word-count threshold buckets (ADR-019 point 7) are NOT implemented. `mergeVerdict`
      takes one scalar threshold per axis. The literature says a single global threshold produces
      13-33% domain-specific FPR. Needs `Settings.axes[].threshold` to become a bucket map before
      ai_written could ever go enabled.
- [ ] Nothing enforces that a `metadata` signal stays non-deciding if someone later adds it to
      `CAN_DECIDE`. Consider a test that asserts the contents of that set directly.
