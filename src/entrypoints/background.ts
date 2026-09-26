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

function toDegraded(e: unknown): EngineState {
  return {
    status: 'degraded',
    reason: 'engine_error',
    detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
  }
}

/**
 * PASSIVE probe. Reports what this device can do; never downloads anything.
 *
 * Called on every worker wake. Stops at `needs_setup` when the model is merely downloadable —
 * the worker *could* start a 4.27 GB fetch with no user gesture (ADR-018), which is exactly why
 * it must not do so on its own.
 */
async function probeEngine(): Promise<void> {
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
    if (availability === 'downloadable' || availability === 'downloading') {
      engineState = { status: 'needs_setup' }
      return
    }

    // Already present. Building the session is fast and involves no download.
    await engine.load()
    engineState = { status: 'ready', engineId: engine.id }
  } catch (e) {
    engineState = toDegraded(e)
  }
}

/**
 * ACTIVE install. This is the one that actually downloads.
 *
 * Separate from `probeEngine` because conflating them was a real bug: the install button called
 * the probe, which saw `downloadable`, set `needs_setup` and returned without ever starting the
 * download. The UI then showed one render and no progress, because nothing was happening.
 *
 * Deliberately NOT awaited by its caller — a 4.27 GB download inside a message handler would
 * leave the response pending for minutes. The dashboard polls `GET_ENGINE_STATE` for progress.
 */
async function installEngine(): Promise<void> {
  if (engineState.status === 'ready' || engineState.status === 'downloading') return

  engineState = { status: 'downloading', fraction: 0 }
  try {
    await engine.load((p) => {
      engineState = { status: 'downloading', fraction: p.fraction }
    })
    engineState = { status: 'ready', engineId: engine.id }
  } catch (e) {
    engineState = toDegraded(e)
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

  // Passive probe on wake. Never downloads — that is `installEngine`, behind an explicit click.
  void probeEngine()

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
            // Fire and forget, and note it calls installEngine rather than probeEngine. The
            // first version awaited the PROBE here, which sees `downloadable` and returns
            // without downloading — so the button did nothing at all. Awaiting the real download
            // would be no better: the response would not arrive for minutes. Kick it off and
            // return; the dashboard polls GET_ENGINE_STATE for progress.
            void installEngine()
            response = { ok: true, type: 'INSTALL_MODEL' }
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
