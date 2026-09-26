/**
 * The message contract between extension contexts.
 *
 * The important boundary is `CLASSIFY_BATCH`: nothing upstream of it knows where inference runs.
 * If spikes S1/S2 force the model host to move from the offscreen document to a hidden tab or
 * side panel, only the router changes — see technical-brief.md §2.3.
 */

import type { Axis, EngineState, Post, TriageBand, Verdict } from './types'

/**
 * A post plus what the in-tab triage router already worked out about it.
 *
 * The heuristic scores travel with the post so they can be RECORDED alongside the model's
 * verdict — the dashboard shows both, and comparing them over time is how the router eventually
 * gets calibrated. They are recorded, never acted on: heuristics route, they do not judge
 * (ADR-004), and `mergeVerdict` enforces that independently.
 */
export interface TriagedPost {
  post: Post
  /**
   * Screen-heights from the viewport at the moment the batch was sent.
   *
   * A snapshot, not live — the content script cannot measure layout from the service worker.
   * Good enough to order a batch sensibly; the scheduler's re-ranking does the rest.
   */
  distance?: number
  heuristics: Partial<Record<Axis, number>>
  /**
   * This post was routed `clean` and is being sent to the model ANYWAY, purely to measure how
   * often the router is wrong.
   *
   * Posts the router clears never reach the model, so its one costly error — waving real slop
   * through — leaves no trace and cannot be counted. Sampling a small share of them converts
   * that structural blind spot into an estimate.
   *
   * An audit sample MUST NEVER hide a post. It is measurement, not enforcement: the user already
   * had this post shown to them, and retroactively collapsing it because a sampling die came up
   * differently would be indefensible.
   */
  audit?: boolean
  /**
   * What the router decided. Recorded so the dashboard can show router-vs-model agreement, which
   * is the only honest version of "what detected this" — heuristics never hide, so a
   * detector breakdown would read 100% model and say nothing.
   */
  band: TriageBand
}

/** Discriminator for broadcast messages, so contexts ignore traffic meant for others. */
export type MessageTarget = 'background' | 'offscreen'

export type Request =
  /** content script → background → offscreen */
  | { type: 'CLASSIFY_BATCH'; target: 'background'; posts: TriagedPost[] }
  /** background → offscreen. Same payload, different hop. */
  | { type: 'OFFSCREEN_CLASSIFY'; target: 'offscreen'; posts: TriagedPost[] }
  /** any context → background */
  | { type: 'GET_ENGINE_STATE'; target: 'background' }
  /** dashboard → background. Must originate from a user gesture on an extension page: the Prompt
   *  API rejects create() without one when the model is not already present. */
  | { type: 'INSTALL_MODEL'; target: 'background'; engineId: string }

export type Response =
  | { ok: true; type: 'CLASSIFY_BATCH'; verdicts: Verdict[] }
  | { ok: true; type: 'GET_ENGINE_STATE'; state: EngineState }
  | { ok: true; type: 'INSTALL_MODEL' }
  | { ok: false; error: string }

/** Pushed from background to any listening context when the engine state changes. */
export interface EngineStateChanged {
  type: 'ENGINE_STATE_CHANGED'
  state: EngineState
}

export function isRequestFor<T extends MessageTarget>(
  msg: unknown,
  target: T,
): msg is Extract<Request, { target: T }> {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'target' in msg &&
    (msg as { target: unknown }).target === target
  )
}

export function errorResponse(e: unknown): Response {
  const name = e instanceof Error ? e.name : 'Error'
  const message = e instanceof Error ? e.message : String(e)
  return { ok: false, error: `${name}: ${message}` }
}
