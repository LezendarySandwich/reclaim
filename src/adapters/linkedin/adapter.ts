/**
 * The LinkedIn `SiteAdapter`.
 *
 * Every LinkedIn-specific assumption in the codebase lives here or in the two modules beside it.
 * Selectors are verified against a live feed by spike S4 (2026-09-26) — see
 * `docs/features/006-linkedin-adapter/checklist.md` for hit rates and for what could not be
 * tested.
 */

import { deriveIdentity } from './identity'
import { BUNDLED_SELECTORS, PROMOTED_LABELS, queryAll, queryFirst, queryUnion } from './selectors'
import { hasStub, mountStub, unmountStub } from '../../ui/stub'
import type { AdapterHealth, ExtractResult, SelectorProfile, SiteAdapter } from '../types'
import type { MediaRef, Post } from '../../core/types'

const SITE = 'linkedin'

/** Marks a post we have already handled. Written to the element purely as a fast pre-filter. */
const SEEN_ATTR = 'data-reclaim-id'

/**
 * Below this many characters, a post's text does not count as present.
 *
 * LinkedIn mounts feed rows as empty slots (`data-lazy-mount-id`) and populates them later, so a
 * post container can legitimately exist with no content. Classifying those would feed the model
 * blanks; the observer re-evaluates on the next mutation instead.
 *
 * This is a fact about the TEXT only. See `isPending` for why that is not the same as the post
 * not having rendered.
 */
const MIN_READY_CHARS = 8

/**
 * Has this row rendered at all?
 *
 * Text length alone is the wrong test, and getting that wrong hid nothing for a whole category of
 * advert. A reported AWS ad's entire body was a single emoji — two characters — carried by an
 * image. Judged on text it looks exactly like an unpopulated lazy-mount slot, so `pending` stayed
 * true and the watcher skipped it on every scan, forever. It was never a race: that ad could
 * never be hidden at all.
 *
 * A row has rendered if it has any of the four things a rendered row can have: body text, media,
 * an author, or a "Promoted" label. Only a row with none of them is still a hole.
 *
 * This deliberately lets text-light posts through to the router, which is safe because the router
 * clears them: a post with two characters cannot reach `MIN_WORDS`, so it bands `clean` and is
 * shown. The only thing that then hides it is a structural signal that needs no text at all —
 * which is precisely the advert case, and precisely ADR-026's carve-out.
 */
function isPending(post: Pick<Post, 'text' | 'media' | 'authorName' | 'isPromoted'>): boolean {
  if (post.text.length >= MIN_READY_CHARS) return false
  if (post.media.length > 0) return false
  if (post.authorName.length > 0) return false
  return !post.isPromoted
}

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

/** Text that marks a block as "someone in your network interacted with this", not post content. */
const SOCIAL_CONTEXT_TEXT =
  /\b(commented|likes this|liked this|reposted|shared this|follows|celebrates|reacted)\b/iu

/**
 * Is this node inside the "X commented on this" banner?
 *
 * Structural selectors for that banner are unverified on the modern feed, so this also falls back
 * to reading the text of the node's nearest few ancestors. Crude, but the failure it prevents —
 * attributing a post to the person who commented on it — is bad enough to be worth a heuristic.
 */
function inSocialContext(node: Element, postEl: Element, profile: SelectorProfile): boolean {
  for (const sel of profile.socialContext) {
    try {
      const banner = postEl.querySelector(sel)
      if (banner && banner !== node && banner.contains(node)) return true
    } catch {
      // Bad config selector — fall through to the text check.
    }
  }

  let ancestor: Element | null = node.parentElement
  for (let depth = 0; depth < 4 && ancestor && ancestor !== postEl; depth++) {
    const text = (ancestor.textContent ?? '').trim()
    // Only a SHORT block can be a social-context banner. A long one is the post itself, which
    // may legitimately contain the word "commented".
    if (text.length > 0 && text.length < 120 && SOCIAL_CONTEXT_TEXT.test(text)) return true
    ancestor = ancestor.parentElement
  }
  return false
}

function readAuthor(postEl: Element, profile: SelectorProfile): { name: string; urn: string } {
  // Take the first candidate that is NOT inside a social-context banner.
  //
  // On a "Ivan Slater commented on this" card the commenter's profile link comes first in document
  // order, so the previous first-match approach credited the post to them. That value is the
  // leaderboard's grouping key, so the bug did not merely mislabel a stub — it attributed
  // somebody else's posting habits to the wrong person.
  let link: HTMLAnchorElement | null = null
  for (const sel of profile.authorLink) {
    try {
      for (const candidate of postEl.querySelectorAll(sel)) {
        if (inSocialContext(candidate, postEl, profile)) continue
        link = candidate as HTMLAnchorElement
        break
      }
    } catch {
      // Invalid selector from a remote config; try the next.
    }
    if (link) break
  }

  let nameEl: Element | null = null
  for (const sel of profile.authorName) {
    try {
      for (const candidate of postEl.querySelectorAll(sel)) {
        if (inSocialContext(candidate, postEl, profile)) continue
        // Skip candidates with no text. An actor block opens with the logo link — an anchor to
        // the same profile wrapping only an <img> — and matching it first meant the real name a
        // few nodes later was never reached, silently demoting every company and showcase post
        // to the slug-derived fallback ("Aws Developers" for AWS Developers).
        if (!(candidate.textContent ?? '').trim()) continue
        nameEl = candidate
        break
      }
    } catch {
      // As above.
    }
    if (nameEl) break
  }

  const href = link?.getAttribute('href') ?? ''
  // Strip query and trailing slash so the same author is one identity across feed renders,
  // which matters because this is the leaderboard's grouping key.
  const urn = href
    ? href.split('?')[0]!.replace(/\/+$/u, '')
    : ''

  // An aria-label of the form "View Felix Werner's profile" names the author directly and is
  // more reliable than the link's own text, which often includes a degree badge or job title.
  const ariaName = link?.getAttribute('aria-label')?.match(/^View\s+(.+?)[’']?s?\s+profile$/iu)?.[1]

  const fromNode =
    (ariaName ?? '').trim() ||
    (nameEl?.textContent ?? '').trim() ||
    (link?.textContent ?? '').trim()

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

/**
 * Is this element actually a post?
 *
 * The union of post selectors pulls in siblings that share a `role="listitem"` — S4 saw 11 such
 * elements for 8 real posts. Filtering on structure rather than on selector precedence is both
 * more robust and more honest: a post is a thing with an author.
 *
 * Deliberately does NOT require text. Feed rows mount as empty slots and are filled later, and
 * those still need to be tracked so they can be re-evaluated once content arrives.
 */
function looksLikePost(el: Element, profile: SelectorProfile): boolean {
  if (queryFirst(el, profile.authorLink)) return true
  if (queryFirst(el, profile.bodyText)) return true
  // A lazily-mounted empty slot: no content yet, but it is a post-shaped hole.
  return el.hasAttribute('data-lazy-mount-id')
}

function readMedia(postEl: Element, profile: SelectorProfile): MediaRef[] {
  return queryAll(postEl, profile.media).map((el) => ({
    kind: el.tagName === 'VIDEO' ? ('video' as const) : ('image' as const),
    url: el.getAttribute('src') ?? '',
  }))
}

/**
 * Elements scanned for a standalone "Promoted" label. Bounded so a large post subtree cannot
 * turn this into a hot-path cost.
 */
const PROMOTED_SCAN_LIMIT = 60

function isPromoted(postEl: Element, profile: SelectorProfile): boolean {
  if (queryFirst(postEl, profile.sponsored)) return true

  // Scan ELEMENTS, not lines of text.
  //
  // Two wrong approaches preceded this, and captured markup from a live Datadog ad disproved
  // both. A substring check on textContent would fire on "I was promoted to Senior Engineer" —
  // among the commonest posts on LinkedIn, and hiding somebody's promotion as an advert is the
  // worst false positive this extension could produce. Splitting textContent on newlines was no
  // better: textContent concatenates text nodes with NO separators, so that same ad reads
  //
  //     "Datadog 587,644 followersPromoted"
  //
  // as a single line and matches nothing.
  //
  // What the ad actually contains is <p><span>Promoted</span></p> — an element whose entire text
  // is the label. That is both reliable and inherently safe against the promotion-announcement
  // case, because "I was promoted to Senior Engineer" is never an element's whole content.
  const candidates = postEl.querySelectorAll('span, p, li, h3, h4')
  const limit = Math.min(candidates.length, PROMOTED_SCAN_LIMIT)
  for (let i = 0; i < limit; i++) {
    const text = (candidates[i]?.textContent ?? '').trim()
    // Cheap length gate before the case-folding comparison — most elements are long prose.
    if (text.length === 0 || text.length > 24) continue
    const lower = text.toLowerCase()
    if (PROMOTED_LABELS.some((label) => lower === label.toLowerCase())) return true
  }
  return false
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
    // UNION, not first-selector-wins. Sponsored posts may carry a different `FeedType` from
    // ordinary ones, and first-wins would return only the ordinary ones — making every ad
    // invisible to the whole pipeline. The union's false positives are filtered structurally
    // below, which is a more honest filter than selector ordering anyway.
    return outermostOnly(queryUnion(feedRoot, profile.post)).filter((el) =>
      looksLikePost(el, profile),
    )
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

    return { post, pending: isPending(post) }
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
