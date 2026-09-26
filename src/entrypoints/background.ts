import { browser } from 'wxt/browser'
import { errorResponse, isRequestFor } from '../core/messages'
import type { Response } from '../core/messages'
import { gateState, mayReadPosts } from '../core/consent'
import { hasConsent, loadSettings } from '../storage/settings'
import { InferenceScheduler, classifyBatch } from '../core/pipeline'
import { GeminiNanoEngine } from '../engines/gemini-nano'
import { PROMPT_VERSION } from '../engines/prompt'
import { RULES_VERSION } from '../detect/triage'
import type { Axis, EngineState } from '../core/types'

/**
 * Service worker — router, consent gate, and (later) the Prompt API host.
 *
 * ADR-018 reversed the original plan: `LanguageModel` IS available here. Chromium force-enables
 * `AIPromptAPIForWorkers` for any renderer launched with `--extension-process`, and the
 * user-gesture check is skipped entirely when there is no Window — so this is the privileged
 * context for the Prompt API, and an offscreen document (a Window that can never obtain user
 * activation) is the handicapped one. The offscreen document is kept for WebLLM only.
 *
 * No offscreen document is created yet. ADR-018 retains one for the WebLLM tier, which genuinely
 * needs it (service workers lack WASM/Workers/Atomics) — but WebLLM is deferred (ADR-022), so
 * shipping the permission and the document now would mean an unjustified install warning and a
 * Chrome Web Store reviewer asking a question we have no good answer to. Both come back with the
 * engine that needs them.
 *
 * IndexedDB writes will move to that offscreen document when it returns, because it outlives this
 * worker. Until then the dashboard owns them.
 */

const CONTENT_SCRIPT_ID = 'linkedin-feed'
const LINKEDIN_ORIGIN = 'https://www.linkedin.com/*'
const LINKEDIN_FEED_MATCH = 'https://www.linkedin.com/feed/*'

/**
 * One engine and one scheduler for the whole worker.
 *
 * Module scope, not per-message: backpressure is only meaningful if it spans every tab and every
 * batch, and the engine's base session — the system prompt plus few-shot anchors — is expensive
 * to build.
 *
 * Caveat worth remembering: the service worker is evicted after ~30s idle, so both of these die
 * with it and the next classify pays `create()` again. That cost is unmeasured, and it is the one
 * remaining argument for hosting the model in an offscreen document after all (brief risk A2).
 */
const engine = new GeminiNanoEngine()
const scheduler = new InferenceScheduler<Partial<Record<Axis, number>>>()

let engineState: EngineState = { status: 'uninitialized' }

/** Bring the engine up, mapping every failure onto the fail-open state machine (ADR-005). */
async function loadEngine(): Promise<void> {
  if (engineState.status === 'ready' || engineState.status === 'downloading') return

  engineState = { status: 'checking' }
  try {
    const availability = await engine.availability()

    if (availability === 'unavailable') {
      // Enterprise policy (`GenAILocalFoundationalModelSettings`) and unsupported hardware are
      // indistinguishable from here — both surface as a permanent 'unavailable' — so the reason
      // has to cover both, and the UI copy has to name both.
      engineState = { status: 'degraded', reason: 'unsupported_hardware_or_policy' }
      return
    }
    if (availability === 'downloadable') {
      // Stop here deliberately. The worker could start a multi-gigabyte download with no user
      // gesture, and that is exactly why it must not — see ADR-018.
      engineState = { status: 'needs_setup' }
      return
    }

    engineState = { status: 'downloading', fraction: 0 }
    await engine.load((p) => {
      engineState = { status: 'downloading', fraction: p.fraction }
    })
    engineState = { status: 'ready', engineId: engine.id }
  } catch (e) {
    engineState = {
      status: 'degraded',
      reason: 'engine_error',
      detail: e instanceof Error ? e.message : String(e),
    }
  }
}

async function hasHostPermission(): Promise<boolean> {
  return browser.permissions.contains({ origins: [LINKEDIN_ORIGIN] })
}

/**
 * Bring the registered content script in line with the gate.
 *
 * Reconciles rather than blindly registering: MV3 runtime registrations persist across browser
 * restarts, so calling `registerContentScripts` again on startup throws a duplicate-id error.
 * Idempotent by construction — safe to call from any event.
 */
async function reconcileContentScript(): Promise<void> {
  const state = gateState({
    hasConsent: await hasConsent(),
    hasHostPermission: await hasHostPermission(),
  })

  const registered = await browser.scripting.getRegisteredContentScripts({
    ids: [CONTENT_SCRIPT_ID],
  })
  const isRegistered = registered.length > 0

  if (mayReadPosts(state)) {
    if (isRegistered) return
    await browser.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        matches: [LINKEDIN_FEED_MATCH],
        js: ['content-scripts/linkedin.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ])
    return
  }

  if (isRegistered) {
    await browser.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] })
  }
}

export default defineBackground(() => {
  // Reconcile on every lifecycle event that could change either condition. Cheap, and much more
  // reliable than trying to enumerate the ways consent or a permission can change.
  browser.runtime.onInstalled.addListener(() => void reconcileContentScript())
  browser.runtime.onStartup.addListener(() => void reconcileContentScript())
  browser.permissions.onAdded.addListener(() => void reconcileContentScript())
  browser.permissions.onRemoved.addListener(() => void reconcileContentScript())
  void reconcileContentScript()

  // Probe the engine on wake. Never starts a download on its own — `loadEngine` stops at
  // `needs_setup` when the model is merely downloadable, so the multi-gigabyte fetch stays
  // behind an explicit click on an extension page.
  void loadEngine()

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isRequestFor(msg, 'background')) return false

    void (async () => {
      let response: Response
      try {
        switch (msg.type) {
          case 'CLASSIFY_BATCH': {
            // Defence in depth. The content script should not be running at all without consent,
            // but a stale registration or a racing revoke must not result in a classification.
            const gate = gateState({
              hasConsent: await hasConsent(),
              hasHostPermission: await hasHostPermission(),
            })
            if (!mayReadPosts(gate)) {
              response = errorResponse(new Error(`Consent gate is ${gate.status}`))
              break
            }

            const classified = await classifyBatch(msg.posts, {
              engine,
              settings: await loadSettings(),
              engineState,
              rulesVersion: `${RULES_VERSION}+${PROMPT_VERSION}`,
              // One scheduler for the whole worker, not one per batch: backpressure is only
              // meaningful if it spans every tab and every message.
              scheduler,
            })

            response = { ok: true, type: 'CLASSIFY_BATCH', verdicts: classified.map((c) => c.verdict) }
            break
          }
          case 'GET_ENGINE_STATE': {
            const gate = gateState({
              hasConsent: await hasConsent(),
              hasHostPermission: await hasHostPermission(),
            })
            response = {
              ok: true,
              type: 'GET_ENGINE_STATE',
              state: mayReadPosts(gate) ? engineState : { status: 'uninitialized' },
            }
            break
          }
          case 'INSTALL_MODEL': {
            // Reachable only from an extension page, because `create()` needs a transient user
            // gesture when the model is not yet present. The service worker is technically
            // exempt (no Window), but a multi-gigabyte download deserves an explicit click —
            // see ADR-018.
            await loadEngine()
            response = engineState.status === 'ready'
              ? { ok: true, type: 'INSTALL_MODEL' }
              : errorResponse(new Error(`Engine is ${engineState.status}`))
            break
          }
        }
      } catch (e) {
        response = errorResponse(e)
      }
      sendResponse(response)
    })()

    // MUST be a literal `true`. Promise-returning onMessage is Chrome 148+ and our floor is 138.
    return true
  })
})
