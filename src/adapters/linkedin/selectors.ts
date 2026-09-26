/**
 * LinkedIn selector profiles — the bundled fallback set (ADR-023).
 *
 * PROVENANCE: the `modern` profile is now VERIFIED against a live logged-in feed by spike S4 on
 * 2026-09-26 (raw output in docs/features/006-linkedin-adapter/s4-results.json). Hit rates are
 * noted per field. The `legacy` profile remains UNVERIFIED candidates — that account was served
 * the modern feed, so nothing exercised the Ember path.
 *
 * Three of the original research candidates scored 0% and are kept below as explicit
 * anti-selectors, because they came from four independent projects and someone will otherwise
 * reintroduce them:
 *   div[componentkey^="expandedFeedType_"]  — componentkey is `expanded<id>FeedType_<VARIANT>`,
 *                                             with an opaque 43-char id in the middle
 *   div[componentkey="post-inner-key"]      — no such key exists on this build
 *   p[componentkey="body-key"]              — likewise
 *
 * TWO RULES, both learned the hard way by other projects:
 *
 * 1. **No class-name selectors on the modern feed.** Every class is an 8-hex-digit CSS-modules
 *    build hash (`_1d9c1239`) that changes on every LinkedIn deploy. Attributes only. One
 *    prior-art project hardcoded `.KGgIHqzHPPknyAatueAITVWiujbQjSvZMsjyU` and broke immediately.
 *
 * 2. **Ordered arrays, not single strings.** Each field is a fallback chain tried in order, so a
 *    partial LinkedIn change degrades one field instead of breaking the adapter.
 */

import type { SelectorConfig } from '../types'

export const BUNDLED_SELECTORS: SelectorConfig = {
  version: 'bundled-2026.09.26',
  updatedAt: '2026-09-26',
  profiles: [
    {
      // Modern React/SDUI feed. Designed for first — it is strictly the harder of the two, and
      // both are live simultaneously (today's AdGuard build still ships rules for both).
      name: 'modern',
      detect: 'body[data-rehydrated], [data-testid="mainFeed"]',
      // S4: 1 match. Verified.
      feedRoot: ['[data-testid="mainFeed"]', 'main [role="list"]', 'main'],
      // S4: `div[componentkey*="FeedType_MAIN_FEED"]` gave 27 raw -> 8 after dropping nested,
      // 8/8 looking like posts. `[role="listitem"]` gave 11 raw of which 8 were posts, so it
      // needs filtering and is the weaker fallback.
      post: [
        'div[componentkey*="FeedType_MAIN_FEED"]',
        'div[componentkey*="FeedType_"]',
        '[role="listitem"]',
      ],
      // No inner content wrapper exists on this build — the post root IS the container.
      postContent: [],
      // S4: 75% (6/8). The two misses are company posts, covered by the authorLink chain.
      authorName: [
        'a[href*="/in/"] span[aria-hidden="true"]',
        'a[href*="/company/"] span[aria-hidden="true"]',
        'a[href*="/in/"]',
        'a[href*="/company/"]',
      ],
      // S4: /in/ 75%, /company/ 38%. Together they cover the feed.
      //
      // ORDER IS LOAD-BEARING. A "X commented on this" card contains the commenter's profile
      // link BEFORE the author's, so taking the first /in/ link attributes the post to the wrong
      // person — and the leaderboard aggregates on exactly this value. The `View …'s profile`
      // labelled link belongs to the post's own actor block, so it is tried first.
      authorLink: [
        'a[aria-label^="View "][href*="/in/"]',
        'a[aria-label^="View "][href*="/company/"]',
        'a[href*="/in/"]',
        'a[href*="/company/"]',
      ],
      // S4: 100% (8/8). The single most reliable selector on the whole page.
      bodyText: ['[data-testid="expandable-text-box"]'],
      // "Alice and 12 others like this" is not post content and would pollute every model input.
      excludeFromBody: [
        '[componentkey="social-proof-bar-key"]',
        '[componentkey="social-actions-key"]',
        '[data-testid="comments-container"]',
      ],
      // The "Igor Šlat commented on this" banner above a post. Excluded from author extraction
      // because the person named there is NOT the author, and from body text for the same
      // reason it pollutes the model input.
      socialContext: [
        '[componentkey="social-proof-bar-key"]',
        '[data-testid="social-context"]',
        '[componentkey*="socialContext"]',
      ],
      // S4: 88% (7/8), label "… more". The precise testid was learned from a console warning
      // LinkedIn emits about its own markup — they set aria-hidden="true" on this button while
      // leaving it focusable, which is their bug, not ours. Useful to us either way: it is the
      // exact node that must be stripped from extracted text.
      seeMoreToggle: [
        '[data-testid="expandable-text-button"]',
        '[data-testid="expandable-text-box"] button',
        'button[aria-label*="more" i]',
      ],
      // S4: a bare `img` hit 8/8 but that includes avatars and reaction icons, so it is useless
      // as a "has media" signal. Scoped to the CDN path instead — UNVERIFIED, because no post in
      // the sample had an attached image.
      media: ['img[src*="media.licdn.com"]', 'video'],
      // DISPROVEN, not merely untested. Captured markup from a live Datadog ad (2026-09-26)
      // contains NONE of these: its componentkeys are opaque UUIDs
      // (`4f2424c1-c53e-4c8f-9c63-172e339627d9`), and there is no data-sponsored-tracking-url,
      // no data-view-tracking-scope and no data-is-sponsored anywhere in the subtree.
      //
      // On this build the standalone "Promoted" text label is the ONLY signal. These are kept
      // because LinkedIn ships two feeds and filter-list maintainers still carry rules for them,
      // so they may match elsewhere — but nothing here should be relied on.
      sponsored: [
        '[componentkey="sponsored-indicator-key"]',
        '[data-sponsored-tracking-url]',
        '[data-view-tracking-scope*="SPONSORED"]',
      ],
      // S4: 0/8. No post permalink is rendered in the feed at all, so the `permalink` identity
      // strategy is unavailable on this build without opening each post's control menu.
      permalink: ['a[href*="/feed/update/"]'],
    },
    {
      // Legacy Ember feed. Semantic class names are fine HERE and only here.
      name: 'legacy',
      detect: 'body.ember-application, .feed-shared-update-v2',
      feedRoot: ['.scaffold-finite-scroll__content', 'main'],
      post: ['.feed-shared-update-v2', 'div[data-urn^="urn:li:activity"]', 'div[data-id^="urn:li:activity"]'],
      postContent: ['.feed-shared-update-v2__description-wrapper'],
      authorName: ['.update-components-actor__title', '.feed-shared-actor__name'],
      authorLink: ['.update-components-actor__meta-link', 'a.app-aware-link[href*="/in/"]'],
      bodyText: ['.update-components-text', '.feed-shared-update-v2__description'],
      excludeFromBody: ['.social-details-social-counts', '.comments-comments-list'],
      socialContext: ['.update-components-header', '.feed-shared-header'],
      seeMoreToggle: ['.feed-shared-inline-show-more-text__see-more-less-toggle'],
      media: ['.update-components-image img', 'video'],
      sponsored: ['.update-components-actor__sub-description'],
      permalink: ['a[href*="/feed/update/"]'],
    },
  ],
}

/**
 * Multilingual "Promoted" labels.
 *
 * Structural markers alone miss cases and the shipped filter lists still need both, so this is
 * combined with the `sponsored` selectors rather than replacing them. Taken from `deslopmyfeed`,
 * the only surveyed project that handled non-English labels at all — everything else quietly
 * fails outside English.
 */
export const PROMOTED_LABELS: readonly string[] = [
  'Promoted',
  'Anuncio',
  'Publicidad',
  'Sponsorisé',
  'Anzeige',
  'Gesponsert',
  'Sponsorizzato',
  'Patrocinado',
  'Gesponsord',
  'Sponsrad',
  'Sponsoreret',
  'Sponsoroitu',
  'Продвигается',
  'プロモーション',
  '광고',
  '推广',
  'Dipromosikan',
  'Disponsori',
  'โปรโมท',
  'Được quảng cáo',
]

/** First selector in the chain that matches. Returns null rather than throwing on a bad selector. */
export function queryFirst(root: ParentNode, chain: readonly string[]): Element | null {
  for (const sel of chain) {
    try {
      const found = root.querySelector(sel)
      if (found) return found
    } catch {
      // An invalid selector is a config bug, not a page problem. Skip it and try the next —
      // a remotely-updated config must never be able to throw the adapter into a broken state.
    }
  }
  return null
}

/** All matches from the first selector in the chain that matches anything. */
export function queryAll(root: ParentNode, chain: readonly string[]): Element[] {
  for (const sel of chain) {
    try {
      const found = root.querySelectorAll(sel)
      if (found.length > 0) return [...found]
    } catch {
      // See queryFirst.
    }
  }
  return []
}

/**
 * UNION of every selector in the chain, deduplicated, in document order.
 *
 * Different from `queryAll`, and the difference matters. `queryAll` is first-selector-wins,
 * which is right for a FIELD — you want the best available selector for one value. It is wrong
 * for finding POSTS: if ordinary posts match an early selector and sponsored posts only match a
 * later one, first-wins returns the ordinary posts and the ads become invisible. That is a
 * silent, total failure for a whole category of post.
 *
 * The cost of a union is false positives, which the caller filters structurally.
 */
export function queryUnion(root: ParentNode, chain: readonly string[]): Element[] {
  const seen = new Set<Element>()
  for (const sel of chain) {
    try {
      for (const el of root.querySelectorAll(sel)) seen.add(el)
    } catch {
      // Invalid selector from a remote config — skip it, never break the scan.
    }
  }
  return [...seen]
}
