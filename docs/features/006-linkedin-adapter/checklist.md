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

- [ ] **Is the `componentkey` opaque id stable ACROSS RELOADS?** Still unverified. Run 2 showed
      the id is consistent across the three elements *within* one page, which is a different
      question. Reload and diff for a post that is still present.

**Two fields could not be tested:**

- [ ] **Sponsored/promoted — 0/8 on every selector, and 0 by text match.** There were simply no
      promoted posts in the sample. UNTESTED, not disproven. Re-run on a feed that has ads.
- [ ] **No `<time>` element at all** (0/8 on `time[datetime]`, `time`, and the legacy class). The
      composite identity strategy uses a timestamp to disambiguate reposts of identical text, and
      on this build it will not have one. Find where the relative age ("2h") actually lives.

**The recycling verdict is NOT trustworthy.**

- [x] **ANSWERED in run 2: no recycling.** The fixed script scrolled the real container (`main`)
      by 3073px and reported `STABLE` with 0 detached and 0 recycled. `WeakMap<Element, state>`
      would in fact have been safe — but the watcher keys by post id anyway, which costs nothing
      and stays correct if LinkedIn changes this.
- [x] ~~It reported `STABLE`, but `scrollHeight` was identical before and after.~~ Fixed: the
      script now finds the overflowing ancestor, reports `scrollerDescription` and `scrolledBy`,
      and returns `INCONCLUSIVE` rather than `STABLE` when nothing moved.
      Original wording follows for the record:
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


## S4 run 2 — 2026-09-26 (fixed script)

Raw in `s4-results-run2.json`. Same account, modern feed, 3 posts in DOM.

**Recycling: ANSWERED.** Scroller was `main`, scrolled 3073px, verdict `STABLE` — 0 nodes
detached, 0 recycled. Keying state by post id was therefore not strictly necessary, but it is kept
because it costs nothing and survives LinkedIn changing its mind.

**A real bug surfaced, and not by the audit itself — by a one-line follow-up query.** Listing every
`componentkey` for a single post returned three elements with the SAME id under DIFFERENT prefixes:

```
expanded                                   <id>FeedType_MAIN_FEED_RELEVANCE
update-card-focus                          <id>FeedType_MAIN_FEED_RELEVANCE
CgsIgIDXtN7e+LTQAQ-replaceableCommentTools <id>FeedType_MAIN_FEED_RELEVANCE
```

The regex was anchored on `^expanded`, so the same post got a different identity — or none —
depending on which element it was handed. Silent double-counting on the leaderboard. Fixed by
matching the 43-character base64url id regardless of prefix; verified to produce one id across all
three prefixes and across three separately captured posts.

- [x] Test fixtures now use realistic 43-char ids. Several had invented 18-char ones that only
      passed against the looser regex and could never occur in the wild.
- [ ] **Still untested: sponsored detection.** Second run, second sample with no promoted posts
      (`promotedByText: 0`). Needs a feed with ads.
- [ ] Only 3 posts in the DOM this run, 8 last time. Both are small samples.

## Sponsored filtering — 2026-09-26

- [x] **`isPromoted` was extracted and never used.** It had been in `Post` since the adapter was
      written and nothing converted it into a signal, so the sponsored axis could not have fired
      even when switched on. Dead data that looked like a working feature.
- [x] **Promoted detection was a substring match** — `textContent.includes('Promoted')` — which
      would have hidden *"I was promoted to Senior Engineer"*. Now requires the label to be a line
      of its own in the first eight lines, matched exactly and case-insensitively. Three tests.
- [x] The watcher now always classifies a promoted post even when the router says `clean`. Ad copy
      is frequently well written and routes clean; the sponsored axis decides on the page's label
      rather than the prose, so skipping would have meant never hiding a well-written advert.
- [x] Sponsored hides with no model (ADR-026), via narrow `METADATA_DECIDES` / `NEEDS_NO_ENGINE`
      sets in `verdict.ts`.

- [ ] **Still never tested against a real ad.** Both S4 runs had zero promoted posts, so every
      structural selector (`[componentkey="sponsored-indicator-key"]`,
      `[data-sponsored-tracking-url]`, `[data-view-tracking-scope*="SPONSORED"]`) remains
      unverified. Only the text-label path has evidence behind it, and that evidence is two posts
      pasted into a chat rather than captured markup.
- [ ] The 20-locale label list is untested beyond German. If LinkedIn renders the label with
      surrounding punctuation or a bullet separator in some locales, exact line matching misses it.

## Author misattribution on social-context cards — 2026-09-26

Reported from a live feed: a post by Felix Werner, surfaced because Ivan Slater had commented on
it, was attributed to **Ivan**.

**This is the worst class of bug in this product.** `authorUrn` is the leaderboard's grouping
key, so it did not merely mislabel a stub — it credited one person's posting habits to another,
on a surface whose whole purpose is to say "this person posts a lot of slop".

- [x] Cause: `readAuthor` took the FIRST `a[href*="/in/"]` in the post, and on a
      "X commented on this" card the commenter's link precedes the author's in document order.
- [x] Fix, in three layers because the exact markup is unverified:
      1. Prefer `a[aria-label^="View "]` — the author's own actor-block link.
      2. Skip any candidate inside a `socialContext` block.
      3. Fall back to a text check on the nearest few ancestors for
         "commented / likes this / reposted / follows", bounded to blocks under 120 characters
         so a post that merely discusses commenting is not mistaken for a banner.
- [x] Author name now prefers the `View X’s profile` aria-label, which is cleaner than the link
      text (that often carries a degree badge or job title).
- [x] Five tests, including the "post that talks about commenting" case.

- [ ] **The markup is reconstructed, not captured.** The fixture was rebuilt from the rendered
      text of the reported post, so the `social-proof-bar-key` selector and the exact aria-label
      format are inferred. Worth capturing a real one.
- [ ] Reposts are the untested sibling case: a repost has the reposter AND the original author,
      and which one should own the post is a product question nobody has answered.
- [ ] Any leaderboard rows already written under a wrong author are still wrong. There is no
      migration, and the 90-day retention will eventually age them out.

## Ads still not hiding, and two scheduling questions — 2026-09-26

- [x] **`queryAll` is first-selector-wins, and that silently hid a whole category of post.**
      The post chain is `FeedType_MAIN_FEED` → `FeedType_` → `[role="listitem"]`. If ordinary
      posts match the first selector and sponsored posts only match a later one, first-wins
      returns the ordinary posts and **every ad is invisible to the entire pipeline** — never
      extracted, never classified, never hideable. Demonstrated in a fixture.
      `findPosts` now takes the UNION of the chain and filters structurally with `looksLikePost`
      (has an author link, or a body container, or is a lazy-mount slot). Filtering on structure
      is more honest than relying on selector precedence anyway.
      `queryAll`/`queryFirst` keep first-wins, which is correct for a FIELD — there you do want
      the best available selector for one value.

## A promoted post still not hiding — a race, not a selector — 2026-09-26

Reported with the full captured DOM of a Redpanda ad. The adapter turned out to be innocent:
run against that exact markup it returns `isPromoted: true`, author `Redpanda Data`, correct
body text. Three earlier fixes had aimed at the selectors because the symptom looked like one.

- [x] **`done` was terminal, and it was being set mid-hydration.** LinkedIn's SDUI feed paints a
      card in pieces and the body text can land before the actor block carrying "Promoted". In
      that window the card is already a recognisable post, so the router clears it — permanently.
      The label arriving a frame later was never seen. This is why *some* ads hid and others did
      not, and why it resisted selector fixes. `done` now carries a fingerprint of the evidence
      it was resolved on and reopens when that changes (ADR-027).
- [x] Reopening is asymmetric: gaining the label or gaining text reopens, losing either does not.
      A re-render must not be able to relitigate a post the user has already been shown.
- [x] Reopening is capped at three per post, so a pathologically mutating page cannot spin.
- [x] Re-extraction is free — `#scan` already called `extract()` on every post on every scan and
      threw the result away at the state check.
- [x] Captured the ad verbatim as `followedPageAdHtml`. New shape: a *person's* "follows this
      page" banner wrapping a *company's* promoted post, so the first `/in/` link belongs to
      someone who did not write it. Author attribution resolves to the company; a test pins it.
- [x] **Ads carry `FeedType_MAIN_FEED_RELEVANCE`, the same FeedType as organic posts.** This
      closes the open question from the previous round and kills the idea of routing on FeedType.
- [x] Corrected ADR-026, which described the line-split promoted check as shipped. It was tried
      and disproven; element scanning is what ships. The code comment was right, the ADR was not.

### Found while here

- [x] **The watcher suite was ~5% flaky per test, by construction.** Audit sampling defaults to
      5% against real `Math.random()`, and no test pinned it, so every "a clean post is not sent
      to the model" assertion failed one run in twenty. Caught when an unrelated stashed run
      failed a test I had not touched. All constructions now set `auditRate` explicitly.
- [ ] The reopen path is unit-tested but has never run against the live feed. The thing to watch
      for is an ad that hides only after a visible delay — that would mean the label lands after
      the post is already on screen, and the stub appears under the reader's eye rather than
      before it.
- [ ] `#resolvedOn` and `#reopens` grow with the number of posts seen in a session and are never
      pruned. Two small strings per post, so it is unlikely to matter in a session-length feed,
      but it is unbounded and nothing measures it.

## An image advert that could never hide — 2026-09-26

Third report in a row, third distinct root cause. This one was not a race: the ad was
unhideable on every scan, unconditionally.

- [x] **`pending` conflated "little text" with "not rendered".** The ad's whole body is one
      emoji, so `text.length < MIN_READY_CHARS` made it look like an unpopulated lazy-mount
      slot and the watcher skipped it forever. `pending` now means the row rendered *nothing* —
      no text, no media, no author, no label.
- [x] Safe because the router clears text-light posts: two characters cannot reach `MIN_WORDS`,
      so only a structural advert signal can hide them. A human photo post with a
      two-character caption is pinned as a control, asserting **not hidden** rather than
      **not classified**.
- [x] `/showcase/` was in neither author chain. Advertisers post from showcase pages.
- [x] The author-name lookup took the first matching element even with no text, so the logo
      anchor (an `<a>` wrapping only an `<img>`) won and every company/showcase post fell back
      to the slug — "Aws Developers" for AWS Developers.
- [x] Added `img[alt="View Sponsored Content"]`, LinkedIn's own accessible name for an ad
      creative. A second structural signal that does not wait for the label to hydrate.
- [x] Closed a gap the fix opened: a card routed on empty text now reopens when text appears at
      all, not only when it grows past the 40-character threshold.

### Found while here

- [x] A pre-existing test named "flags an unfilled lazy-mounted row as pending" did not test
      that — its fixture had a full actor block and an empty body, which is a rendered card.
      Corrected, and a genuinely empty slot now has its own test.
- [ ] **Text-light posts now each cost one inference.** Posts under `MIN_WORDS` route to
      `ambiguous` by design, and they were previously excluded by the `pending` gate. In an
      image-heavy feed this is a real increase in model calls for posts with nothing to judge.
      Triage policy was left alone deliberately — it is calibrated and documented — but a
      short-circuit for, say, fewer than three words is worth measuring.
- [ ] `slugToName` silently produces wrong capitalisation for acronym brands. It is a last
      resort and now reached far less often, but it is still wrong when reached.
