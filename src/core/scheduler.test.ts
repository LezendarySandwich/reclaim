import { describe, expect, it, vi } from 'vitest'
import { InferenceScheduler } from './scheduler'

/** A job whose priority the test can move, to simulate the user scrolling. */
function movable(key: string, initial: number, run: () => Promise<string>) {
  const box = { p: initial }
  return { job: { key, priority: () => box.p, run }, box }
}

const resolved = (value: string) => () => Promise.resolve(value)

describe('serialisation', () => {
  it('runs one job at a time', async () => {
    const scheduler = new InferenceScheduler<string>()
    let concurrent = 0
    let peak = 0
    const slow = () => async () => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await new Promise((r) => setTimeout(r, 5))
      concurrent--
      return 'ok'
    }
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        scheduler.submit({ key: `k${i}`, priority: () => i, run: slow() }),
      ),
    )
    expect(peak).toBe(1)
  })

  it('eventually drains the whole queue', async () => {
    const scheduler = new InferenceScheduler<string>()
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        scheduler.submit({ key: `k${i}`, priority: () => 0, run: resolved(`v${i}`) }),
      ),
    )
    expect(results.every((r) => r.status === 'done')).toBe(true)
    expect(scheduler.queueLength).toBe(0)
  })
})

describe('priority is re-read at dequeue, not enqueue', () => {
  it('runs whichever job is nearest the viewport WHEN a slot frees', async () => {
    // The point of the whole design: by the time a slot frees, the user has scrolled and the
    // priorities captured at enqueue time are stale.
    const scheduler = new InferenceScheduler<string>()
    const order: string[] = []
    const track = (name: string) => async () => {
      order.push(name)
      return name
    }

    const blocker = movable('blocker', 0, async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push('blocker')
      return 'blocker'
    })
    const far = movable('far', 3, track('far'))
    const near = movable('near', 1, track('near'))

    const all = [
      scheduler.submit(blocker.job),
      scheduler.submit(far.job),
      scheduler.submit(near.job),
    ]

    // While the first job runs, the user scrolls: 'far' is now the closest post.
    far.box.p = 0.1
    near.box.p = 2

    await Promise.all(all)
    expect(order).toEqual(['blocker', 'far', 'near'])
  })
})

describe('dropping rather than aborting', () => {
  it('drops a job that scrolled out of range while queued', async () => {
    const scheduler = new InferenceScheduler<string>({ dropBeyond: 4 })
    const run = vi.fn(resolved('should not run'))

    const blocker = scheduler.submit({
      key: 'blocker',
      priority: () => 0,
      run: async () => {
        await new Promise((r) => setTimeout(r, 10))
        return 'blocker'
      },
    })
    const target = movable('target', 1, run)
    const pending = scheduler.submit(target.job)

    target.box.p = 50 // user scrolled far past it

    const [, outcome] = await Promise.all([blocker, pending])
    expect(outcome.status).toBe('dropped')
    expect(run).not.toHaveBeenCalled()
    expect(scheduler.stats.dropped).toBe(1)
  })

  it('still runs a job that is merely off-screen but within range', async () => {
    const scheduler = new InferenceScheduler<string>({ dropBeyond: 4 })
    const outcome = await scheduler.submit({ key: 'k', priority: () => 3, run: resolved('v') })
    expect(outcome).toEqual({ status: 'done', value: 'v' })
  })
})

describe('deduplication', () => {
  it('replaces an earlier job with the same key', async () => {
    const scheduler = new InferenceScheduler<string>()
    const first = vi.fn(resolved('first'))

    const blocker = scheduler.submit({
      key: 'blocker',
      priority: () => 0,
      run: async () => {
        await new Promise((r) => setTimeout(r, 10))
        return 'b'
      },
    })
    const a = scheduler.submit({ key: 'same', priority: () => 1, run: first })
    const b = scheduler.submit({ key: 'same', priority: () => 1, run: resolved('second') })

    const [, outA, outB] = await Promise.all([blocker, a, b])
    expect(outA.status).toBe('replaced')
    expect(outB).toEqual({ status: 'done', value: 'second' })
    expect(first).not.toHaveBeenCalled()
  })

  it('never leaves a replaced caller awaiting forever', async () => {
    const scheduler = new InferenceScheduler<string>()
    const a = scheduler.submit({ key: 'x', priority: () => 5, run: resolved('a') })
    const b = scheduler.submit({ key: 'x', priority: () => 5, run: resolved('b') })
    await expect(Promise.all([a, b])).resolves.toHaveLength(2)
  })
})

describe('overflow', () => {
  it('caps the queue and evicts the worst priorities', async () => {
    const scheduler = new InferenceScheduler<string>({ maxQueue: 3, dropBeyond: 1000 })
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        scheduler.submit({ key: `k${i}`, priority: () => 100 - i, run: resolved(`v${i}`) }),
      ),
    )
    const dropped = outcomes.filter((o) => o.status === 'dropped').length
    expect(dropped).toBeGreaterThan(0)
    // The best priorities (highest i, lowest value) must survive.
    expect(outcomes[9]!.status).toBe('done')
  })
})

describe('failure handling', () => {
  it('resolves failed rather than rejecting, so an engine error cannot hide a post', async () => {
    const scheduler = new InferenceScheduler<string>()
    const outcome = await scheduler.submit({
      key: 'k',
      priority: () => 0,
      run: () => Promise.reject(new Error('engine exploded')),
    })
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect((outcome.error as Error).message).toBe('engine exploded')
    }
  })

  it('keeps draining after a failure', async () => {
    const scheduler = new InferenceScheduler<string>()
    const bad = scheduler.submit({
      key: 'bad',
      priority: () => 0,
      run: () => Promise.reject(new Error('x')),
    })
    const good = scheduler.submit({ key: 'good', priority: () => 1, run: resolved('ok') })
    const [, g] = await Promise.all([bad, good])
    expect(g).toEqual({ status: 'done', value: 'ok' })
    expect(scheduler.isRunning).toBe(false)
  })
})

describe('cancellation', () => {
  it('cancels a queued job', async () => {
    const scheduler = new InferenceScheduler<string>()
    const blocker = scheduler.submit({
      key: 'blocker',
      priority: () => 0,
      run: async () => {
        await new Promise((r) => setTimeout(r, 10))
        return 'b'
      },
    })
    const pending = scheduler.submit({ key: 'victim', priority: () => 1, run: resolved('v') })
    expect(scheduler.cancel('victim')).toBe(true)
    const [, outcome] = await Promise.all([blocker, pending])
    expect(outcome.status).toBe('cancelled')
  })

  it('returns false for an unknown key', () => {
    expect(new InferenceScheduler<string>().cancel('nope')).toBe(false)
  })

  it('clear() drains the queue but lets in-flight work finish', async () => {
    const scheduler = new InferenceScheduler<string>()
    const blocker = scheduler.submit({
      key: 'blocker',
      priority: () => 0,
      run: async () => {
        await new Promise((r) => setTimeout(r, 10))
        return 'finished'
      },
    })
    const queued = scheduler.submit({ key: 'q', priority: () => 1, run: resolved('q') })
    scheduler.clear()
    const [b, q] = await Promise.all([blocker, queued])
    expect(b).toEqual({ status: 'done', value: 'finished' })
    expect(q.status).toBe('cancelled')
  })

  it('stop() makes further submits resolve cancelled immediately', async () => {
    const scheduler = new InferenceScheduler<string>()
    scheduler.stop()
    const run = vi.fn(resolved('v'))
    expect(await scheduler.submit({ key: 'k', priority: () => 0, run })).toEqual({
      status: 'cancelled',
    })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('stats', () => {
  it('counts outcomes for the dashboard', async () => {
    const scheduler = new InferenceScheduler<string>()
    await scheduler.submit({ key: 'a', priority: () => 0, run: resolved('a') })
    await scheduler.submit({
      key: 'b',
      priority: () => 0,
      run: () => Promise.reject(new Error('x')),
    })
    expect(scheduler.stats.run).toBe(1)
    expect(scheduler.stats.failed).toBe(1)
  })
})
