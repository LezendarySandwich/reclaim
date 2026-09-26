# 007 — Model engine

**Status:** Gemini Nano done · WebLLM deferred · **Started:** 2026-09-26

## Goal

`ModelEngine` seam plus a working Gemini Nano implementation, so the pipeline can produce real
verdicts.

## Where it runs, and why that reversed

ADR-018. The Prompt API **is** available in MV3 service workers — Chromium force-enables
`AIPromptAPIForWorkers` for any renderer with `--extension-process` — and the user-gesture check
is skipped when there is no Window. An offscreen document is a Window that can *never* obtain user
activation, so it can never `create()` while availability is `"downloadable"`.

So: Prompt API in the service worker, offscreen document reserved for WebLLM (which genuinely
needs it — service workers lack WASM/Workers/Atomics). Two hosts, one `classify()` boundary.

## The two design decisions worth defending

**Clone per post, destroy in a `finally`.** Prompts on a single session are queued rather than
concurrent, and a shared session accumulates turns until context overflow *silently* evicts the
oldest ones — which are the few-shot anchors doing the calibration. Nothing errors; the classifier
just quietly gets worse. Cloning means no state ever accumulates.

**A six-rung ladder, not a 0-100 score.** Sub-2B models are badly calibrated and will emit round
numbers clustered at 70/80/90 that mean nothing. The model picks from anchored rungs (`none` …
`blatant`) and *we* map rungs to numbers. Model does the fit; we do the calibration.

## Prompt design

Scores the **register, not the author** (ADR-019). It never asks "was this written by AI" — that
is a provenance claim the model cannot support and we will not make. Explicit instructions that
non-idiomatic English is not templated, and that concrete writing is not templated even when plain.

`responseConstraint` with `omitResponseConstraintInput: true` — the schema is otherwise injected
as literal prompt text and charged against the context window.

A malformed response yields **no signal**, never a guessed score. No signal fails open.

## Non-goals

- WebLLM. Blocked on an unresolved question (no offscreen example exists in the repo) and on
  vendoring its WASM to satisfy the remote-code rule. ADR-022.
- The scheduler — admission control, batching, cancellation. That is 008.

## Acceptance criteria

- [x] `availability()` never throws; enterprise policy and unsupported hardware both fail safe
- [x] One base session, created once, even under concurrent callers
- [x] Clone per post; every clone destroyed, including on throw
- [x] Malformed response produces no signal rather than a guess
- [x] Greedy decoding, so a post's verdict is reproducible
