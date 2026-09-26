import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkedInAdapter, outermostOnly } from './adapter'
import {
  clearFeed,
  modernPostHtml,
  realPromotedPostHtml,
  renderLegacyFeed,
  socialContextPostHtml,
  renderModernFeed,
} from './fixtures'
import type { PostFixture } from './fixtures'

/** Shared fixtures live in ./fixtures.ts so LinkedIn DOM knowledge stays inside the adapter. */
const modernFeed = (posts: string[]) => renderModernFeed(posts)
const modernPost = (options: PostFixture = {}) => modernPostHtml(options)

let adapter: LinkedInAdapter

beforeEach(() => {
  clearFeed()
  adapter = new LinkedInAdapter()
})

describe('matches', () => {
  it.each([
    ['https://www.linkedin.com/feed/', true],
    ['https://www.linkedin.com/feed/?feedView=recent', true],
    ['https://www.linkedin.com/in/alice/', false],
    ['https://linkedin.com/feed/', false],
    ['https://evil.com/feed/', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(adapter.matches(url)).toBe(expected)
  })
})

describe('profile detection', () => {
  it('detects the modern feed', () => {
    modernFeed([modernPost()])
    expect(adapter.detectProfile(document)).toBe('modern')
  })

  it('detects the legacy feed', () => {
    renderLegacyFeed()
    expect(adapter.detectProfile(document)).toBe('legacy')
  })

  it('reports unknown on an unrecognised page', () => {
    document.body.innerHTML = '<p>nothing here</p>'
    expect(adapter.detectProfile(document)).toBe('unknown')
  })
})

describe('finding posts', () => {
  it('finds the feed root and the posts', () => {
    modernFeed([modernPost({ id: 'aaaaaaaaaaaaaaaaaa' }), modernPost({ id: 'bbbbbbbbbbbbbbbbbb' })])
    adapter.detectProfile(document)
    const root = adapter.findFeedRoot(document)
    expect(root).not.toBeNull()
    expect(adapter.findPosts(root!)).toHaveLength(2)
  })

  it('drops nested matches — S4 saw 27 raw for 8 real posts', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    outer.append(inner)
    const sibling = document.createElement('div')
    expect(outermostOnly([outer, inner, sibling])).toEqual([outer, sibling])
  })

  it('returns nothing when no profile has been detected', () => {
    modernFeed([modernPost()])
    expect(adapter.findPosts(document.querySelector('[data-testid="mainFeed"]')!)).toEqual([])
  })
})

describe('extraction', () => {
  function firstPost() {
    adapter.detectProfile(document)
    const root = adapter.findFeedRoot(document)!
    return adapter.extract(adapter.findPosts(root)[0]!)
  }

  it('extracts author, text and identity', () => {
    modernFeed([modernPost({ author: 'Alice Smith', body: 'We shipped the thing on Tuesday.' })])
    const result = firstPost()
    expect(result?.post.authorName).toBe('Alice Smith')
    expect(result?.post.text).toBe('We shipped the thing on Tuesday.')
    expect(result?.post.id).toMatch(/^ck:/)
    expect(result?.post.site).toBe('linkedin')
  })

  it('normalises the author URL so the leaderboard groups correctly', () => {
    modernFeed([modernPost({ href: '/in/alice/?trk=feed_and_more&originalSubdomain=uk' })])
    expect(firstPost()?.post.authorUrn).toBe('/in/alice')
  })

  it('strips the "… more" toggle out of the body', () => {
    // textContent would otherwise append it to every truncated post, and it would look like
    // post content to the model.
    modernFeed([modernPost({ body: 'Real content here.', seeMore: true })])
    const text = firstPost()!.post.text
    expect(text).toBe('Real content here.')
    expect(text).not.toContain('more')
  })

  it('excludes social proof, which would otherwise pollute every model input', () => {
    modernFeed([
      modernPost({ body: 'Real content.', socialProof: 'Bob and 12 others like this' }),
    ])
    expect(firstPost()!.post.text).not.toContain('Bob and 12 others')
  })

  it('preserves <br> as newlines, because line structure is a triage signal', () => {
    modernFeed([modernPost({ body: 'Line one.<br>Line two.<br>Line three.' })])
    expect(firstPost()!.post.text).toBe('Line one.\nLine two.\nLine three.')
  })

  it('does not mutate the live page while extracting', () => {
    modernFeed([modernPost({ body: 'Content.', seeMore: true })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    adapter.extract(el)
    // The clone is what gets stripped. The real button must survive.
    expect(el.querySelector('[data-testid="expandable-text-box"] button')).not.toBeNull()
  })

  it('detects media', () => {
    modernFeed([modernPost({ media: true })])
    expect(firstPost()!.post.media).toHaveLength(1)
    expect(firstPost()!.post.media[0]!.kind).toBe('image')
  })

  it('flags an unfilled lazy-mounted row as pending rather than classifying it', () => {
    modernFeed([modernPost({ body: '' })])
    const result = firstPost()
    // No text yet. Extends fail-open: no model means hide nothing, no text means do not triage.
    expect(result?.pending ?? true).toBe(true)
  })

  it('gives distinct ids to distinct posts', () => {
    modernFeed([
      modernPost({ id: 'aaaaaaaaaaaaaaaaaaaaaaa', body: 'First post here.' }),
      modernPost({ id: 'bbbbbbbbbbbbbbbbbbbbbbb', body: 'Second post here.' }),
    ])
    adapter.detectProfile(document)
    const posts = adapter.findPosts(adapter.findFeedRoot(document)!)
    const ids = posts.map((p) => adapter.extract(p)?.post.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('gives the SAME id across a re-render of the same post', () => {
    modernFeed([modernPost({ id: 'stable_id_aaaaaaaaaaaa', body: 'Same post.' })])
    adapter.detectProfile(document)
    const first = adapter.extract(adapter.findPosts(adapter.findFeedRoot(document)!)[0]!)?.post.id
    modernFeed([modernPost({ id: 'stable_id_aaaaaaaaaaaa', body: 'Same post.' })])
    adapter.detectProfile(document)
    const second = adapter.extract(adapter.findPosts(adapter.findFeedRoot(document)!)[0]!)?.post.id
    expect(first).toBe(second)
  })
})

describe('promoted detection', () => {
  it('catches a multilingual Promoted label', () => {
    // Every structural sponsored selector scored 0/8 in S4 because the sample had no ads, so
    // the label check is currently the only tested half.
    modernFeed([modernPost({ promotedLabel: 'Gesponsert' })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)?.post.isPromoted).toBe(true)
  })

  it('does not flag an ordinary post', () => {
    modernFeed([modernPost()])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)?.post.isPromoted).toBe(false)
  })
})

describe('health', () => {
  it('reports ok with a post count', () => {
    modernFeed([modernPost(), modernPost({ id: 'ccccccccccccccccccc' })])
    adapter.detectProfile(document)
    expect(adapter.health(document)).toEqual({ status: 'ok', postsFound: 2, profile: 'modern' })
  })

  it('distinguishes stale selectors from a missing feed', () => {
    // The distinction that matters: because we hide nothing without a model, a broken selector
    // and a missing model look identical to the user.
    modernFeed([])
    adapter.detectProfile(document)
    expect(adapter.health(document)).toEqual({ status: 'stale_selectors', profile: 'modern' })
  })

  it('reports no_feed_root off-feed', () => {
    document.body.innerHTML = '<p>some other page</p>'
    expect(adapter.health(document).status).toBe('no_feed_root')
  })
})

describe('stub mounting', () => {
  it('collapses a post and names the author', () => {
    modernFeed([modernPost({ author: 'Alice Smith' })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]! as HTMLElement
    adapter.mountStub(el, {
      label: 'Looks like engagement bait',
      authorName: 'Alice Smith',
      onExpand: () => {},
    })
    const stub = el.querySelector('[data-reclaim-stub]')!
    expect(stub.shadowRoot!.textContent).toContain('Alice Smith')
  })

  it('restores on unmount', () => {
    modernFeed([modernPost()])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]! as HTMLElement
    adapter.mountStub(el, { label: 'Looks templated', authorName: 'Alice', onExpand: vi.fn() })
    adapter.unmountStub(el)
    expect(el.querySelector('[data-reclaim-stub]')).toBeNull()
  })
})

describe('LinkedIn’s own aria-hidden see-more button', () => {
  // LinkedIn marks data-testid="expandable-text-button" as aria-hidden="true" while leaving it
  // focusable — their accessibility bug, surfaced by a Chrome console warning. What matters to
  // us is that it is inside the body container, so `textContent` would append "… more" to every
  // truncated post and feed it to the model as if it were content.
  it('strips it from extracted text', () => {
    modernFeed([modernPost({ body: 'The real post content.', seeMore: true })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    const text = adapter.extract(el)!.post.text
    expect(text).toBe('The real post content.')
    expect(text).not.toContain('more')
  })

  it('leaves the real button on the page untouched', () => {
    // We read; we do not rewrite. Their bug is theirs to fix, and silently mutating a host page's
    // accessibility attributes would be worse than leaving it alone.
    modernFeed([modernPost({ body: 'Content.', seeMore: true })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    adapter.extract(el)
    const button = el.querySelector('[data-testid="expandable-text-button"]')
    expect(button).not.toBeNull()
    expect(button!.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('author name — the "this author" bug', () => {
  // Reported from a live feed: two posts collapsed with the stub reading "this author — Looks
  // like engagement bait". mountStub was re-reading the author from the DOM instead of using
  // what extract() had already found, and the re-read came back empty.
  it('uses the name it is given rather than re-deriving one', () => {
    modernFeed([modernPost({ author: 'Alice Smith' })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]! as HTMLElement
    adapter.mountStub(el, { label: 'Looks templated', authorName: 'Bob Jones', onExpand: () => {} })
    const stub = el.querySelector('[data-reclaim-stub]')!
    expect(stub.shadowRoot!.textContent).toContain('Bob Jones')
  })

  it('falls back to "this author" only when genuinely given nothing', () => {
    modernFeed([modernPost()])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]! as HTMLElement
    adapter.mountStub(el, { label: 'Looks templated', authorName: '', onExpand: () => {} })
    expect(el.querySelector('[data-reclaim-stub]')!.shadowRoot!.textContent).toContain('this author')
  })

  it('derives a readable name from the profile slug when the name node is missing', () => {
    // LinkedIn's name markup varies by post type and locale. A stub saying "this author" when
    // the href plainly reads /in/alice-smith is worse than an imperfect guess.
    modernFeed([modernPost({ author: '', href: '/in/alice-smith-4a2b9f1c/' })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)!.post.authorName).toBe('Alice Smith')
  })

  it('prefers the rendered name over the slug', () => {
    modernFeed([modernPost({ author: 'Alice Smith-Jones', href: '/in/asj123/' })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)!.post.authorName).toBe('Alice Smith-Jones')
  })
})

describe('promoted detection must not eat promotion announcements', () => {
  it('detects a real ad, where the label is its own line', () => {
    modernFeed([modernPost({ author: 'PagerDuty', body: 'See how leading SRE teams delegate triage.', promotedLabel: 'Promoted' })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)!.post.isPromoted).toBe(true)
  })

  it('does NOT fire on "I was promoted to Senior Engineer"', () => {
    // The trap. A substring check on "Promoted" would hide one of the most common posts on
    // LinkedIn — somebody announcing a promotion — as an advert. About the worst false positive
    // this extension could produce.
    modernFeed([
      modernPost({
        author: 'Alice Smith',
        body: 'Thrilled to share that I was promoted to Senior Engineer this week after four years on the platform team.',
      }),
    ])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)!.post.isPromoted).toBe(false)
  })

  it('does not fire on a post merely discussing promotions', () => {
    modernFeed([
      modernPost({
        body: 'Some thoughts on how promotion committees actually work, and why being promoted is not the same as being ready.',
      }),
    ])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)!.post.isPromoted).toBe(false)
  })

  it('handles non-English labels', () => {
    modernFeed([modernPost({ promotedLabel: 'Gesponsert' })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)!.post.isPromoted).toBe(true)
  })
})

describe('promoted detection against REAL captured ad markup', () => {
  it('detects the Datadog ad', () => {
    // The fixture is verbatim from a live ad. Two earlier approaches passed hand-written tests
    // and failed on this: a substring check, and a newline-split check.
    renderModernFeed([
      realPromotedPostHtml('See how leading SRE teams delegate routine incident triage to AI agents.'),
    ])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)!.post.isPromoted).toBe(true)
  })

  it('confirms textContent has no newlines, which is why line-splitting failed', () => {
    renderModernFeed([realPromotedPostHtml('Ad copy.')])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    const tc = el.textContent ?? ''
    expect(tc).toContain('followersPromoted') // no separator between block elements
  })

  it('still does not fire on a promotion announcement in the same feed', () => {
    renderModernFeed([
      modernPostHtml({
        id: 'promotionannouncementaaaaaaaaaaaaaaaaaaaaaa',
        body: 'Thrilled to share that I was promoted to Senior Engineer this week.',
      }),
    ])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)!.post.isPromoted).toBe(false)
  })

  it('distinguishes an ad from an ordinary post in a mixed feed', () => {
    renderModernFeed([
      realPromotedPostHtml('Transform poor quality data into secure, trusted, unified data.'),
      modernPostHtml({ id: 'ordinarypostbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', body: 'We shipped it Tuesday.' }),
    ])
    adapter.detectProfile(document)
    const posts = adapter.findPosts(adapter.findFeedRoot(document)!)
    const flags = posts.map((p) => adapter.extract(p)!.post.isPromoted)
    expect(flags).toEqual([true, false])
  })
})

describe('author attribution on a "X commented" card', () => {
  // Reported from a live feed: the stub named Igor Šlat, who commented, rather than Felipe
  // Weber, who wrote it. The commenter's profile link comes FIRST in document order, and
  // readAuthor took the first match. The leaderboard groups on this value, so the bug credited
  // one person's posting habits to another — the worst class of error in an accusation surface.
  it('attributes the post to the AUTHOR, not the commenter', () => {
    renderModernFeed([socialContextPostHtml()])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    const post = adapter.extract(el)!.post
    expect(post.authorName).toBe('Felipe Weber')
    expect(post.authorUrn).toBe('/in/felipe-weber')
  })

  it('does not leak the commenter into the author URN', () => {
    renderModernFeed([socialContextPostHtml({ commenterSlug: 'igor-slat' })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)!.post.authorUrn).not.toContain('igor')
  })

  it('reads the name out of the "View X’s profile" label', () => {
    renderModernFeed([socialContextPostHtml({ author: 'Priya Raman', authorSlug: 'priya-raman' })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)!.post.authorName).toBe('Priya Raman')
  })

  it('still works on an ordinary post with no social context', () => {
    renderModernFeed([modernPostHtml({ author: 'Alice Smith', href: '/in/alice-smith/' })])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    const post = adapter.extract(el)!.post
    expect(post.authorName).toBe('Alice Smith')
    expect(post.authorUrn).toBe('/in/alice-smith')
  })

  it('does not mistake a post that merely discusses commenting for a social-context card', () => {
    // The text fallback only treats SHORT blocks as banners, so a post about comments is safe.
    renderModernFeed([
      modernPostHtml({
        author: 'Alice Smith',
        href: '/in/alice-smith/',
        body:
          'I commented on three posts this week and every single one of them turned into a ' +
          'genuinely useful conversation, which is not what I expected from this platform.',
      }),
    ])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]!
    expect(adapter.extract(el)!.post.authorName).toBe('Alice Smith')
  })
})
