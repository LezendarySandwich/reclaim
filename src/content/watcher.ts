/**
 * The feed watcher: what actually runs in the tab.
 *
 * Site-agnostic — it drives a `SiteAdapter` and knows nothing about LinkedIn. Adding Reddit means
 * a new adapter, not a new watcher.
 *
 * ## The scan loop, copied from prior art rather than invented
 *
 * `adamnroman/slop-filter` already tuned this shape and it matches our architecture exactly:
 * an IntersectionObserver with a generous `rootMargin` as the triage gate, and a MutationObserver
 * coalesced through a single `requestAnimationFrame`. LinkedIn mutates the feed constantly, and
 * reacting per-mutation burns the main thread for nothing.
 *
 * ## State is keyed by post id, never by element
 *
 * S4's node-recycling test was invalid — `scrollHeight` was identical before and after, so the
 * page never scrolled and we still do not know whether LinkedIn reuses DOM nodes. Keying on the
 * derived post id is correct under either answer; a `WeakMap<Element, state>` would silently
 * attach a stub to the wrong post if nodes turn out to be recycled.
 */

import { needsModel, route } from '../detect/triage'
import type { SiteAdapter } from '../adapters/types'
import type { Axis, Verdict } from '../core/types'
import type { TriagedPost } from '../core/messages'

/** How far outside the viewport to start work. Prior-art value; not independently tuned. */
const ROOT_MARGIN = '1500px 0px'

/** Posts per message. Big enough to amortise the round trip, small enough to stay responsive. */
const BATCH_SIZE = 6

export interface WatcherDeps {
  adapter: SiteAdapter
  /** Sends a batch for classification. Returns verdicts, or rejects. */
  classify: (posts: TriagedPost[]) => Promise<Verdict[]>
  /** Called when a user disagrees with a hide. */
  onFeedback?: (postId: string, axis: Axis, agrees: boolean) => void
  /** Surfaces adapter health so "selectors broke" is distinguishable from "no model". */
  onHealth?: (health: ReturnType<SiteAdapter['health']>) => void
  document?: Document
}

type PostState = 'pending' | 'queued' | 'done'

export class FeedWatcher {
  readonly #deps: WatcherDeps
  readonly #doc: Document

  /** Keyed by POST ID, not element. See the module note. */
  readonly #state = new Map<string, PostState>()
  /** Live element for a post id, refreshed on every scan so a recycled node cannot go stale. */
  readonly #elements = new Map<string, Element>()
  /**
   * Author name per post id, captured at extraction time.
   *
   * Kept because the stub needs it and re-deriving it at collapse time was unreliable — the stub
   * rendered "this author" for posts whose author extraction had already identified.
   */
  readonly #authors = new Map<string, string>()

  #mutationObserver: MutationObserver | null = null
  #intersectionObserver: IntersectionObserver | null = null
  #rafHandle: number | null = null
  #queue: string[] = []
  #flushing = false
  #started = false

  constructor(deps: WatcherDeps) {
    this.#deps = deps
    this.#doc = deps.document ?? document
  }

  start(): boolean {
    if (this.#started) return true

    this.#deps.adapter.detectProfile(this.#doc)
    const feedRoot = this.#deps.adapter.findFeedRoot(this.#doc)
    this.#deps.onHealth?.(this.#deps.adapter.health(this.#doc))
    if (!feedRoot) return false

    this.#intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.#enqueue(entry.target)
        }
      },
      { rootMargin: ROOT_MARGIN },
    )

    this.#mutationObserver = new MutationObserver(() => this.#scheduleScan())
    this.#mutationObserver.observe(feedRoot, { childList: true, subtree: true })

    this.#started = true
    this.#scan()
    return true
  }

  stop(): void {
    this.#mutationObserver?.disconnect()
    this.#intersectionObserver?.disconnect()
    if (this.#rafHandle !== null) cancelAnimationFrame(this.#rafHandle)
    this.#mutationObserver = null
    this.#intersectionObserver = null
    this.#rafHandle = null
    this.#started = false
  }

  /** Coalesce a burst of mutations into one scan per frame. */
  #scheduleScan(): void {
    if (this.#rafHandle !== null) return
    this.#rafHandle = requestAnimationFrame(() => {
      this.#rafHandle = null
      this.#scan()
    })
  }

  #scan(): void {
    const feedRoot = this.#deps.adapter.findFeedRoot(this.#doc)
    if (!feedRoot) return

    for (const el of this.#deps.adapter.findPosts(feedRoot)) {
      const extracted = this.#deps.adapter.extract(el)
      if (!extracted) continue

      const { post, pending } = extracted

      // Always refresh the element mapping. If LinkedIn recycles nodes, the id -> element
      // association changes underneath us and a stale reference would stub the wrong post.
      this.#elements.set(post.id, el)
      if (post.authorName) this.#authors.set(post.id, post.authorName)

      // Lazily-mounted rows exist before their content does. Leave them alone; the next
      // mutation brings us back.
      if (pending) continue

      const state = this.#state.get(post.id)
      if (state === 'done' || state === 'queued') continue

      this.#state.set(post.id, 'pending')
      this.#intersectionObserver?.observe(el)
    }
  }

  #enqueue(el: Element): void {
    const extracted = this.#deps.adapter.extract(el)
    if (!extracted || extracted.pending) return

    const id = extracted.post.id
    if (this.#state.get(id) !== 'pending') return

    this.#state.set(id, 'queued')
    this.#queue.push(id)
    this.#intersectionObserver?.unobserve(el)
    void this.#flush()
  }

  async #flush(): Promise<void> {
    if (this.#flushing || this.#queue.length === 0) return
    this.#flushing = true

    try {
      while (this.#queue.length > 0) {
        const batchIds = this.#queue.splice(0, BATCH_SIZE)
        const batch: TriagedPost[] = []

        for (const id of batchIds) {
          const el = this.#elements.get(id)
          if (!el || !el.isConnected) {
            // Scrolled out and unmounted before we got to it. Forget it entirely so it is
            // re-evaluated fresh if it comes back.
            this.#state.delete(id)
            continue
          }

          const extracted = this.#deps.adapter.extract(el)
          if (!extracted || extracted.post.id !== id) {
            // The node now holds a different post — exactly the recycling case. Drop this entry;
            // the next scan picks the new post up under its own id.
            this.#state.delete(id)
            continue
          }

          const triage = route(extracted.post.text)

          // A promoted post must always be classified, whatever the router thinks of its prose.
          // Ad copy is often perfectly well written and routes `clean`, and the sponsored axis
          // decides on the page's own label rather than on the text — so skipping here would
          // mean never hiding an advert whose wording happens to be good.
          if (!extracted.post.isPromoted && !needsModel(triage.band)) {
            // Cheap and confident: the model never needs to see this.
            this.#state.set(id, 'done')
            continue
          }

          batch.push({
            post: extracted.post,
            heuristics: {
              engagement_bait: Math.round(triage.bait * 100),
              ai_written: Math.round(triage.ai * 100),
            },
            band: triage.band,
          })
        }

        if (batch.length === 0) continue

        try {
          const verdicts = await this.#deps.classify(batch)
          for (const verdict of verdicts) this.#apply(verdict)
        } catch {
          // Classification failed — the worker was asleep, the gate closed, anything. Fail open:
          // mark done so we do not spin, and leave every post visible.
          for (const p of batch) this.#state.set(p.post.id, 'done')
        }
      }
    } finally {
      this.#flushing = false
    }
  }

  #apply(verdict: Verdict): void {
    this.#state.set(verdict.postId, 'done')
    if (verdict.action !== 'collapse') return

    const el = this.#elements.get(verdict.postId)
    if (!el || !el.isConnected) return

    const label = verdict.triggeredBy.length > 0 ? LABELS[verdict.triggeredBy[0]!] : 'Hidden'

    this.#deps.adapter.mountStub(el, {
      label,
      authorName: this.#authors.get(verdict.postId) ?? '',
      onExpand: () => {
        // Expanding is itself feedback: the user wanted to read it.
        this.#deps.onFeedback?.(verdict.postId, verdict.triggeredBy[0] ?? 'engagement_bait', false)
      },
    })
  }

  /** Test/telemetry surface. */
  get stats(): { tracked: number; done: number; queued: number } {
    let done = 0
    let queued = 0
    for (const s of this.#state.values()) {
      if (s === 'done') done++
      else if (s === 'queued') queued++
    }
    return { tracked: this.#state.size, done, queued }
  }
}

/** Never a score, never an authorship assertion (ADR-019). */
const LABELS: Record<Axis, string> = {
  engagement_bait: 'Looks like engagement bait',
  ai_written: 'Looks templated',
  ai_image: 'Image may be generated',
  sponsored: 'Promoted',
}
