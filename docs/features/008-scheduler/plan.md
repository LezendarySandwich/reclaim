# 008 — Inference scheduler and pipeline

**Status:** done · **Started:** 2026-09-26

## Goal

Backpressure between the feed and the engine, plus the `classify(posts) → verdicts` boundary that
joins triage, engine and verdict logic.

## The problem

A fast scroll through 200 posts must not enqueue 200 model calls. But there is an unmeasured
question underneath: **does `AbortSignal` actually free the Prompt API's inference slot, or only
reject the promise?** If it is cosmetic, aggressive aborting is *slower* than never aborting —
the work still runs and you have paid for a rejection on top.

## Design: correct under either answer

Rather than guess, the scheduler avoids depending on the answer at all.

- **One in-flight job.** Never rely on concurrency we cannot verify. The Prompt API queues prompts
  on a session anyway, so apparent parallelism would be a lie.
- **Drop from the queue; do not abort in flight.** Cancelling a queued job is free and certain.
  Aborting a running one is neither.
- **Re-rank at dequeue, not enqueue.** By the time a slot frees, the user has scrolled and the
  priorities captured at enqueue are stale. Re-reading priority via a closure is what makes the
  queue track the viewport instead of the scroll history.
- **Outcomes resolve, never reject.** "This post scrolled away before we got to it" is an ordinary
  result. An engine failure resolves `failed`, so a broken model cannot stall the queue — and
  cannot hide a post either.

## Pipeline

`classifyBatch` checks the engine-state gate FIRST and short-circuits the whole batch, so a machine
with no working model spends nothing on inference. Heuristic signals are still recorded, so shadow
data stays complete even when nothing can be classified.

`mergeVerdict` re-checks the same rule independently. That duplication is deliberate: this one is
the cheap check, that one is authoritative.

## Acceptance criteria

- [x] Never more than one concurrent inference
- [x] A post that scrolls out of range while queued is dropped unscored
- [x] Re-submitting the same post replaces the queued job, and the old caller is resolved
- [x] An engine failure does not stall the queue and does not hide a post
- [x] Queue is capped; overflow evicts worst-priority first
