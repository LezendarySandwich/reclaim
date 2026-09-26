# 006 — LinkedIn adapter · checklist

Living. Tick on completion, **append on discovery**. See `../../../AGENTS.md`.

## Build

- [x] `src/adapters/types.ts` — `SiteAdapter`, `AdapterHealth`, `SelectorConfig`
- [x] `src/adapters/linkedin/selectors.ts` — bundled candidate profiles + 20-locale Promoted labels
- [x] `src/adapters/linkedin/identity.ts` — URN → permalink → composite derivation
- [x] `src/adapters/linkedin/identity.test.ts`
- [x] `src/adapters/linkedin/adapter.ts` — built against verified selectors
- [x] Text extraction hygiene — social proof and comments excluded, the "… more" toggle stripped,
      `<br>` → `\n`, all on a CLONE so the live page is never mutated (asserted)
- [x] Feed observer (`src/content/watcher.ts`): IntersectionObserver at `rootMargin: '1500px 0px'`
      as the triage gate, MutationObserver coalesced through one rAF, state keyed by post id
- [x] Infinite-scroll safety — the stub never sets `display:none` on the row, so LinkedIn's
      IntersectionObserver sentinel keeps firing. Not yet verified on a live feed.
- [ ] HTML fixtures captured from a real feed, for regression tests

## Verification

- [x] Selectors validated against a live feed by S4 (2026-09-26)
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

## S4 results — 2026-09-26

Raw output in `s4-results.json`. Account is on the **modern React/SDUI feed**
(`body[data-rehydrated]`, `[data-testid="mainFeed"]`, no Ember). 8 posts sampled.

**Three of my candidate selectors scored 0% and were wrong:**

| Candidate | Why it failed |
|---|---|
| `div[componentkey^="expandedFeedType_"]` | The key is `expanded` + **43-char opaque id** + `FeedType_<VARIANT>`. I assumed the two parts were adjacent. |
| `div[componentkey="post-inner-key"]` | No such key on this build |
| `p[componentkey="body-key"]` | Likewise |

**What actually works:**

| Field | Selector | Hit rate |
|---|---|---|
| Feed root | `[data-testid="mainFeed"]` | 1 match |
| Post | `div[componentkey*="FeedType_MAIN_FEED"]` | 8/8 after dropping nested |
| Body text | `[data-testid="expandable-text-box"]` | **100%** |
| See-more | `[data-testid="expandable-text-box"] button` | 88% ("… more") |
| Author name | `a[href*="/in/"] span[aria-hidden="true"]` | 75% — misses company posts |
| Author link | `a[href*="/in/"]` + `a[href*="/company/"]` | 75% + 38% |
| Control menu | `button[aria-label*="control menu" i]` | 100% |

**Identity is solved, better than expected.** No `data-urn`, no `data-id`, no permalink anywhere
(0/8 on all of them) — but `componentkey` is on 8/8 post roots and **unique per post**:
`expanded7cdbt_jwDmDtd5s0G2glmqfjUhVmI_JvbKvFl2n10wQFeedType_MAIN_FEED_RELEVANCE`. Added a
`componentkey` strategy ranked above composite hashing, with a minimum-id-length guard so shared
template keys (`body-key`) cannot collide the way prior art's does.

- [ ] **Is the `componentkey` opaque id stable ACROSS RELOADS?** Unverified, and it matters: if it
      is per-render, cross-session history silently fragments and every post looks new on every
      visit. Cheap to check — reload the feed and diff the ids for a post that is still there.

**Two fields could not be tested:**

- [ ] **Sponsored/promoted — 0/8 on every selector, and 0 by text match.** There were simply no
      promoted posts in the sample. UNTESTED, not disproven. Re-run on a feed that has ads.
- [ ] **No `<time>` element at all** (0/8 on `time[datetime]`, `time`, and the legacy class). The
      composite identity strategy uses a timestamp to disambiguate reposts of identical text, and
      on this build it will not have one. Find where the relative age ("2h") actually lives.

**The recycling verdict is NOT trustworthy.**

- [ ] It reported `STABLE: nodes persisted with their content`, but
      `scrollHeightBefore === scrollHeightAfterScroll === 780`. **The page never actually
      scrolled.** 780px is far too short for a real feed, which means LinkedIn's modern build
      scrolls an inner container rather than `document.documentElement`, and the audit scrolled
      the wrong element. So we still do not know whether nodes get recycled.
      **Consequence for the adapter: do NOT key per-post state on the element.** Use the derived
      post id. That is correct under either answer, so this does not block `adapter.ts` — but the
      audit script needs fixing before the answer is worth having.
- [ ] Only 8 posts were in the DOM. Everything above is a small sample.


## Adapter build notes — 2026-09-26

- [x] `outermostOnly()` is what turns the post selector into a post list: S4 saw 27 raw matches
      for 8 real posts, the rest being inner components carrying the same key fragment.
- [x] Author URLs are normalised (query stripped, trailing slash removed) because the raw href
      carries `?trk=feed_and_more` tracking params that differ between renders — ungrouped, the
      leaderboard would count one person as several.
- [x] **State is keyed by post id, never by element.** S4's recycling test was invalid, so we do
      not know whether LinkedIn reuses nodes. The watcher also re-extracts before classifying and
      drops the entry if the node now holds a different post — correct under either answer.
- [x] Shared fixtures moved to `fixtures.ts` inside this directory. `tests/invariants.test.ts`
      caught the watcher test building LinkedIn-shaped DOM in a site-agnostic module, which is
      exactly the coupling that rule exists to prevent. Fixing the cause also removed a duplicated
      fixture across two test files.

## Discovered — not done

- [ ] `isRepost` is inferred from "more than one author link", which is a guess. S4 had no
      reposts in the sample. Untested and probably wrong for company posts with a mentioned person.
- [ ] Media detection is scoped to `media.licdn.com`, which is UNVERIFIED — no post in the S4
      sample had an attached image. A bare `img` matched 8/8 but that is avatars and reaction
      icons, so it is useless as a signal.
- [ ] The watcher never re-classifies. Once a post is `done` it stays done for the tab's lifetime,
      even if the model later becomes available. A post seen while `needs_setup` is therefore
      never revisited — needs an invalidation hook on engine-state change.
- [ ] No verdict cache read. `classifyBatch` produces a cache key and nothing consults it, so
      scrolling back over a post re-runs inference. Storage exists; the wire does not.
- [ ] Nothing persists verdicts or labels yet, so the dashboard has no data and the leaderboard
      cannot be built.
- [ ] `onFeedback` is wired through the watcher and called on expand, but the content script
      passes no handler, so feedback is silently dropped.
- [ ] The SPA retry is a fixed 20 × 500ms poll. Crude. LinkedIn client-side navigations away from
      and back to the feed are not handled at all — `webNavigation` is permissioned for exactly
      this and unused.
