/**
 * The `SiteAdapter` seam.
 *
 * Adding Reddit should be a new directory under `src/adapters/`, not a refactor. Everything
 * site-specific — selectors, identity derivation, DOM quirks — lives behind this interface and
 * nowhere else. `tests/invariants.test.ts` enforces that no LinkedIn selector appears outside
 * `src/adapters/`.
 */

import type { Post } from '../core/types'

/**
 * Health of the selector set against the live page.
 *
 * This exists because of a specific failure mode: the extension hides nothing without a model
 * (ADR-005), so **a broken selector and a missing model look identical to the user** — in both
 * cases nothing happens. Prior art hit this repeatedly. The adapter must be able to say "I found
 * the feed but matched zero posts", which is a very different problem from "no model".
 */
export type AdapterHealth =
  | { status: 'ok'; postsFound: number; profile: string }
  /** Feed root found, no posts matched. Almost always selector rot after a LinkedIn deploy. */
  | { status: 'stale_selectors'; profile: string }
  /** Feed root not found. Either not a feed page, or the page has not finished rendering. */
  | { status: 'no_feed_root' }

export interface ExtractResult {
  post: Post
  /**
   * The post is mounted but LinkedIn has not filled it yet — feed rows are created as empty slots
   * and populated later. Do NOT classify these; re-evaluate on a later mutation.
   *
   * This extends the fail-open rule: no model means hide nothing, and no text means do not triage
   * yet.
   */
  pending: boolean
}

export interface SiteAdapter {
  /** Stable id, used in `Post.site` and to select the adapter. */
  readonly site: string

  matches(url: string): boolean

  /**
   * Which DOM variant is live. LinkedIn is mid-migration between an Ember feed and a React/SDUI
   * one, both in production simultaneously, so this is not hypothetical.
   */
  detectProfile(root: Document): string

  findFeedRoot(root: Document): Element | null

  findPosts(feedRoot: Element): Element[]

  extract(el: Element): ExtractResult | null

  /**
   * Stable identity for a post.
   *
   * Separate from `extract` because it is the hardest unsolved problem in the adapter: the modern
   * React feed exposes no post URN at all, so identity must be derived. Keeping it separate means
   * the derivation strategy can change without touching extraction. See spike S4.
   */
  postId(el: Element, extracted: { authorUrn: string; text: string }): string | null

  /**
   * Replace the post's content with a collapsed stub.
   *
   * Takes `authorName` rather than re-deriving it. An earlier version re-read the author from the
   * DOM here, which was both redundant — `extract()` had already found it — and fragile: when the
   * re-read came up empty the stub rendered "this author" for a post whose author we knew
   * perfectly well. Whatever `extract()` produced is the single source of truth.
   *
   * Must NOT `display: none` the row. LinkedIn's infinite scroll is driven by an
   * IntersectionObserver sentinel, and removing rows from the flow starves it — the feed simply
   * stops loading. Two independent prior-art projects documented hitting this. Collapse height or
   * replace inner content instead.
   */
  mountStub(
    el: Element,
    options: { label: string; authorName: string; onExpand: () => void },
  ): void

  /** Restore a collapsed post. Must be safe to call on a post that was never collapsed. */
  unmountStub(el: Element): void

  health(root: Document): AdapterHealth
}

/**
 * Selector sets are data, loaded from a config that can be updated without a store release
 * (ADR-023). LinkedIn's modern feed uses 8-hex build-hash class names that change every deploy,
 * and a comparable maintained project sees a selector-affecting fix every 1-3 weeks.
 *
 * Data only — no expressions, no callbacks. That is both what keeps a remote config on the right
 * side of the remote-hosted-code rule and what makes it safe to apply without review.
 */
export interface SelectorProfile {
  /** Profile name, e.g. 'modern' | 'legacy'. */
  name: string
  /** Truthy selector identifying that this profile is the live one. */
  detect: string
  feedRoot: string[]
  post: string[]
  postContent: string[]
  authorName: string[]
  authorLink: string[]
  bodyText: string[]
  /** Excluded from body extraction — "Alice likes this" would otherwise pollute model input. */
  excludeFromBody: string[]
  seeMoreToggle: string[]
  media: string[]
  sponsored: string[]
  permalink: string[]
}

export interface SelectorConfig {
  version: string
  updatedAt: string
  profiles: SelectorProfile[]
}
