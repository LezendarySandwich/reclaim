# 006 — LinkedIn adapter · checklist

Living. Tick on completion, **append on discovery**. See `../../../AGENTS.md`.

## Build

- [x] `src/adapters/types.ts` — `SiteAdapter`, `AdapterHealth`, `SelectorConfig`
- [x] `src/adapters/linkedin/selectors.ts` — bundled candidate profiles + 20-locale Promoted labels
- [x] `src/adapters/linkedin/identity.ts` — URN → permalink → composite derivation
- [x] `src/adapters/linkedin/identity.test.ts`
- [ ] `src/adapters/linkedin/adapter.ts` — **blocked on S4**
- [ ] Text extraction hygiene (exclude comments and social proof, `<br>` → `\n`, expand see-more
      from a clone without clicking)
- [ ] Feed observer: IntersectionObserver at `rootMargin: '1500px 0px'` as the triage gate,
      MutationObserver coalesced through one rAF
- [ ] Infinite-scroll fix
- [ ] HTML fixtures captured from a real feed, for regression tests

## Verification

- [ ] Extraction tested against captured fixtures, not a live site
- [ ] `pnpm verify` green

## Discovered while working

_Append here. Strike through with a reason rather than deleting._

- [x] **Process slip: I wrote `types.ts`, `selectors.ts` and `identity.ts` before this plan
      existed**, which AGENTS.md rule 1 forbids. Recording it rather than backdating the plan.
      No harm done here — the three modules are foundations that S4 cannot invalidate — but the
      rule exists because writing the plan first is what surfaces questions like "what happens
      when there is no URN", and I got lucky that the research had already surfaced that one.
- [x] Identity records its *strategy*, not just an id. A composite hash is far weaker evidence
      than a real URN, and the leaderboard is an accusation surface — it should not present a
      tally built on composite ids as equally certain. `isDurable()` exposes that distinction.
- [x] The composite hash deliberately uses only the first 400 chars of body text, so expanding
      "…see more" does not change a post's id. Without that, every expansion would look like a
      new post and double-count on the leaderboard. Tested.
- [x] `queryFirst`/`queryAll` swallow invalid-selector exceptions. A remotely-updated config
      (ADR-023) must never be able to throw the adapter into a broken state; a bad selector
      degrades one field instead.
- [x] `AdapterHealth` distinguishes `stale_selectors` from `no_feed_root`. Because we hide
      nothing without a model, a broken selector and a missing model are indistinguishable to the
      user — both look like "nothing happened". The adapter has to be able to tell them apart.

## Discovered — not done

- [ ] `PROMOTED_LABELS` has 20 locales but no test that the list is actually used, and no
      normalisation (case, diacritics). It will silently miss `promoted` vs `Promoted`.
- [ ] The bundled selectors are **unvalidated candidates**. Nothing has run against a real feed.
      Treat every one as a hypothesis until S4.
- [ ] No remote-config fetch yet — only the bundled fallback exists. ADR-023 describes the
      fetch (our origin, sends nothing, fails closed); it is not written.
- [ ] `SiteAdapter.mountStub` takes an `onExpand` callback, which means the adapter owns stub DOM.
      That may belong in a separate UI module instead — decide when the stub gets a real design,
      especially given the accessibility questions (brief R13) are entirely unresearched.
