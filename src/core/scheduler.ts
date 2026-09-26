/**
 * Inference scheduler.
 *
 * A fast scroll through 200 posts must not enqueue 200 model calls. This is the backpressure
 * layer between the content script and the engine, and it is pure — it takes a `run` function
 * and knows nothing about models, the DOM, or `chrome.*`.
 *
 * ## Why it is shaped like this
 *
 * The Prompt API queues prompts on a session rather than running them concurrently, so
 * parallelism has to come from cloning. But an unmeasured question hangs over abort: **does
 * `AbortSignal` actually free the inference slot, or only reject the promise?** If it is
 * cosmetic, aggressive aborting is *slower* than never aborting, because the work still runs and
 * you have paid for a rejection on top.
 *
 * Rather than guess, this scheduler is designed to be correct under either answer:
 *
 * - **One in-flight job.** Never rely on concurrency we cannot verify.
 * - **Drop from the queue, don't abort in flight.** Cancelling a queued job is free and certain.
 *   Aborting a running one is neither, so we only do it when explicitly asked to stop everything.
 * - **Re-rank on dequeue, not on enqueue.** By the time a slot frees, the user has scrolled and
 *   the priorities recorded at enqueue time are stale. Re-reading priority at dequeue is what
 *   makes the queue track the viewport instead of the scroll history.
 */

export interface Job<T> {
  /** Stable identity. A second enqueue with the same key replaces the first. */
  key: string
  /** Lower runs sooner. Read again at dequeue, because the user has moved since. */
  priority: () => number
  /** Jobs above this priority at dequeue time are dropped unscored. */
  run: () => Promise<T>
}

export interface SchedulerOptions {
  /** Queued jobs beyond this are dropped, worst priority first. */
  maxQueue?: number
  /**
   * Priority beyond which a job is dropped at dequeue rather than run.
   *
   * Expressed in viewport-heights by the caller. Dropping is not a failure: the post is off
   * screen, and if the user scrolls back it is re-enqueued with a fresh priority.
   */
  dropBeyond?: number
}

export type JobOutcome<T> =
  | { status: 'done'; value: T }
  | { status: 'dropped' }
  | { status: 'replaced' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown }

interface Entry<T> {
  job: Job<T>
  resolve: (outcome: JobOutcome<T>) => void
}

const DEFAULT_MAX_QUEUE = 40
const DEFAULT_DROP_BEYOND = 4

export class InferenceScheduler<T> {
  #queue = new Map<string, Entry<T>>()
  #running: string | null = null
  #stopped = false
  readonly #maxQueue: number
  readonly #dropBeyond: number

  /** Counters for the dashboard, and for telling "nothing happened" apart from "nothing to do". */
  readonly stats = { run: 0, dropped: 0, replaced: 0, failed: 0 }

  constructor(options: SchedulerOptions = {}) {
    this.#maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE
    this.#dropBeyond = options.dropBeyond ?? DEFAULT_DROP_BEYOND
  }

  get queueLength(): number {
    return this.#queue.size
  }

  get isRunning(): boolean {
    return this.#running !== null
  }

  /**
   * Submit a job. Resolves with an outcome rather than rejecting, because "this post scrolled
   * away before we got to it" is an ordinary result, not an error, and callers should not have
   * to wrap every submit in a try.
   */
  submit(job: Job<T>): Promise<JobOutcome<T>> {
    if (this.#stopped) return Promise.resolve({ status: 'cancelled' })

    const existing = this.#queue.get(job.key)
    if (existing) {
      // Same post re-observed — keep the newer job, since its priority closure reads current
      // state. Tell the old caller so it does not wait forever.
      existing.resolve({ status: 'replaced' })
      this.stats.replaced++
      this.#queue.delete(job.key)
    }

    return new Promise<JobOutcome<T>>((resolve) => {
      this.#queue.set(job.key, { job, resolve })
      this.#evictOverflow()
      void this.#pump()
    })
  }

  /** Drop a queued job. A running job is left alone — see the module note on abort. */
  cancel(key: string): boolean {
    const entry = this.#queue.get(key)
    if (!entry) return false
    this.#queue.delete(key)
    entry.resolve({ status: 'cancelled' })
    return true
  }

  /** Drop everything queued. In-flight work is allowed to finish. */
  clear(): void {
    for (const [key, entry] of this.#queue) {
      this.#queue.delete(key)
      entry.resolve({ status: 'cancelled' })
    }
  }

  /** Permanent stop — tab teardown. Further submits resolve `cancelled` immediately. */
  stop(): void {
    this.#stopped = true
    this.clear()
  }

  #evictOverflow(): void {
    if (this.#queue.size <= this.#maxQueue) return
    // Evict the worst-priority entries. Sorting the whole queue is fine at tens of entries and
    // much easier to reason about than maintaining a heap.
    const sorted = [...this.#queue.entries()].sort(
      (a, b) => a[1].job.priority() - b[1].job.priority(),
    )
    for (const [key, entry] of sorted.slice(this.#maxQueue)) {
      this.#queue.delete(key)
      entry.resolve({ status: 'dropped' })
      this.stats.dropped++
    }
  }

  async #pump(): Promise<void> {
    if (this.#running !== null || this.#queue.size === 0) return

    // Re-rank at dequeue: priorities recorded at enqueue are stale by now, because the user has
    // scrolled. This is what makes the queue follow the viewport rather than the scroll history.
    let best: [string, Entry<T>] | null = null
    let bestPriority = Infinity
    for (const entry of this.#queue.entries()) {
      const p = entry[1].job.priority()
      if (p < bestPriority) {
        bestPriority = p
        best = entry
      }
    }
    if (!best) return

    const [key, entry] = best
    this.#queue.delete(key)

    // Scrolled far away while queued. Dropping is free and certain; aborting later is neither.
    if (bestPriority > this.#dropBeyond) {
      entry.resolve({ status: 'dropped' })
      this.stats.dropped++
      void this.#pump()
      return
    }

    this.#running = key
    try {
      const value = await entry.job.run()
      this.stats.run++
      entry.resolve({ status: 'done', value })
    } catch (error) {
      this.stats.failed++
      // Failure resolves rather than rejects. An engine error must not hide a post, and it must
      // not stall the queue either.
      entry.resolve({ status: 'failed', error })
    } finally {
      this.#running = null
      void this.#pump()
    }
  }
}
