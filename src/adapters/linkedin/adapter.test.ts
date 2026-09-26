import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkedInAdapter, outermostOnly } from './adapter'
import { clearFeed, modernPostHtml, renderLegacyFeed, renderModernFeed } from './fixtures'
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
    adapter.mountStub(el, 'Looks like engagement bait', () => {})
    const stub = el.querySelector('[data-reclaim-stub]')!
    expect(stub.shadowRoot!.textContent).toContain('Alice Smith')
  })

  it('restores on unmount', () => {
    modernFeed([modernPost()])
    adapter.detectProfile(document)
    const el = adapter.findPosts(adapter.findFeedRoot(document)!)[0]! as HTMLElement
    adapter.mountStub(el, 'Looks templated', vi.fn())
    adapter.unmountStub(el)
    expect(el.querySelector('[data-reclaim-stub]')).toBeNull()
  })
})
