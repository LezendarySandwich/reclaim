/**
 * The LinkedIn `SiteAdapter`.
 *
 * Every LinkedIn-specific assumption in the codebase lives here or in the two modules beside it.
 * Selectors are verified against a live feed by spike S4 (2026-09-26) — see
 * `docs/features/006-linkedin-adapter/checklist.md` for hit rates and for what could not be
 * tested.
 */

import { deriveIdentity } from './identity'
import { BUNDLED_SELECTORS, PROMOTED_LABELS, queryAll, queryFirst } from './selectors'
import { hasStub, mountStub, unmountStub } from '../../ui/stub'
import type { AdapterHealth, ExtractResult, SelectorProfile, SiteAdapter } from '../types'
import type { MediaRef, Post } from '../../core/types'

const SITE = 'linkedin'

/** Marks a post we have already handled. Written to the element purely as a fast pre-filter. */
const SEEN_ATTR = 'data-reclaim-id'

/**
 * Below this many characters we treat a post as not yet filled.
 *
 * LinkedIn mounts feed rows as empty slots (`data-lazy-mount-id`) and populates them later, so a
 * post container can legitimately exist with no content. Classifying those would feed the model
 * blanks; the observer re-evaluates on the next mutation instead.
 */
const MIN_READY_CHARS = 8

function profileFor(root: Document): SelectorProfile | null {
  for (const profile of BUNDLED_SELECTORS.profiles) {
    try {
      if (root.querySelector(profile.detect)) return profile
    } catch {
      // A malformed detect selector from a remote config must not break detection for the rest.
    }
  }
  return null
}

/**
 * Drop matches that are nested inside other matches.
 *
 * S4: `div[componentkey*="FeedType_MAIN_FEED"]` returns 27 raw elements but only 8 posts — the
 * rest are inner components carrying the same key fragment. Keeping only the outermost is what
 * turns the selector into a post list.
 */
function outermostOnly(elements: Element[]): Element[] {
  return elements.filter((el) => !elements.some((other) => other !== el && other.contains(el)))
}

/**
 * Read post text without the furniture.
 *
 * Three things must be excluded or the model is fed noise:
 *  - social proof ("Alice and 12 others like this")
 *  - the comment list
 *  - the "… more" toggle, which `textContent` would otherwise append to every truncated post
 *
 * Done on a CLONE so the live page is never mutated — this extension reads, it does not rewrite.
 */
function readText(postEl: Element, profile: SelectorProfile): string {
  const source = queryFirst(postEl, profile.bodyText)
  if (!source) return ''

  const clone = source.cloneNode(true) as Element

  for (const sel of [...profile.excludeFromBody, ...profile.seeMoreToggle, 'button']) {
    try {
      for (const node of clone.querySelectorAll(sel)) node.remove()
    } catch {
      // Bad selector in config — skip it rather than losing the whole extraction.
    }
  }

  // `<br>` carries real structure on LinkedIn: the one-line-per-sentence "broetry" shape is a
  // signal the triage router reads, and textContent would collapse it away.
  for (const br of clone.querySelectorAll('br')) br.replaceWith('\n')

  return (clone.textContent ?? '').replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim()
}

function readAuthor(postEl: Element, profile: SelectorProfile): { name: string; urn: string } {
  const link = queryFirst(postEl, profile.authorLink) as HTMLAnchorElement | null
  const nameEl = queryFirst(postEl, profile.authorName)

  const href = link?.getAttribute('href') ?? ''
  // Strip query and trailing slash so the same author is one identity across feed renders,
  // which matters because this is the leaderboard's grouping key.
  const urn = href
    ? href.split('?')[0]!.replace(/\/+$/u, '')
    : ''

  const fromNode = (nameEl?.textContent ?? '').trim() || (link?.textContent ?? '').trim()

  return {
    // Last resort: derive a readable name from the profile slug. LinkedIn's name markup varies
    // (company posts, promoted posts, some locales), and a stub reading "this author" when the
    // href plainly says /in/alice-smith is worse than an imperfect guess.
    name: fromNode || slugToName(urn),
    urn: urn || 'unknown',
  }
}

/** `/in/alice-smith-1a2b3c` -> `Alice Smith`. Trailing id-ish segments are dropped. */
function slugToName(urn: string): string {
  const slug = urn.split('/').filter(Boolean).pop()
  if (!slug) return ''
  return slug
    .split('-')
    .filter((part) => part.length > 0 && !/^[0-9a-f]{4,}$/iu.test(part))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function readMedia(postEl: Element, profile: SelectorProfile): MediaRef[] {
  return queryAll(postEl, profile.media).map((el) => ({
    kind: el.tagName === 'VIDEO' ? ('video' as const) : ('image' as const),
    url: el.getAttribute('src') ?? '',
  }))
}

function isPromoted(postEl: Element, profile: SelectorProfile): boolean {
  if (queryFirst(postEl, profile.sponsored)) return true
  // Structural markers alone miss cases, and every one of them scored 0/8 in S4 because the
  // sample had no ads — so the multilingual label check is not redundant belt-and-braces, it is
  // currently the only tested half.
  const head = (postEl.textContent ?? '').slice(0, 400)
  return PROMOTED_LABELS.some((label) => head.includes(label))
}

export class LinkedInAdapter implements SiteAdapter {
  readonly site = SITE

  #profile: SelectorProfile | null = null

  matches(url: string): boolean {
    try {
      const u = new URL(url)
      return u.hostname === 'www.linkedin.com' && u.pathname.startsWith('/feed')
    } catch {
      return false
    }
  }

  detectProfile(root: Document): string {
    this.#profile = profileFor(root)
    return this.#profile?.name ?? 'unknown'
  }

  findFeedRoot(root: Document): Element | null {
    const profile = this.#profile ?? profileFor(root)
    if (!profile) return null
    return queryFirst(root, profile.feedRoot)
  }

  findPosts(feedRoot: Element): Element[] {
    const profile = this.#profile
    if (!profile) return []
    return outermostOnly(queryAll(feedRoot, profile.post))
  }

  extract(el: Element): ExtractResult | null {
    const profile = this.#profile
    if (!profile) return null

    const text = readText(el, profile)
    const { name, urn } = readAuthor(el, profile)

    const identity = deriveIdentity({
      urnCandidates: [
        el.getAttribute('data-urn'),
        el.getAttribute('data-id'),
        el.getAttribute('data-activity-urn'),
      ],
      permalink: (queryFirst(el, profile.permalink) as HTMLAnchorElement | null)?.getAttribute('href'),
      // Post ROOT only. A descendant's componentkey is a shared template key and would collide
      // across every post on the page.
      componentKey: el.getAttribute('componentkey') ?? el.getAttribute('id'),
      authorUrn: urn,
      text,
    })

    if (!identity) return null

    const post: Post = {
      id: identity.id,
      authorUrn: urn,
      authorName: name,
      text,
      media: readMedia(el, profile),
      isPromoted: isPromoted(el, profile),
      // A repost has a second author link above the original. Weak, and untested by S4.
      isRepost: queryAll(el, profile.authorLink).length > 1,
      site: SITE,
    }

    return { post, pending: text.length < MIN_READY_CHARS }
  }

  /**
   * Identity for marking work already done.
   *
   * Returned separately from `extract` so callers can key state by POST ID rather than by
   * element. That matters because S4's node-recycling test was invalid — `scrollHeight` was
   * unchanged before and after, so the page never actually scrolled and we still do not know
   * whether LinkedIn reuses nodes. Keying on the id is correct under either answer; a
   * `WeakMap<Element, state>` would not be.
   */
  postId(el: Element, extracted: { authorUrn: string; text: string }): string | null {
    return (
      deriveIdentity({
        urnCandidates: [el.getAttribute('data-urn'), el.getAttribute('data-id')],
        componentKey: el.getAttribute('componentkey') ?? el.getAttribute('id'),
        authorUrn: extracted.authorUrn,
        text: extracted.text,
      })?.id ?? null
    )
  }

  mountStub(
    el: Element,
    options: { label: string; authorName: string; onExpand: () => void },
  ): void {
    if (!(el instanceof HTMLElement)) return
    mountStub(el, {
      label: options.label,
      authorName: options.authorName || 'this author',
      onExpand: options.onExpand,
    })
  }

  unmountStub(el: Element): void {
    if (el instanceof HTMLElement) unmountStub(el)
  }

  health(root: Document): AdapterHealth {
    const profile = this.#profile ?? profileFor(root)
    if (!profile) return { status: 'no_feed_root' }

    const feedRoot = queryFirst(root, profile.feedRoot)
    if (!feedRoot) return { status: 'no_feed_root' }

    const posts = outermostOnly(queryAll(feedRoot, profile.post))
    if (posts.length === 0) return { status: 'stale_selectors', profile: profile.name }

    return { status: 'ok', postsFound: posts.length, profile: profile.name }
  }
}

export { SEEN_ATTR, outermostOnly, readText, hasStub }
