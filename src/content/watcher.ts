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

/**
 * Distance from the viewport in screen-heights. 0 means on screen.
 *
 * One `getBoundingClientRect` per post per batch — a layout read, so not free, but it happens
 * once per classification rather than per frame. Worth it: without a real measurement the
 * scheduler cannot tell a post about to appear from one scrolled past ten screens ago.
 */
function distanceOf(el: Element): number {
  const rect = el.getBoundingClientRect()
  const h = window.innerHeight || 1
  if (rect.bottom < 0) return Math.abs(rect.bottom) / h // above the viewport, already passed
  if (rect.top > h) return (rect.top - h) / h // below, approaching
  return 0
}

/** Posts per message. Big enough to amortise the round trip, small enough to stay responsive. */
const BATCH_SIZE = 6

/**
 * Share of `clean`-routed posts sent to the model anyway, purely to measure the router.
 *
 * The router's only expensive mistake is clearing a post that should have been judged, and that
 * mistake is invisible by construction — no verdict row exists for a post the model never saw.
 * Sampling turns it into an estimate at a bounded cost: at 5%, a 200-post session buys ten extra
 * inferences and, over a week, enough data to say whether the router is leaking.
 *
 * These samples can never hide anything; the pipeline forces them to `show`.
 */
const AUDIT_SAMPLE_RATE = 0.05

/**
 * How many times one post may be reopened after being resolved.
 *
 * Reopening is driven by evidence changing, and the two things that can change are both close to
 * monotonic — `isPromoted` goes false→true once, and text grows as the post finishes rendering or
 * the user expands it. Three is slack for a noisy hydration, not a budget anything should reach;
 * the cap exists so a pathologically mutating page cannot put a post in a scan/classify loop.
 */
const MAX_REOPENS = 3

/**
 * Text growth that counts as new evidence, in characters.
 *
 * Small enough to catch a post that first painted truncated, large enough that trailing-whitespace
 * and entity-decoding jitter between renders does not trip it.
 */
const TEXT_GROWTH_THRESHOLD = 40

export interface WatcherDeps {
  adapter: SiteAdapter
  /** Sends a batch for classification. Returns verdicts, or rejects. */
  classify: (posts: TriagedPost[]) => Promise<Verdict[]>
  /** Called when a user disagrees with a hide. */
  onFeedback?: (postId: string, axis: Axis, agrees: boolean) => void
  /** Surfaces adapter health so "selectors broke" is distinguishable from "no model". */
  onHealth?: (health: ReturnType<SiteAdapter['health']>) => void
  document?: Document
  /** Injectable for tests. Returns 0-1. */
  random?: () => number
  /** Override the audit sampling rate; 0 disables it entirely. */
  auditRate?: number
}

type PostState = 'triaged' | 'queued' | 'done'

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
  /** Router result per post, computed at scan time so the model call carries no triage latency. */
  readonly #triage = new Map<string, ReturnType<typeof route>>()
  /** Posts selected as router-audit samples. */
  readonly #audit = new Set<string>()
  /**
   * The evidence a `done` post was resolved on, so a later render can be detected as different.
   *
   * See `#evidenceOf`. Only `done` posts need an entry — every other state is re-derived anyway.
   */
  readonly #resolvedOn = new Map<string, string>()
  /** Reopen count per post, to bound churn if a page mutates pathologically. */
  readonly #reopens = new Map<string, number>()

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
      if (state === 'queued' || state === 'triaged') continue

      // `done` is not quite final.
      //
      // LinkedIn's SDUI feed hydrates a post in pieces, and the order is not guaranteed: the body
      // text can paint before the actor block that carries the "Promoted" label. A post resolved
      // in that window was judged on evidence that was still arriving, and because `done` used to
      // be terminal the label landing 50ms later was never seen. That is why *some* ads were
      // getting through while others were caught — a race, not a bad selector.
      //
      // Re-extracting costs nothing here: `extract()` above already ran for every post on every
      // scan, and its result was simply discarded at this line.
      if (state === 'done') {
        if (!this.#evidenceChanged(post.id, post)) continue
        const seen = this.#reopens.get(post.id) ?? 0
        if (seen >= MAX_REOPENS) continue
        this.#reopens.set(post.id, seen + 1)
        this.#audit.delete(post.id)
      }

      // TRIAGE NOW, not when the post nears the viewport.
      //
      // The post is already in the DOM — LinkedIn fetched it long before the user scrolled to
      // it — and triage is a sub-millisecond pure function. Deferring it bought nothing and cost
      // latency at exactly the moment it matters: the instant a post appears. Posts the router
      // clears are resolved here and never touch the observer at all.
      //
      // Only the MODEL call stays gated on proximity, because that is the part with real cost.
      const triage = route(post.text)
      this.#triage.set(post.id, triage)

      const mustClassify = post.isPromoted || needsModel(triage.band)
      const auditRate = this.#deps.auditRate ?? AUDIT_SAMPLE_RATE
      const rnd = this.#deps.random ?? Math.random
      const audit = !mustClassify && auditRate > 0 && rnd() < auditRate

      if (!mustClassify && !audit) {
        this.#state.set(post.id, 'done')
        this.#resolvedOn.set(post.id, this.#evidenceOf(post))
        continue
      }
      if (audit) this.#audit.add(post.id)

      this.#state.set(post.id, 'triaged')
      this.#intersectionObserver?.observe(el)
    }
  }

  /**
   * A fingerprint of everything a routing decision was made from.
   *
   * Deliberately not the full text — this is compared on every scan, and the point is only to
   * notice that the evidence moved, not to reproduce it.
   */
  #evidenceOf(post: { isPromoted: boolean; text: string }): string {
    return `${post.isPromoted ? 'p' : '-'}:${post.text.length}`
  }

  /**
   * Has the evidence changed in a direction that could change the answer?
   *
   * Asymmetric on purpose. A post gaining the "Promoted" label or gaining text may now warrant
   * hiding, so it is reconsidered. A post *losing* either — which is what a partial re-render or a
   * collapsed "see more" looks like — must not reopen anything: there is no new reason to hide it,
   * and treating shrinkage as news would let a re-render undo a decision the user already saw.
   */
  #evidenceChanged(id: string, post: { isPromoted: boolean; text: string }): boolean {
    const before = this.#resolvedOn.get(id)
    if (before === undefined) return false
    const now = this.#evidenceOf(post)
    if (now === before) return false

    const [wasPromoted, wasLength] = before.split(':') as [string, string]
    if (post.isPromoted && wasPromoted !== 'p') return true
    return post.text.length - Number(wasLength) >= TEXT_GROWTH_THRESHOLD
  }

  #enqueue(el: Element): void {
    const extracted = this.#deps.adapter.extract(el)
    if (!extracted || extracted.pending) return

    const id = extracted.post.id
    if (this.#state.get(id) !== 'triaged') return

    this.#state.set(id, 'queued')
    // PUSH TO THE FRONT. As the user scrolls, the posts that entered the queue earliest are the
    // ones they have already moved past; the newest arrival is the one about to be on screen.
    // Draining oldest-first means the visible post waits behind work nobody needs any more.
    //
    // This is a fallback ordering only — the scheduler re-ranks by real viewport distance at
    // dequeue, which subsumes it and additionally DROPS anything scrolled far away. LIFO alone
    // would still eventually process a post you passed ten screens ago.
    this.#queue.unshift(id)
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

          // Triage already ran at scan time; reuse it rather than recomputing.
          const triage = this.#triage.get(id) ?? route(extracted.post.text)
          const audit = this.#audit.has(id)

          batch.push({
            post: extracted.post,
            distance: distanceOf(el),
            heuristics: {
              engagement_bait: Math.round(triage.bait * 100),
              ai_written: Math.round(triage.ai * 100),
            },
            band: triage.band,
            ...(audit ? { audit: true } : {}),
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
