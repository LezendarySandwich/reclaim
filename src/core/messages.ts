/**
 * The message contract between extension contexts.
 *
 * The important boundary is `CLASSIFY_BATCH`: nothing upstream of it knows where inference runs.
 * If spikes S1/S2 force the model host to move from the offscreen document to a hidden tab or
 * side panel, only the router changes — see technical-brief.md §2.3.
 */

import type { EngineState, Post, Verdict } from './types'

/** Discriminator for broadcast messages, so contexts ignore traffic meant for others. */
export type MessageTarget = 'background' | 'offscreen'

export type Request =
  /** content script → background → offscreen */
  | { type: 'CLASSIFY_BATCH'; target: 'background'; posts: Post[] }
  /** background → offscreen. Same payload, different hop. */
  | { type: 'OFFSCREEN_CLASSIFY'; target: 'offscreen'; posts: Post[] }
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
