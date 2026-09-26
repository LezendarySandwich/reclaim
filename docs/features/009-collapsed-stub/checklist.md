# 009 — Collapsed stub · checklist

Living. Tick on completion, **append on discovery**. See `../../../AGENTS.md`.

## Build

- [x] `src/ui/stub.ts` — mount, unmount, shadow-root styling
- [x] `src/ui/stub.test.ts` — 21 tests, a11y behaviour asserted not assumed

## Verification

- [x] `pnpm test` green — 289 passing
- [ ] **VoiceOver / NVDA pass** — needs a human
- [ ] **Forced-colors (Windows high contrast) pass** — needs a human
- [ ] 200% browser zoom and 200% OS font scale
- [ ] Verify on a real LinkedIn feed that collapsing does not stop infinite scroll

## Discovered while working

- [x] Two of my own tests were wrong in the same way the invariants test was: they asserted
      against `shadowRoot.textContent`, which includes the `<style>` element. The "never renders
      a number" test tripped on CSS values, and the "no `all: initial`" test tripped on the CSS
      *comment explaining why we avoid `all: initial`*. Both now scope to the visible bar or
      strip comments first.
- [x] `restore()` captures each child's PREVIOUS inline display value rather than blanking it, so
      a post the page had explicitly set to `display: flex` comes back as flex, not as default.
      Tested.

## Discovered — not done

- [ ] **happy-dom does no layout** — every element reports a 0×0 rect, so none of the sizing,
      contrast or focus-ring assertions prove anything visually. They assert the CSS *says* the
      right thing. Real verification is a Playwright run plus a human with a screen reader.
- [ ] The stub is English-only (`Show`, `Not slop`). i18n is unresolved product-wide and this is
      the most visible instance of it.
- [ ] "Not slop" is placeholder copy. It is jocular, and on a surface that is making a judgement
      about someone's writing that may be the wrong register.
- [ ] No expand/collapse animation, and `prefers-reduced-motion` is honoured only for a colour
      transition. If an animation is ever added, that media query must cover it.
- [ ] Nothing renders the stub yet — the adapter (006) will call it, and that is blocked on S4.
- [ ] Unverified whether LinkedIn's feed uses `role="feed"`. If it does, injecting a non-article
      child may break the feed's own semantics for screen readers. Check during S4.
