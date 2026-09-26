/**
 * LinkedIn selector profiles — the bundled fallback set (ADR-023).
 *
 * PROVENANCE: these are CANDIDATES from the research pass, converged on by four independent
 * open-source projects (see docs/architecture/technical-brief-addendum.md §3). They have NOT been
 * validated against a live logged-in feed. Spike S4 does that, and its results should replace
 * anything here that turns out to be wrong.
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
      feedRoot: ['[data-testid="mainFeed"]', 'main [role="feed"]', 'main'],
      post: [
        'div[componentkey^="expandedFeedType_"][role="listitem"]',
        'div[componentkey^="urn:li:activity"]',
        '[role="listitem"]',
      ],
      postContent: ['div[componentkey="post-inner-key"]'],
      authorName: ['[componentkey="author-name-key"]', '[data-testid="post-author-name"]'],
      authorLink: ['a[href*="/in/"]', 'a[href*="/company/"]'],
      bodyText: ['[data-testid="expandable-text-box"]', '[componentkey="body-key"]'],
      // "Alice and 12 others like this" is not post content and would pollute every model input.
      excludeFromBody: [
        '[componentkey="social-proof-bar-key"]',
        '[componentkey="social-actions-key"]',
        '[data-testid="comments-container"]',
      ],
      seeMoreToggle: ['button[aria-label*="more"]', '.see-more', '[data-testid="see-more"]'],
      media: ['img[src*="media.licdn.com"]', 'video'],
      sponsored: [
        '[componentkey="sponsored-indicator-key"]',
        '[data-sponsored-tracking-url]',
        '[data-view-tracking-scope*="SPONSORED"]',
      ],
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
