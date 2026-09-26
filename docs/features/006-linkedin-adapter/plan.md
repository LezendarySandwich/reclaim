# 006 — LinkedIn adapter

**Status:** foundations only · blocked on spike S4 · **Started:** 2026-09-26

## Goal

Turn LinkedIn feed DOM into `Post` objects, and collapse posts into stubs. The only place in the
codebase that knows LinkedIn exists.

## Why this is the riskiest module

LinkedIn is **mid-migration between two completely different feeds**, both in production
simultaneously (today's AdGuard build ships rules for both):

| | Legacy (Ember) | Modern (React/SDUI) |
|---|---|---|
| Detect | `body.ember-application` | `body[data-rehydrated]`, `[data-testid="mainFeed"]` |
| Classes | Semantic | **8-hex build hashes, change every deploy** |
| Post URN | `data-urn` = `urn:li:activity:…` | **None. At all.** |

The missing URN is the load-bearing problem: it blocks history, metrics *and* the leaderboard,
because all three need to recognise the same post twice.

## Design

Three modules, separated along the lines most likely to change independently:

- **`selectors.ts`** — data only. Ordered fallback chains, attributes never classes on the modern
  feed. Bundled set is the ADR-023 fail-closed default for a remotely-updatable config.
- **`identity.ts`** — derivation in strict preference order (URN → permalink → composite hash),
  recording *which* strategy produced the id so consumers can tell how much to trust it.
- **`adapter.ts`** — the `SiteAdapter` implementation. Not yet written; blocked on S4.

## Traps, all documented in shipped prior-art code

1. **Hiding feed children kills infinite scroll.** LinkedIn's IntersectionObserver sentinel stops
   intersecting when the page stops growing. Never `display: none` a row — collapse height or
   replace inner content. Two independent projects hit this.
2. **Empty slots.** Rows mount before content arrives (`data-lazy-mount-id`). Do not classify on
   first insert.
3. **Node recycling.** If LinkedIn reuses DOM nodes between posts, `WeakMap<Element, state>` is
   unsafe and a stub will attach to the wrong post after scrolling. **S4 settles this.**
4. **Social proof pollutes text.** "Alice likes this" must be excluded or every model input is
   contaminated.

## What S4 must settle before `adapter.ts` can be written

1. Which feed profile this account is on, and whether it is per-user
2. Whether a permalink is rendered without opening the control menu — decides whether identity is
   usually `permalink` or usually `composite`
3. Whether nodes are recycled — decides whether per-element state is safe at all
4. Which candidate selectors actually match

## Non-goals

- Reddit (the seam exists; the implementation does not)
- Stub visual design (ships with the UI work)

## Acceptance criteria

- [ ] Extracts author, text, media and sponsored marker on both profiles
- [ ] Identity survives re-render and "see more" expansion
- [ ] Collapsing a post does not stop infinite scroll
- [ ] Empty slots are not classified
- [ ] Health reports `stale_selectors` distinctly from `no_feed_root`
