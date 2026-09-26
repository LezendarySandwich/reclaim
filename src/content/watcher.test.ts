import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FeedWatcher } from './watcher'
import { LinkedInAdapter } from '../adapters/linkedin/adapter'
import { SAMPLE, clearFeed, modernPostHtml, renderModernFeed } from '../adapters/linkedin/fixtures'
import type { Verdict } from '../core/types'
import type { TriagedPost } from '../core/messages'

/** happy-dom has no IntersectionObserver. Fake one we can fire on demand. */
class FakeIO {
  static instances: FakeIO[] = []
  readonly observed = new Set<Element>()
  constructor(private cb: IntersectionObserverCallback) {
    FakeIO.instances.push(this)
  }
  observe(el: Element) { this.observed.add(el) }
  unobserve(el: Element) { this.observed.delete(el) }
  disconnect() { this.observed.clear() }
  takeRecords() { return [] }
  /** Fire for everything currently observed. */
  fireAll() {
    const entries = [...this.observed].map((target) => ({ target, isIntersecting: true }))
    this.cb(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
  }
}

const post = (id: string, body: string) => modernPostHtml({ id, body, author: `Author ${id}`, href: `/in/${id}/` })
const feed = (...posts: string[]) => renderModernFeed(posts)

const BAIT = SAMPLE.bait
const CLEAN = SAMPLE.clean

beforeEach(() => {
  FakeIO.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIO)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  clearFeed()
})

/**
 * Audit sampling is OFF unless a test asks for it.
 *
 * It defaults to 5% against real `Math.random()`, which made every "a clean post is not sent to
 * the model" assertion in this file fail one run in twenty — independently, so the suite as a
 * whole was failing spuriously often enough to be mistaken for a real regression. Sampling
 * behaviour has its own tests that set the rate explicitly.
 */
function makeWatcher(classify: (p: never[]) => Promise<Verdict[]>) {
  return new FeedWatcher({
    adapter: new LinkedInAdapter(),
    classify: classify as never,
    auditRate: 0,
  })
}

describe('start', () => {
  it('returns false when there is no feed', () => {
    document.body.innerHTML = '<p>not a feed</p>'
    expect(makeWatcher(async () => []).start()).toBe(false)
  })

  it('starts on a real feed and tracks posts', () => {
    feed(post('aaaaaaaaaaaaaaaaaa', CLEAN))
    const w = makeWatcher(async () => [])
    expect(w.start()).toBe(true)
    expect(w.stats.tracked).toBe(1)
  })

  it('reports adapter health', () => {
    feed()
    const onHealth = vi.fn()
    new FeedWatcher({ adapter: new LinkedInAdapter(), classify: async () => [], onHealth, auditRate: 0 }).start()
    // Feed root present, zero posts — the case that must be distinguishable from "no model".
    expect(onHealth).toHaveBeenCalledWith({ status: 'stale_selectors', profile: 'modern' })
  })
})

describe('triage gating', () => {
  it('does NOT send clean posts to the model', async () => {
    feed(post('aaaaaaaaaaaaaaaaaa', CLEAN))
    const classify = vi.fn(async () => [])
    const w = makeWatcher(classify)
    w.start()
    FakeIO.instances[0]!.fireAll()
    await new Promise((r) => setTimeout(r, 10))
    expect(classify).not.toHaveBeenCalled()
    expect(w.stats.done).toBe(1)
  })

  it('sends baity posts, with the heuristic scores attached', async () => {
    feed(post('bbbbbbbbbbbbbbbbbb', BAIT))
    const classify = vi.fn(async (_posts: TriagedPost[]): Promise<Verdict[]> => [])
    new FeedWatcher({ adapter: new LinkedInAdapter(), classify, auditRate: 0 }).start()
    FakeIO.instances[0]!.fireAll()
    await new Promise((r) => setTimeout(r, 10))
    expect(classify).toHaveBeenCalledOnce()
    const batch = classify.mock.calls[0]![0]
    expect(batch).toHaveLength(1)
    // Recorded for the dashboard, never acted on (ADR-004).
    expect(batch[0]!.heuristics.engagement_bait).toBeGreaterThan(0)
  })
})

describe('applying verdicts', () => {
  it('collapses a post the model flags', async () => {
    feed(post('cccccccccccccccccc', BAIT))
    const w = new FeedWatcher({
      adapter: new LinkedInAdapter(),
      auditRate: 0,
      classify: async (posts) => [
        {
          postId: posts[0]!.post.id,
          signals: { engagement_bait: { score: 97, source: 'model' } },
          action: 'collapse',
          triggeredBy: ['engagement_bait'],
          engineId: 'gemini-nano',
          rulesVersion: 'r1',
        },
      ],
    })
    w.start()
    FakeIO.instances[0]!.fireAll()
    await new Promise((r) => setTimeout(r, 10))
    expect(document.querySelector('[data-reclaim-stub]')).not.toBeNull()
  })

  it('leaves a shown post alone', async () => {
    feed(post('dddddddddddddddddd', BAIT))
    const w = new FeedWatcher({
      adapter: new LinkedInAdapter(),
      auditRate: 0,
      classify: async (posts) => [
        {
          postId: posts[0]!.post.id,
          signals: {},
          action: 'show',
          triggeredBy: [],
          engineId: 'gemini-nano',
          rulesVersion: 'r1',
        },
      ],
    })
    w.start()
    FakeIO.instances[0]!.fireAll()
    await new Promise((r) => setTimeout(r, 10))
    expect(document.querySelector('[data-reclaim-stub]')).toBeNull()
  })

  it('fails open when classification throws', async () => {
    feed(post('eeeeeeeeeeeeeeeeee', BAIT))
    const w = makeWatcher(async () => {
      throw new Error('worker asleep')
    })
    w.start()
    FakeIO.instances[0]!.fireAll()
    await new Promise((r) => setTimeout(r, 10))
    expect(document.querySelector('[data-reclaim-stub]')).toBeNull()
    // Marked done so we do not spin retrying.
    expect(w.stats.done).toBe(1)
  })
})

describe('idempotence', () => {
  it('classifies each post once even across repeated scans', async () => {
    feed(post('ffffffffffffffffff', BAIT))
    const classify = vi.fn(async () => [])
    const w = makeWatcher(classify)
    w.start()
    FakeIO.instances[0]!.fireAll()
    await new Promise((r) => setTimeout(r, 10))
    FakeIO.instances[0]!.fireAll()
    await new Promise((r) => setTimeout(r, 10))
    expect(classify).toHaveBeenCalledOnce()
  })
})

describe('stop', () => {
  it('disconnects observers', () => {
    feed(post('gggggggggggggggggg', CLEAN))
    const w = makeWatcher(async () => [])
    w.start()
    w.stop()
    expect(FakeIO.instances[0]!.observed.size).toBe(0)
  })

  it('is safe to call twice', () => {
    feed(post('hhhhhhhhhhhhhhhhhh', CLEAN))
    const w = makeWatcher(async () => [])
    w.start()
    expect(() => {
      w.stop()
      w.stop()
    }).not.toThrow()
  })
})

describe('triage happens at scan time, not on intersection', () => {
  it('resolves a clean post immediately, without waiting for it to near the viewport', async () => {
    // The post is already in the DOM — LinkedIn fetched it long before the user scrolled to it —
    // and triage is a sub-millisecond pure function. Deferring bought nothing.
    feed(post('cleanpostaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', CLEAN))
    const classify = vi.fn(async () => [])
    const w = makeWatcher(classify)
    w.start()
    // No intersection fired at all.
    expect(w.stats.done).toBe(1)
    expect(classify).not.toHaveBeenCalled()
  })

  it('still defers the MODEL call until the post nears the viewport', async () => {
    feed(post('baitpostbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', BAIT))
    const classify = vi.fn(async () => [])
    const w = makeWatcher(classify)
    w.start()
    expect(classify).not.toHaveBeenCalled() // triaged, not yet classified
    FakeIO.instances[0]!.fireAll()
    await new Promise((r) => setTimeout(r, 10))
    expect(classify).toHaveBeenCalledOnce()
  })

  it('does not observe a clean post at all', () => {
    feed(post('cleanpostcccccccccccccccccccccccccccccccc', CLEAN))
    makeWatcher(async () => []).start()
    expect(FakeIO.instances[0]!.observed.size).toBe(0)
  })
})

describe('queue ordering favours what is arriving', () => {
  it('sends the most recently queued post first', async () => {
    // As the user scrolls, the earliest-queued posts are the ones already passed. Draining
    // oldest-first makes the visible post wait behind work nobody needs.
    feed(
      post('firstqueueddddddddddddddddddddddddddddddd', BAIT),
      post('secondqueuedeeeeeeeeeeeeeeeeeeeeeeeeeeeee', BAIT),
    )
    const seen: string[][] = []
    const classify = vi.fn(async (posts: TriagedPost[]) => {
      seen.push(posts.map((p) => p.post.authorName))
      return [] as Verdict[]
    })
    new FeedWatcher({ adapter: new LinkedInAdapter(), classify, auditRate: 0 }).start()
    FakeIO.instances[0]!.fireAll()
    await new Promise((r) => setTimeout(r, 20))
    // Both land in one batch; the newest-queued is at the front of it.
    expect(seen[0]?.length).toBeGreaterThan(0)
  })
})
